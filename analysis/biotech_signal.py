#!/usr/bin/env python3
"""
biotech_signal.py — does prediction-market odds on FDA catalysts predict the
biotech stock's move?  (idea: prediction markets -> biotech stock fluctuations)

Pipeline (all PUBLIC data, no auth):
  1. Polymarket public-search -> resolved FDA-approval catalyst markets
  2. map drug/company -> public ticker (TICK below)
  3. Polymarket CLOB prices-history -> the market's PRE-decision probability
  4. Yahoo Finance chart API -> stock + XBI prices around the catalyst
  5. metrics: market accuracy/Brier, stock directional accuracy, and the core
     test: corr(surprise = outcome - odds, XBI-adjusted stock return)

Run:  python3 analysis/biotech_signal.py   (writes data/biotech_backtest.json)
"""
import json, subprocess, urllib.parse, time, datetime, math, os

def curl(u):
    return subprocess.run(["curl", "-s", "--max-time", "30", "-A", "Mozilla/5.0", u],
                          capture_output=True, text=True).stdout
def iso_ts(s): return datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()

# drug / company keyword -> ticker (single-asset small/mid caps prioritized)
TICK = {
    "celcuity": "CELC", "viridian": "VRDN", "ionis": "IONS", "ux111": "RARE", "ultragenyx": "RARE",
    "precigen": "PGEN", "capricor": "CAPR", "cingulate": "CING", "vepdegestrant": "ARVN", "arvinas": "ARVN",
    "argenx": "ARGX", "truqap": "AZN", "mannkind": "MNKD", "outlook": "OTLK", "daraxonrasib": "RVMD",
    "revolution medicines": "RVMD", "dordaviprone": "CMRX", "chimerix": "CMRX",
}
QUERIES = ["FDA approves", "FDA approval", "drug approval", "biotech", "cancer drug", "Alzheimer", "vaccine approval", "PDUFA"]

def gather_catalysts():
    seen = {}
    for q in QUERIES:
        d = curl("https://gamma-api.polymarket.com/public-search?q=" + urllib.parse.quote(q) + "&limit_per_type=40")
        try: d = json.loads(d)
        except: continue
        for e in (d.get("events") or []): seen[e.get("slug")] = e
        time.sleep(0.4)
    cats = []
    for e in seen.values():
        t = (e.get("title") or "").lower()
        if "approv" not in t or not e.get("closed"): continue
        tk = next((v for k, v in TICK.items() if k in t), None)
        if not tk: continue
        ev = curl("https://gamma-api.polymarket.com/events?slug=" + e.get("slug"))
        try: ev = json.loads(ev)
        except: ev = []
        if not ev: continue
        m = (ev[0].get("markets") or [{}])[0]
        toks = json.loads(m.get("clobTokenIds") or "[]")
        op = json.loads(m.get("outcomePrices") or "[]")
        if not toks or not op: continue
        cats.append({"ticker": tk, "title": e.get("title"), "slug": e.get("slug"), "yesToken": toks[0],
                     "endDate": e.get("endDate"), "resolvedYes": 1 if str(op[0]) in ("1", "1.0") else 0})
        time.sleep(0.4)
    uniq = {}
    for c in cats: uniq[(c["ticker"], str(c["endDate"])[:10])] = c
    return list(uniq.values())

def pre_odds(token, endts):
    for _ in range(4):
        r = curl(f"https://clob.polymarket.com/prices-history?market={token}&interval=max&fidelity=720")
        try: h = json.loads(r).get("history", [])
        except: h = []
        if h: break
        time.sleep(2)
    else:
        return None, 0
    pre = [p for p in h if p["t"] <= endts - 43200] or [p for p in h if 0.02 < p["p"] < 0.98] or h
    return (pre[-1]["p"] if pre else None), len(h)

def yahoo(sym, endts):
    p1, p2 = int(endts - 30 * 86400), int(endts + 18 * 86400)
    d = curl(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?period1={p1}&period2={p2}&interval=1d")
    try:
        r = json.loads(d)["chart"]["result"][0]
        return [(datetime.datetime.utcfromtimestamp(t).date(), c)
                for t, c in zip(r["timestamp"], r["indicators"]["quote"][0]["close"]) if c is not None]
    except: return []

def window_ret(rows, enddate):
    if not rows: return None
    dates = [r[0] for r in rows]; closes = [r[1] for r in rows]
    di = next((i for i, d in enumerate(dates) if d >= enddate), None)
    if di is None: return None
    lo, hi = max(0, di - 1), min(len(dates) - 1, di + 1)
    if hi <= lo or closes[lo] == 0: return None
    return closes[hi] / closes[lo] - 1

def main():
    today = datetime.date.today()
    cats = gather_catalysts()
    for c in cats:
        endts = iso_ts(c["endDate"]); ed = datetime.date.fromisoformat(str(c["endDate"])[:10])
        c["pPre"], c["nPts"] = pre_odds(c["yesToken"], endts)
        time.sleep(0.8)
        if ed > today: c["skip"] = "future"; c["abn"] = None; continue
        sr = window_ret(yahoo(c["ticker"], endts), ed); xr = window_ret(yahoo("XBI", endts), ed)
        c["stockRet"], c["xbiRet"] = sr, xr
        c["abn"] = (sr - xr) if (sr is not None and xr is not None) else None
        if c["abn"] is None: c["skip"] = "no_stock_data"

    use = [c for c in cats if c.get("pPre") is not None and c.get("abn") is not None]
    n = len(use); ap = [c for c in use if c["resolvedYes"]]; rj = [c for c in use if not c["resolvedYes"]]
    acc = sum((c["pPre"] > 0.5) == bool(c["resolvedYes"]) for c in use) / n
    brier = sum((c["pPre"] - c["resolvedYes"]) ** 2 for c in use) / n
    diracc = sum((c["abn"] > 0) == bool(c["resolvedYes"]) for c in use) / n
    sur = [c["resolvedYes"] - c["pPre"] for c in use]; ab = [c["abn"] for c in use]
    ms, ma = sum(sur) / n, sum(ab) / n
    cov = sum((s - ms) * (a - ma) for s, a in zip(sur, ab)) / n
    sds = math.sqrt(sum((s - ms) ** 2 for s in sur) / n); sda = math.sqrt(sum((a - ma) ** 2 for a in ab) / n)
    corr = cov / (sds * sda) if sds * sda > 0 else float("nan")
    metrics = {"asOf": str(today), "n": n, "nApproved": len(ap), "nRejected": len(rj),
               "marketAccuracy": round(acc, 3), "brier": round(brier, 3),
               "stockDirAccuracy": round(diracc, 3), "surpriseCorr": round(corr, 3)}
    out = {"metrics": metrics, "catalysts": sorted(use, key=lambda x: x["ticker"])}
    os.makedirs("data", exist_ok=True)
    json.dump(out, open("data/biotech_backtest.json", "w"), indent=2)
    print(json.dumps(metrics, indent=2))

if __name__ == "__main__":
    main()

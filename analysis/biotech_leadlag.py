#!/usr/bin/env python3
"""
biotech_leadlag.py — does the (high-volume) STOCK lead the (thin) prediction
market, or vice versa?  Runs the event study in BOTH directions.

Method: over each catalyst's pre-decision run-up, align DAILY stock abnormal
returns (XBI-adjusted) with DAILY prediction-market odds changes, z-score per
catalyst, pool, and compute the cross-correlation:
    CCF(k) = corr( stock_t , dOdds_{t+k} )
    k>0 -> stock leads odds ;  k<0 -> market leads stock ;  k=0 -> same day
Also reports next-day directional accuracy each way.

Caveat: DAILY resolution only. If the stock leads the thin market intraday
(hours), that shows up here as same-day coupling and cannot be separated —
testing that needs historical intraday data, unavailable for these old dates.

Run:  python3 analysis/biotech_leadlag.py   (writes data/biotech_leadlag.json)
"""
import json, subprocess, datetime, math, time, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from biotech_signal import gather_catalysts, curl, iso_ts  # reuse catalyst discovery

def odds_daily(token):
    h = []
    for _ in range(6):
        r = curl(f"https://clob.polymarket.com/prices-history?market={token}&interval=max&fidelity=720")
        try: h = json.loads(r).get("history", [])
        except: h = []
        if h: break
        time.sleep(3)
    daily = {}
    for pt in h:  # ascending -> last of each UTC day wins
        daily[datetime.datetime.utcfromtimestamp(pt["t"]).date()] = pt["p"]
    return daily

def yahoo(sym, endts):
    p1, p2 = int(endts - 45 * 86400), int(endts + 5 * 86400)
    d = curl(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?period1={p1}&period2={p2}&interval=1d")
    try:
        r = json.loads(d)["chart"]["result"][0]
        return [(datetime.datetime.utcfromtimestamp(t).date(), c)
                for t, c in zip(r["timestamp"], r["indicators"]["quote"][0]["close"]) if c]
    except: return []

def zscore(xs):
    n = len(xs); m = sum(xs) / n; sd = math.sqrt(sum((x - m) ** 2 for x in xs) / n)
    return [(x - m) / sd for x in xs] if sd > 0 else None

def build_series(cats):
    today = datetime.date.today(); series = []
    for c in cats:
        endts = iso_ts(c["endDate"]); catdate = datetime.date.fromisoformat(str(c["endDate"])[:10])
        if catdate > today: continue
        od = odds_daily(c["yesToken"]); time.sleep(1.3)
        if not od: continue
        od_sorted = sorted(od.items())
        def odds_asof(day):
            v = None
            for d, p in od_sorted:
                if d <= day: v = p
                else: break
            return v
        st = yahoo(c["ticker"], endts); xb = yahoo("XBI", endts)
        if not st or not xb: continue
        xbmap = {d: cl for d, cl in xb}
        rows = []; pc = px = po = None
        for d, cl in st:
            if d >= catdate: break              # pre-catalyst run-up only
            o = odds_asof(d)
            if pc and po is not None and o is not None and px and d in xbmap:
                abn = (cl / pc - 1) - (xbmap[d] / px - 1)
                rows.append((abn, o - po))
            pc = cl; px = xbmap.get(d, px); po = o
        if len(rows) >= 3: series.append((c["ticker"], rows))
    return series

def ccf(series, k):
    xs, ys = [], []
    for _tk, rows in series:
        abz = zscore([r[0] for r in rows]); doz = zscore([r[1] for r in rows])
        if not abz or not doz: continue
        for i in range(len(rows)):
            j = i + k
            if 0 <= j < len(rows): xs.append(abz[i]); ys.append(doz[j])
    n = len(xs)
    if n < 3: return (float("nan"), n)
    mx = sum(xs) / n; my = sum(ys) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(xs, ys)) / n
    sx = math.sqrt(sum((a - mx) ** 2 for a in xs) / n); sy = math.sqrt(sum((b - my) ** 2 for b in ys) / n)
    return (cov / (sx * sy) if sx * sy > 0 else float("nan"), n)

def diracc(series, k):
    m = t = 0
    for _tk, rows in series:
        for i in range(len(rows)):
            j = i + k
            if 0 <= j < len(rows):
                a, b = rows[i][0], rows[j][1]
                if a != 0 and b != 0: t += 1; m += (a > 0) == (b > 0)
    return (m / t if t else float("nan"), t)

def main():
    series = build_series(gather_catalysts())
    ncat = len(series); nobs = sum(len(r) for _t, r in series)
    ccfs = {str(k): round(ccf(series, k)[0], 3) for k in (-2, -1, 0, 1, 2)}
    r_sm, _ = ccf(series, 1);  d_sm, n_sm = diracc(series, 1)   # stock -> next-day odds
    r_ms, _ = ccf(series, -1); d_ms, n_ms = diracc(series, -1)  # odds -> next-day stock
    out = {"asOf": str(datetime.date.today()), "nCatalysts": ncat, "nDailyObs": nobs, "ccf": ccfs,
           "sameDayCorr": round(ccf(series, 0)[0], 3),
           "stockToMarket": {"corr": round(r_sm, 3), "dirAcc": round(d_sm, 3), "n": n_sm},
           "marketToStock": {"corr": round(r_ms, 3), "dirAcc": round(d_ms, 3), "n": n_ms}}
    os.makedirs("data", exist_ok=True)
    json.dump(out, open("data/biotech_leadlag.json", "w"), indent=2)
    print(json.dumps(out, indent=2))

if __name__ == "__main__":
    main()

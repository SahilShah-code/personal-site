#!/usr/bin/env node
/**
 * fetch-kalshi.mjs
 * -----------------------------------------------------------------------------
 * Pulls your Kalshi portfolio, computes PERCENTAGE-ONLY returns (no dollar
 * amounts, no position sizes), and writes data/kalshi.json for the website.
 *
 * Runs in CI (GitHub Actions) with your credentials supplied as env vars /
 * secrets — they never touch the browser or the committed JSON.
 *
 *   Required env:
 *     KALSHI_API_KEY_ID     your Kalshi API key id (a UUID)
 *     KALSHI_PRIVATE_KEY    the RSA private key (PEM), incl. BEGIN/END lines
 *
 * Run locally:  KALSHI_API_KEY_ID=... KALSHI_PRIVATE_KEY="$(cat key.pem)" \
 *                 node scripts/fetch-kalshi.mjs
 *
 * NOTE ON FIELD NAMES: Kalshi occasionally tweaks response fields. This script
 * uses the documented Trade API v2 shapes. On your first successful run, set
 * DEBUG=1 to dump raw responses to data/_debug/ so you can confirm the mapping
 * matches your account, then tweak the small mapping section if needed.
 * -----------------------------------------------------------------------------
 */

import crypto from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const BASE = "https://api.elections.kalshi.com";
const API = "/trade-api/v2";
const KEY_ID = process.env.KALSHI_API_KEY_ID;
const PRIV = process.env.KALSHI_PRIVATE_KEY;
const DEBUG = process.env.DEBUG === "1";

if (!KEY_ID || !PRIV) {
  console.error("Missing KALSHI_API_KEY_ID or KALSHI_PRIVATE_KEY env vars.");
  process.exit(1);
}

/* ----------------------------------------------------------------------------
 * Signed request helper (Kalshi API-key auth: RSA-PSS over ts+method+path)
 * -------------------------------------------------------------------------- */
function sign(timestamp, method, requestPath) {
  const msg = `${timestamp}${method}${requestPath}`;
  const signature = crypto.sign("sha256", Buffer.from(msg), {
    key: crypto.createPrivateKey(PRIV),
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return signature.toString("base64");
}

async function kget(endpoint, params = {}) {
  // NOTE: the signature is over the PATH ONLY (no query string).
  const fullPath = API + endpoint;
  const ts = Date.now().toString();
  const url = new URL(BASE + fullPath);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: {
      "KALSHI-ACCESS-KEY": KEY_ID,
      "KALSHI-ACCESS-SIGNATURE": sign(ts, "GET", fullPath),
      "KALSHI-ACCESS-TIMESTAMP": ts,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${endpoint} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Follow Kalshi cursor pagination and concatenate an array field.
async function kgetAll(endpoint, arrayKey, params = {}) {
  let cursor, out = [];
  do {
    const page = await kget(endpoint, { ...params, limit: 200, cursor });
    out = out.concat(page[arrayKey] || []);
    cursor = page.cursor || undefined;
  } while (cursor);
  return out;
}

/* ----------------------------------------------------------------------------
 * Cost basis from fills (used to turn P&L into % returns)
 * -------------------------------------------------------------------------- */
const round1 = (n) => Math.round(n * 10) / 10;

// Kalshi reports money two ways: integer CENTS in bare fields (e.g. `revenue`)
// and DOLLAR strings in `*_dollars` fields (e.g. "yes_total_cost_dollars":
// "9.407000"). These normalize everything to DOLLARS.
const strDollars = (v) => (v == null ? 0 : parseFloat(v) || 0);
const centsToDollars = (v) =>
  v == null ? 0 : (typeof v === "number" ? v / 100 : (parseFloat(v) || 0) / 100);
// Prefer "<base>_dollars" (string, dollars); fall back to bare "<base>" (cents).
const moneyDollars = (obj, base) =>
  obj[base + "_dollars"] != null ? strDollars(obj[base + "_dollars"])
  : obj[base] != null ? (typeof obj[base] === "number" ? obj[base] / 100 : strDollars(obj[base]))
  : 0;

// How many settled markets to show in the "historicals" list (aggregates still
// use ALL of them). Kept modest so the page stays readable and title lookups
// stay light.
const DISPLAY_SETTLED = 20;

/* ----------------------------------------------------------------------------
 * Main
 * -------------------------------------------------------------------------- */
async function main() {
  // positions defaults to OPEN positions only. settlement_status=all returns
  // every market ever traded (open + closed + settled), each carrying Kalshi's
  // own realized_pnl — which includes profit taken by SELLING early, not just
  // held-to-settlement outcomes. Paginate to be safe.
  async function pagePositions(status) {
    let cursor, mkt = [], evt = [];
    do {
      const p = await kget("/portfolio/positions", { settlement_status: status, limit: 500, cursor });
      mkt = mkt.concat(p.market_positions || []);
      evt = evt.concat(p.event_positions || []);
      cursor = p.cursor || undefined;
    } while (cursor);
    return { market_positions: mkt, event_positions: evt };
  }

  const [allPositions, settlementsResp, fills] = await Promise.all([
    pagePositions("all"),
    kget("/portfolio/settlements"),
    kgetAll("/portfolio/fills", "fills"),
  ]);

  if (DEBUG) {
    await mkdir("data/_debug", { recursive: true });
    await writeFile("data/_debug/positions_all.json", JSON.stringify(allPositions, null, 2));
    await writeFile("data/_debug/settlements.json", JSON.stringify(settlementsResp, null, 2));
    await writeFile("data/_debug/fills.json", JSON.stringify(fills, null, 2));
    // Schema-only summary (safe to read in logs; no dollar values).
    console.log("SCHEMA market_positions count:", allPositions.market_positions.length);
    console.log("SCHEMA market_position keys   :", JSON.stringify(Object.keys(allPositions.market_positions[0] || {})));
    console.log("SCHEMA fills count            :", fills.length);
    console.log("SCHEMA fill keys              :", JSON.stringify(Object.keys(fills[0] || {})));
  }

  const marketPositions = (allPositions.market_positions || [])
    .filter((mp) => (mp.position ?? 0) !== 0);
  const settlements = settlementsResp.settlements || [];

  // Fetch a human title for each ticker we'll display (open + recent settled).
  const titleCache = {};
  async function titleFor(ticker) {
    if (ticker in titleCache) return titleCache[ticker];
    try {
      titleCache[ticker] = (await kget(`/markets/${ticker}`)).market?.title || ticker;
    } catch {
      titleCache[ticker] = ticker;
    }
    return titleCache[ticker];
  }

  /* -------- ACTIVE positions --------
     All money normalized to DOLLARS via moneyDollars() (handles both the
     `*_dollars` string fields and bare cents integers). avg / last are
     per-contract prices in cents, just for display.                          */
  let unrealizedPnl = 0, activeCost = 0; // dollars
  const active = await Promise.all(marketPositions.map(async (mp) => {
    const qtyRaw = mp.position != null ? mp.position : (parseFloat(mp.position_fp) || 0);
    const side = qtyRaw > 0 ? "yes" : "no";
    const qty = Math.abs(qtyRaw);
    const cost = moneyDollars(mp, "total_traded");     // dollars
    const value = moneyDollars(mp, "market_exposure"); // dollars (current value)
    const avg = qty ? Math.round((cost / qty) * 100) : 0;   // cents/contract
    const last = qty ? Math.round((value / qty) * 100) : 0; // cents/contract
    const return_pct = cost ? round1(((value - cost) / cost) * 100) : 0;

    unrealizedPnl += value - cost;
    activeCost += cost;

    return { title: await titleFor(mp.ticker), ticker: mp.ticker, side, avg, last, return_pct };
  }));

  /* -------- REALIZED P&L from FILLS (+ settlements) --------
     Kalshi's positions endpoint drops closed markets, so realized P&L is
     reconstructed from the full fills history. Per market:
       realized = (sell proceeds + settlement payout) - (buy cost + all fees)
     This counts BOTH held-to-settlement outcomes AND trades closed early by
     selling — the early exits were previously missing, hiding real winners.  */

  // settlement payout + metadata, keyed by ticker
  const settleByTicker = {};
  for (const s of settlements) {
    settleByTicker[s.ticker] = {
      revenue: centsToDollars(s.revenue),                 // payout, dollars
      fee: strDollars(s.fee_cost),
      result: (s.market_result || "").toLowerCase() === "yes" ? "yes" : "no",
      time: s.settled_time || s.determined_time || "",
    };
  }

  // aggregate each market's cash flows from its fills
  //
  // IMPORTANT: a fill's `side`/`outcome_side` just mirror `book_side` (bid=yes,
  // ask=no) — they describe the order-book side matched, NOT the contract the
  // user holds. On a SELL (a close), the tag is therefore the OPPOSITE of the
  // side actually held. So the "effective side" = tagged side on a buy, and the
  // opposite of the tagged side on a sell. Price + position netting both follow
  // the effective side. (Validated: for held-to-settlement markets the net
  // effective contracts reconcile exactly with the API's settlement payout.)
  const agg = {};
  for (const f of fills) {
    const ticker = f.ticker || f.market_ticker;
    if (!ticker) continue;
    const a = (agg[ticker] ??= { buyCost: 0, sellProceeds: 0, fees: 0, yesNet: 0, noNet: 0, lastTs: "" });
    const count = parseFloat(f.count_fp) || 0;
    const yesP = strDollars(f.yes_price_dollars);
    const noP = strDollars(f.no_price_dollars);
    const action = (f.action || "").toLowerCase();
    const tagNo = (f.side || f.outcome_side || "").toLowerCase() === "no";
    const effNo = action === "buy" ? tagNo : !tagNo; // sell = opposite of tag
    const price = effNo ? noP : yesP;                // price of the effective side
    const amount = count * price;
    a.fees += strDollars(f.fee_cost);
    const ts = f.created_time || f.ts || "";
    if (ts > a.lastTs) a.lastTs = ts;
    if (action === "buy") {
      a.buyCost += amount;
      if (effNo) a.noNet += count; else a.yesNet += count;
    } else {
      a.sellProceeds += amount;
      if (effNo) a.noNet -= count; else a.yesNet -= count;
    }
  }

  // a market is "realized" when it's settled or its contracts are all closed out
  const closed = [];
  for (const [ticker, a] of Object.entries(agg)) {
    const s = settleByTicker[ticker];
    const openContracts = Math.max(0, a.yesNet) + Math.max(0, a.noNet);
    if (openContracts > 0.01 && !s) continue; // still open -> shown via positions endpoint
    const cost = a.buyCost + a.fees + (s ? s.fee : 0);      // total outlay (basis)
    const proceeds = a.sellProceeds + (s ? s.revenue : 0);  // sells + settlement payout
    const pnl = proceeds - cost;
    closed.push({
      ticker,
      result: s ? s.result : "closed",   // "closed" = exited by selling before resolution
      date: (s ? s.time : a.lastTs).slice(0, 10),
      time: s ? s.time : a.lastTs,
      cost,
      pnl,
      return_pct: cost ? round1((pnl / cost) * 100) : 0,
    });
  }

  const realizedPnl = closed.reduce((x, r) => x + r.pnl, 0);
  const closedCost = closed.reduce((x, r) => x + r.cost, 0);
  const wins = closed.filter((r) => r.pnl > 0).length;

  if (DEBUG) {
    // Per-market breakdown + raw fills, to diagnose miscomputed P&L.
    const fillsByTicker = {};
    for (const f of fills) { const t = f.ticker || f.market_ticker; (fillsByTicker[t] ??= []).push(f); }
    const breakdown = Object.entries(agg).map(([ticker, a]) => ({
      ticker, ...a, settle: settleByTicker[ticker] || null, fills: fillsByTicker[ticker],
    }));
    await writeFile("data/_debug/breakdown.json", JSON.stringify(breakdown, null, 2));
  }

  /* -------- aggregates (percentages only) -------- */
  const realized_return_pct = closedCost ? round1((realizedPnl / closedCost) * 100) : 0;
  const unrealized_return_pct = activeCost ? round1((unrealizedPnl / activeCost) * 100) : 0;
  const totalCost = closedCost + activeCost;
  const net_return_pct = totalCost ? round1(((realizedPnl + unrealizedPnl) / totalCost) * 100) : 0;
  const win_rate_pct = closed.length ? round1((wins / closed.length) * 100) : 0;

  // cumulative realized return %, chronological, for the sparkline
  const chrono = [...closed].sort((a, b) => a.time.localeCompare(b.time));
  let cumPnl = 0, cumCost = 0;
  const curve = [0];
  for (const x of chrono) {
    cumPnl += x.pnl;
    cumCost += x.cost;
    curve.push(cumCost ? round1((cumPnl / cumCost) * 100) : 0);
  }

  // Displayed historicals: most recent N, with titles.
  const recent = [...closed].sort((a, b) => b.time.localeCompare(a.time)).slice(0, DISPLAY_SETTLED);
  const settled = await Promise.all(recent.map(async (x) => ({
    title: await titleFor(x.ticker),
    ticker: x.ticker,
    result: x.result,
    date: x.date,
    return_pct: x.return_pct,
  })));

  const out = {
    updated: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
    net_return_pct,
    realized_return_pct,
    unrealized_return_pct,
    win_rate_pct,
    settled_total: closed.length,
    curve,
    active,
    settled,
  };

  await mkdir(path.dirname("data/kalshi.json"), { recursive: true });
  await writeFile("data/kalshi.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote data/kalshi.json — ${active.length} active, ${closed.length} closed/settled (showing ${settled.length}), realized ${realized_return_pct}%, win ${win_rate_pct}%`);
}

main().catch((e) => { console.error(e); process.exit(1); });

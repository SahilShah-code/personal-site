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

// How many settled markets to show in the "historicals" list (aggregates still
// use ALL of them). Kept modest so the page stays readable and title lookups
// stay light.
const DISPLAY_SETTLED = 20;

/* ----------------------------------------------------------------------------
 * Main
 * -------------------------------------------------------------------------- */
async function main() {
  const [positionsResp, settlementsResp] = await Promise.all([
    kget("/portfolio/positions"),
    kget("/portfolio/settlements"),
  ]);

  if (DEBUG) {
    await mkdir("data/_debug", { recursive: true });
    await writeFile("data/_debug/positions.json", JSON.stringify(positionsResp, null, 2));
    await writeFile("data/_debug/settlements.json", JSON.stringify(settlementsResp, null, 2));
  }

  const marketPositions = (positionsResp.market_positions || [])
    .filter((mp) => mp.position !== 0);
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
     Kalshi gives cost + current value directly on each market_position:
       total_traded    = cost basis of the position (cents)
       market_exposure = current market value of the position (cents)
     avg / last are derived per-contract just for display.                    */
  let unrealizedPnl = 0, activeCost = 0;
  const active = await Promise.all(marketPositions.map(async (mp) => {
    const side = mp.position > 0 ? "yes" : "no";
    const qty = Math.abs(mp.position);
    const costCents = mp.total_traded ?? 0;
    const valueCents = mp.market_exposure ?? 0;
    const avg = qty ? Math.round(costCents / qty) : 0;
    const last = qty ? Math.round(valueCents / qty) : 0;
    const return_pct = costCents ? round1(((valueCents - costCents) / costCents) * 100) : 0;

    unrealizedPnl += valueCents - costCents;
    activeCost += costCents;

    return { title: await titleFor(mp.ticker), ticker: mp.ticker, side, avg, last, return_pct };
  }));

  /* -------- SETTLED (historicals) --------
     Each settlement carries its own cost + payout:
       yes_total_cost + no_total_cost = cost basis (cents)
       revenue                        = payout received (cents)               */
  const settledCalc = settlements.map((s) => {
    const costCents = (s.yes_total_cost ?? 0) + (s.no_total_cost ?? 0);
    const revenue = s.revenue ?? 0;
    const pnl = revenue - costCents;
    return {
      ticker: s.ticker,
      result: (s.market_result || "").toLowerCase() === "yes" ? "yes" : "no",
      date: (s.settled_time || s.determined_time || "").slice(0, 10),
      costCents,
      pnl,
      return_pct: costCents ? round1((pnl / costCents) * 100) : 0,
      sortKey: s.settled_time || s.determined_time || "",
    };
  });

  // Aggregates over ALL settled markets.
  const realizedPnl = settledCalc.reduce((a, x) => a + x.pnl, 0);
  const settledCost = settledCalc.reduce((a, x) => a + x.costCents, 0);
  const wins = settledCalc.filter((x) => x.pnl > 0).length;

  /* -------- aggregates (percentages only) -------- */
  const realized_return_pct = settledCost ? round1((realizedPnl / settledCost) * 100) : 0;
  const unrealized_return_pct = activeCost ? round1((unrealizedPnl / activeCost) * 100) : 0;
  const totalCost = settledCost + activeCost;
  const net_return_pct = totalCost ? round1(((realizedPnl + unrealizedPnl) / totalCost) * 100) : 0;
  const win_rate_pct = settledCalc.length ? round1((wins / settledCalc.length) * 100) : 0;

  // cumulative realized return %, chronological, for the sparkline
  const chrono = [...settledCalc].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  let cumPnl = 0, cumCost = 0;
  const curve = [0];
  for (const x of chrono) {
    cumPnl += x.pnl;
    cumCost += x.costCents;
    curve.push(cumCost ? round1((cumPnl / cumCost) * 100) : 0);
  }

  // Displayed historicals: most recent N, with titles.
  const recent = [...settledCalc].sort((a, b) => b.sortKey.localeCompare(a.sortKey)).slice(0, DISPLAY_SETTLED);
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
    settled_total: settledCalc.length,
    curve,
    active,
    settled,
  };

  await mkdir(path.dirname("data/kalshi.json"), { recursive: true });
  await writeFile("data/kalshi.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote data/kalshi.json — ${active.length} active, ${settledCalc.length} settled (showing ${settled.length}), net ${net_return_pct}%`);
}

main().catch((e) => { console.error(e); process.exit(1); });

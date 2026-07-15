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
function costBasisByTicker(fills) {
  // Per ticker, aggregate buy cost + count for each side.
  const acc = {};
  for (const f of fills) {
    const t = (acc[f.ticker] ??= {
      yes: { count: 0, cost: 0 }, no: { count: 0, cost: 0 }, totalBuyCost: 0,
    });
    const side = f.side; // "yes" | "no"
    const price = side === "yes" ? f.yes_price : f.no_price; // cents
    if (f.action === "buy") {
      t[side].count += f.count;
      t[side].cost += f.count * price;
      t.totalBuyCost += f.count * price;
    }
  }
  return acc;
}

const avgOf = (leg) => (leg && leg.count ? leg.cost / leg.count : 0);
const round1 = (n) => Math.round(n * 10) / 10;

/* ----------------------------------------------------------------------------
 * Main
 * -------------------------------------------------------------------------- */
async function main() {
  const [positionsResp, settlementsResp, fills] = await Promise.all([
    kget("/portfolio/positions"),
    kget("/portfolio/settlements"),
    kgetAll("/portfolio/fills", "fills"),
  ]);

  if (DEBUG) {
    await mkdir("data/_debug", { recursive: true });
    await writeFile("data/_debug/positions.json", JSON.stringify(positionsResp, null, 2));
    await writeFile("data/_debug/settlements.json", JSON.stringify(settlementsResp, null, 2));
    await writeFile("data/_debug/fills.json", JSON.stringify(fills, null, 2));
  }

  const cost = costBasisByTicker(fills);

  // ---- MAPPING (verify against DEBUG output for your account) ----
  const marketPositions = (positionsResp.market_positions || [])
    .filter((mp) => mp.position !== 0);
  const settlements = settlementsResp.settlements || [];

  // Fetch market metadata (title + current price) for each open ticker.
  const markets = {};
  await Promise.all(
    marketPositions.map(async (mp) => {
      try {
        const m = (await kget(`/markets/${mp.ticker}`)).market;
        markets[mp.ticker] = m;
      } catch {
        markets[mp.ticker] = null;
      }
    })
  );

  /* -------- ACTIVE positions -------- */
  let unrealizedPnl = 0, activeCost = 0;
  const active = marketPositions.map((mp) => {
    const side = mp.position > 0 ? "yes" : "no";
    const leg = cost[mp.ticker]?.[side];
    const avg = Math.round(avgOf(leg)) || 0; // avg entry, cents
    const m = markets[mp.ticker] || {};
    // current price of the *held side*, in cents
    const yesLast = m.last_price ?? m.yes_bid ?? avg;
    const last = side === "yes" ? yesLast : 100 - yesLast;
    const basis = avg || 1;
    const return_pct = round1(((last - avg) / basis) * 100);

    const qty = Math.abs(mp.position);
    unrealizedPnl += (last - avg) * qty;
    activeCost += avg * qty;

    return {
      title: m.title || mp.ticker,
      ticker: mp.ticker,
      side,
      avg,
      last,
      return_pct,
    };
  });

  /* -------- SETTLED (historicals) -------- */
  let realizedPnl = 0, settledCost = 0, wins = 0;
  const settled = settlements.map((s) => {
    const basisCents = cost[s.ticker]?.totalBuyCost || 0;
    const revenue = s.revenue ?? 0; // payout, cents
    const pnl = revenue - basisCents;
    const return_pct = basisCents ? round1((pnl / basisCents) * 100) : 0;
    if (pnl > 0) wins++;
    realizedPnl += pnl;
    settledCost += basisCents;
    const dt = s.settled_time || s.determined_time || "";
    return {
      title: s.title || s.ticker,
      ticker: s.ticker,
      result: (s.market_result || "").toLowerCase() === "yes" ? "yes" : "no",
      date: dt ? dt.slice(0, 10) : "",
      return_pct,
    };
  });

  /* -------- aggregates (percentages only) -------- */
  const realized_return_pct = settledCost ? round1((realizedPnl / settledCost) * 100) : 0;
  const unrealized_return_pct = activeCost ? round1((unrealizedPnl / activeCost) * 100) : 0;
  const totalCost = settledCost + activeCost;
  const net_return_pct = totalCost ? round1(((realizedPnl + unrealizedPnl) / totalCost) * 100) : 0;
  const win_rate_pct = settled.length ? round1((wins / settled.length) * 100) : 0;

  // cumulative realized return %, chronological, for the sparkline
  const chrono = [...settlements].sort((a, b) =>
    (a.settled_time || "").localeCompare(b.settled_time || ""));
  let cumPnl = 0, cumCost = 0;
  const curve = [0];
  for (const s of chrono) {
    cumPnl += (s.revenue ?? 0) - (cost[s.ticker]?.totalBuyCost || 0);
    cumCost += cost[s.ticker]?.totalBuyCost || 0;
    curve.push(cumCost ? round1((cumPnl / cumCost) * 100) : 0);
  }

  const out = {
    updated: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
    net_return_pct,
    realized_return_pct,
    unrealized_return_pct,
    win_rate_pct,
    curve,
    active,
    settled,
  };

  await mkdir(path.dirname("data/kalshi.json"), { recursive: true });
  await writeFile("data/kalshi.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote data/kalshi.json — ${active.length} active, ${settled.length} settled, net ${net_return_pct}%`);
}

main().catch((e) => { console.error(e); process.exit(1); });

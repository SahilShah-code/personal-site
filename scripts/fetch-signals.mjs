#!/usr/bin/env node
/**
 * fetch-signals.mjs — "markets to watch": active prediction markets that moved
 * recently, matched to recent news that may have driven the move.
 *
 * Reads data/news.json + pulls active Polymarket markets (gamma), tags each by
 * topic, matches to headlines by shared PROPER-NOUN entities (Messi, Fed,
 * Nvidia…), ranks by news-match + 24h move, writes data/market-signals.json.
 * Run after fetch-news.mjs.
 */
import { execSync } from "node:child_process";
import { writeFile, mkdir, readFile } from "node:fs/promises";

const curl = (u) => execSync(`curl -s --max-time 30 -A "Mozilla/5.0" ${JSON.stringify(u)}`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const TOPICS = {
  "NBA": ["nba", "basketball"],
  "NFL": ["nfl", "super bowl"],
  "Tennis": ["tennis", "wimbledon", " atp", " wta", "us open", "roland garros"],
  "World Cup": ["world cup", "fifa", "copa america"],
  "Macro": ["fed", "federal reserve", "inflation", "interest rate", "rate cut", "rate hike", "recession", "jobs report", " cpi", "powell", "unemployment", " gdp"],
  "Markets": ["s&p", "nasdaq", "dow jones", "stock market", "bitcoin", "ethereum", "nvidia", "tesla"],
  "Biotech": ["fda", "biotech", "drug approval", "clinical trial", "pharma"],
};
// junk / noise markets to exclude
const BLOCK = /\bup or down\b|esports|\blol\b|\bbo3\b|\bbo5\b|\bcs2\b|\bdota\b|\bvalorant\b/i;
// proper nouns too generic to be a real "match"
const GENERIC = new Set("fifa nba nfl wnba world cup league esports super bowl golden ball open final finals champion championship season game match team new the will".split(" "));
const STOP = new Set("will be the of in a to is by on for and or vs at next win first than more this that with about into over from who what when year game match day".split(" "));

const topicOf = (q) => { const s = " " + q.toLowerCase() + " "; for (const [t, kws] of Object.entries(TOPICS)) if (kws.some(k => s.includes(k))) return t; return null; };
const entities = (text) => {
  const out = new Set();
  for (const w of (text.match(/\b[A-Z][a-zA-Z'’]{2,}\b/g) || [])) { const l = w.toLowerCase(); if (!GENERIC.has(l) && !STOP.has(l)) out.add(l); }
  return out;
};

async function main() {
  let headlines = [];
  try {
    const news = JSON.parse(await readFile("data/news.json", "utf8"));
    for (const c of news.categories || []) for (const it of c.items || []) headlines.push({ ...it, cat: c.label, ents: entities(it.title) });
  } catch { /* no news yet */ }

  const markets = [];
  for (let off = 0; off < 600; off += 100) {
    let batch = [];
    try { batch = JSON.parse(curl(`https://gamma-api.polymarket.com/markets?closed=false&active=true&order=volume24hr&ascending=false&limit=100&offset=${off}`)); }
    catch { batch = []; }
    if (!batch.length) break;
    markets.push(...batch);
  }

  const now = Date.now();
  const signals = [];
  for (const m of markets) {
    const q = m.question || "";
    if (BLOCK.test(q)) continue;
    const topic = topicOf(q);
    if (!topic) continue;
    // skip ultra-short-term markets (intraday noise): resolve < 36h away
    if (m.endDate && new Date(m.endDate).getTime() - now < 36 * 3600 * 1000) continue;

    const chg = Number(m.oneDayPriceChange) || 0;
    const vol = Number(m.volume24hr) || 0;
    let yes = null;
    try { yes = JSON.parse(m.outcomePrices || "[]")[0]; } catch {}
    yes = yes != null ? Number(yes) : (m.lastTradePrice != null ? Number(m.lastTradePrice) : null);

    const qEnt = entities(q);
    const matched = [];
    for (const h of headlines) {
      const shared = [...qEnt].filter(e => h.ents.has(e));
      if (shared.length >= 1) matched.push({ title: h.title, source: h.source, url: h.url, cat: h.cat });
      if (matched.length >= 2) break;
    }
    signals.push({
      question: q, topic,
      url: `https://polymarket.com/event/${m.slug}`,
      yes: yes != null ? Math.round(yes * 100) : null,
      change24h: Math.round(chg * 100),
      vol24h: Math.round(vol),
      headlines: matched,
    });
  }

  signals.sort((a, b) =>
    (b.headlines.length > 0) - (a.headlines.length > 0) ||
    Math.abs(b.change24h) - Math.abs(a.change24h) ||
    b.vol24h - a.vol24h);

  const withNews = [], perTopic = {};
  for (const s of signals) {
    if (!s.headlines.length) continue;
    perTopic[s.topic] = (perTopic[s.topic] || 0) + 1;
    if (perTopic[s.topic] <= 3) withNews.push(s);   // cap per topic for diversity
    if (withNews.length >= 12) break;
  }
  const moversOnly = signals.filter(s => !s.headlines.length && Math.abs(s.change24h) >= 4).slice(0, 8);
  const out = { updated: new Date().toISOString(), withNews, moversOnly };

  await mkdir("data", { recursive: true });
  await writeFile("data/market-signals.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`scanned ${markets.length} | in-topic ${signals.length} | news-matched ${withNews.length} | movers ${moversOnly.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

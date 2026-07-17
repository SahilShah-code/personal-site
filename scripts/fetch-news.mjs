#!/usr/bin/env node
/**
 * fetch-news.mjs — daily news portal feed for the "the feed" tool.
 * Pulls Google News RSS (free, no API key) for each category and writes
 * data/news.json. Run daily by a GitHub Action.
 *
 *   node scripts/fetch-news.mjs
 */
import { execSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";

const CATS = [
  { key: "nba",         label: "NBA",             q: "NBA basketball" },
  { key: "nfl",         label: "NFL",             q: "NFL football" },
  { key: "tennis",      label: "Tennis",          q: "tennis ATP WTA" },
  { key: "worldcup",    label: "World Cup",       q: "FIFA World Cup soccer" },
  { key: "macro",       label: "Macro",           q: "economy Federal Reserve inflation rates" },
  { key: "markets",     label: "Markets",         q: "stock market S&P 500" },
  { key: "biotech",     label: "Biotech",         q: "biotech drug development clinical trial" },
  { key: "biotechmkts", label: "Biotech markets", q: "biotech stocks FDA approval" },
];
const PER_CAT = 6;

const decode = (s) => s
  .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
  .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();

function fetchRss(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  return execSync(`curl -s --max-time 30 -A "Mozilla/5.0" ${JSON.stringify(url)}`, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
}

function parseItems(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>(.*?)<\/item>/gs)) {
    const it = m[1];
    const g = (re) => { const x = it.match(re); return x ? decode(x[1]) : ""; };
    let title = g(/<title>(.*?)<\/title>/s);
    const source = g(/<source[^>]*>(.*?)<\/source>/s);
    const url = g(/<link>(.*?)<\/link>/s);
    const pub = g(/<pubDate>(.*?)<\/pubDate>/s);
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    const ts = pub ? Date.parse(pub) : 0;
    if (title && url) items.push({ title, source, url, ts });
  }
  return items;
}

async function main() {
  const categories = [];
  for (const c of CATS) {
    let items = [];
    try { items = parseItems(fetchRss(c.q)); } catch (e) { console.error(c.key, e.message); }
    items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    categories.push({ key: c.key, label: c.label, items: items.slice(0, PER_CAT) });
    console.log(`${c.label}: ${items.length} found -> ${Math.min(items.length, PER_CAT)} kept`);
  }
  const out = { updated: new Date().toISOString(), categories };
  await mkdir("data", { recursive: true });
  await writeFile("data/news.json", JSON.stringify(out, null, 2) + "\n");
  console.log("wrote data/news.json");
}

main().catch((e) => { console.error(e); process.exit(1); });

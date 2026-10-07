#!/usr/bin/env bun
// Phase 6 / brief 01 — download the full sitemap of every catalog domain into
// catalog/corpus/sites/<domain>/sitemap.json, following <sitemapindex> children (depth ≤ 3).
// Host-less locs (`https://templates/c-blocks/x`, `/c-blocks/x`) are repaired against the domain
// and counted as `host_repaired` (brief 08).
//   bun tools/sitemaps.mjs [--only=a.com,b.com] [--refresh]
// `bun tools/fetch.mjs --sitemaps` runs the same code (this module owns the logic).
import { gunzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FILE, ROOT, loadJSON, saveJSON, pool } from "./lib.mjs";
import { scraplingClient } from "./scrapling-backend.mjs";

export const DOMAIN_LIST = join(ROOT, "briefs", "phase-6", "sites", "all-sitemap-domains.txt");
export const UA = "Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)";

export const MAX_URLS = 50_000; // per domain
export const MAX_DEPTH = 3; // root sitemap = 1
const MAX_SOURCES = 1000; // safety valve: a pathological index must not stall a worker forever
const MAX_BYTES = 64e6; // one sitemap response
const TIMEOUT = 20_000;
const HOST_INTERVAL = 500; // ms between two request starts on one host → 2 req/s
const HOSTS_AT_ONCE = 12; // domains in flight
const MAX_BAD = 3; // 403 / 429 / 503 / challenge responses before a host is dropped
const DOMAIN_BUDGET = 300_000; // 5 min per domain: one slow host must not hold the whole run
const FRESH_MS = 7 * 24 * 3600 * 1000; // resume: skip a sitemap.json younger than this

// ------------------------------------------------------------------ parsing

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Trim, unwrap one `<![CDATA[…]]>` wrapper, decode `&amp;` / `&#38;` / `&#x26;`. */
export function decodeXml(raw) {
  const s = String(raw ?? "").trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(s);
  if (cdata) return cdata[1].trim();
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, name) => {
    if (name[0] === "#") {
      const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[name.toLowerCase()] ?? m;
  });
}

const blockRe = (tag) => new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi");
const fieldRe = (tag) => new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`, "i");

function blocksOf(text, tag) {
  const re = blockRe(tag);
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

const fieldOf = (block, tag) => {
  const m = fieldRe(tag).exec(block);
  return m ? decodeXml(m[1]) : null;
};

/** `<loc>` / `<lastmod>` of one `<url>` / `<sitemap>` block; null when the block has no usable loc. */
function entryOf(block) {
  const loc = fieldOf(block, "loc");
  if (!loc) return null;
  const lastmod = fieldOf(block, "lastmod");
  return lastmod ? { loc, lastmod } : { loc };
}

/**
 * `urlset` (page URLs), `index` (child sitemaps), or `invalid` (HTML, soft-404, empty).
 * Nested `<image:loc>` / `<xhtml:link>` never match the `<loc>` field regex.
 */
export function parseSitemap(text) {
  if (typeof text !== "string" || !text.trim()) return { kind: "invalid", entries: [] };
  const urlBlocks = blocksOf(text, "url");
  const mapBlocks = blocksOf(text, "sitemap");
  if (/<sitemapindex[\s>]/i.test(text) || (!urlBlocks.length && mapBlocks.length))
    return { kind: "index", entries: mapBlocks.map(entryOf).filter(Boolean) };
  if (urlBlocks.length || /<urlset[\s>]/i.test(text))
    return { kind: "urlset", entries: urlBlocks.map(entryOf).filter(Boolean) };
  return { kind: "invalid", entries: [] };
}

const CHALLENGE_TITLE = /<title[^>]*>\s*(?:just a moment|attention required)[^<]*<\/title>/i;
const CHALLENGE_MARK =
  /cf-chl-|challenge-platform|cf-turnstile|captcha-delivery|px-captcha|just a moment|checking your browser|verify (?:you are|that you are) human|enable javascript and cookies|access denied|attention required/i;

/**
 * A Cloudflare "Just a moment" / soft challenge page: the challenge `<title>`, or a 403/503 that carries a
 * challenge marker. The marker alone is not a wall — real Cloudflare-fronted pages embed the
 * `/cdn-cgi/challenge-platform/scripts/jsd/main.js` beacon and i18n strings like "Access Denied" (the false
 * positive brief 09 found on ui8.net and colorkit.co), so a 200 with a marker is content.
 */
export const isChallenge = (text, status = 0) =>
  typeof text === "string" &&
  (CHALLENGE_TITLE.test(text.slice(0, 20_000)) || ([403, 503].includes(status) && CHALLENGE_MARK.test(text.slice(0, 20_000))));

/** `.xml.gz` bodies (and any gzip body the server did not label) → plain bytes. */
export function maybeGunzip(buf) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return gunzipSync(buf, { maxOutputLength: MAX_BYTES });
    } catch {
      /* corrupt gzip: fall through, parse fails as invalid */
    }
  }
  return buf;
}

// ------------------------------------------------------------------ network

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Per-host queue: ≥ HOST_INTERVAL between request starts, host dropped after MAX_BAD bad responses. */
const hosts = new Map();
function hostState(host) {
  let s = hosts.get(host);
  if (!s) {
    s = { last: 0, chain: Promise.resolve(), bad: 0, blocked: false, why: "" };
    hosts.set(host, s);
  }
  return s;
}

/**
 * One sitemap-ish response: the opt-in Scrapling backend when the host is enabled (brief 11), plain `fetch`
 * otherwise. Same result shape either way — `{url, status, bytes, text}` / `{tooLarge}` / `{error}`.
 */
export async function rawGet(url, via = scraplingClient) {
  try {
    const scraped = await via?.get(url);
    if (scraped) {
      if (scraped.error) return { url, status: 0, error: scraped.error };
      const buf = scraped.body || Buffer.alloc(0);
      if (scraped.too_large || buf.length > MAX_BYTES) return { url, status: scraped.status, tooLarge: true };
      return { url, status: scraped.status, bytes: buf.length, text: maybeGunzip(buf).toString("utf8") };
    }
  } catch (e) {
    console.error(`warn: scrapling ${url}: ${e?.message || e} — falling back to fetch`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "user-agent": UA, accept: "application/xml,text/xml,text/plain;q=0.9,*/*;q=0.5" },
    });
    if (Number(res.headers.get("content-length") || 0) > MAX_BYTES) {
      await res.body?.cancel().catch(() => {});
      return { url, status: res.status, tooLarge: true };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return { url, status: res.status, tooLarge: true };
    return { url, status: res.status, bytes: buf.length, text: maybeGunzip(buf).toString("utf8") };
  } catch (e) {
    const aborted = e?.name === "AbortError" || e?.name === "TimeoutError";
    return { url, status: 0, error: aborted ? "timeout" : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function request(url) {
  const host = new URL(url).hostname;
  const s = hostState(host);
  if (s.blocked) return Promise.resolve({ url, status: 0, blocked: true, reason: s.why });
  const run = s.chain.then(async () => {
    if (s.blocked) return { url, status: 0, blocked: true, reason: s.why };
    const gap = s.last + HOST_INTERVAL - Date.now();
    if (gap > 0) await sleep(gap);
    s.last = Date.now();
    const r = await rawGet(url);
    if ([403, 429, 503].includes(r.status) || isChallenge(r.text, r.status)) {
      s.bad += 1;
      if (s.bad >= MAX_BAD) {
        s.blocked = true;
        s.why = r.status === 200 ? "challenge-html" : String(r.status);
      }
    }
    return r;
  });
  s.chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

// ------------------------------------------------------------------ domain

/** Sitemap URLs the probe recorded, keyed by the entry host with `www.` dropped. */
export function sitemapsByDomain(probe) {
  const by = new Map();
  for (const [entry, p] of Object.entries(probe?.items || {})) {
    const url = p?.sitemap?.url;
    if (typeof url !== "string" || !url) continue;
    let host;
    try {
      host = new URL(entry).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      continue;
    }
    const list = by.get(host) || [];
    if (!list.includes(url)) list.push(url);
    by.set(host, list);
  }
  return by;
}

export const sitemapPath = (domain) => join(FILE.corpus, "sites", domain, "sitemap.json");

/** Hostname with `www.` dropped for absolute http(s) URLs, null for anything else. */
function hostOf(loc) {
  try {
    const u = new URL(String(loc));
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.replace(/^www\./, "").toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * A loc with no real host (`https://templates/c-blocks/x`, `/c-blocks/x`, `c-blocks/x`) as a path relative to the
 * domain being fetched — the bogus label stays, so `https://templates/c-blocks/x` repairs to
 * `https://<domain>/templates/c-blocks/x` (the form dycomps.oimmi.com serves). null when the loc is not repairable.
 */
function hostlessPath(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m = /^[a-z][a-z0-9+.-]*:(?:\/\/?)?([^/?#]*)([\s\S]*)$/i.exec(s);
  if (m) {
    if (!m[1] || m[1].includes(".")) return null; // no host at all, or a real one
    return `${m[1]}${m[2]}`;
  }
  if (s.startsWith("//")) return null; // protocol-relative: `new URL` already knows what to do
  return s.replace(/^\/+/, "");
}

/**
 * Keep the URLs whose host is `domain` or `www.domain` (deduped by loc, first wins), cap at
 * `cap`, and count everything else as foreign — including locs that are not absolute http(s).
 * Host-less locs are repaired against `domain` first and counted as `repaired`.
 */
export function keepInDomain(entries, domain, cap = MAX_URLS) {
  const want = String(domain).replace(/^www\./, "").toLowerCase();
  const urls = [];
  const seen = new Set();
  let foreign = 0;
  let truncated = false;
  let repaired = 0;
  for (const e of entries) {
    const raw = String(e?.loc ?? "");
    let loc = raw;
    let fixed = false;
    if (hostOf(raw) !== want) {
      const rel = hostlessPath(raw);
      if (rel == null) {
        foreign += 1;
        continue;
      }
      try {
        const u = new URL(rel, `https://${want}/`);
        if (hostOf(u.href) !== want) {
          foreign += 1;
          continue;
        }
        loc = u.href;
        fixed = true;
      } catch {
        foreign += 1;
        continue;
      }
    }
    // Some sitemaps carry `https:/host/path` (one slash): the host is right but the string is not a
    // usable absolute URL, so store the parsed form. Well-formed locs stay byte-identical.
    if (!/^https?:\/\//i.test(loc)) loc = new URL(loc).href;
    if (seen.has(loc)) continue;
    if (urls.length >= cap) {
      truncated = true;
      continue;
    }
    seen.add(loc);
    if (fixed) repaired += 1;
    urls.push(e.lastmod ? { loc, lastmod: e.lastmod } : { loc });
  }
  return { urls, foreign, truncated, repaired };
}

function isFresh(prev, dest) {
  const t = Date.parse(prev?.fetched_at || "");
  if (Number.isFinite(t)) return Date.now() - t < FRESH_MS;
  try {
    return Date.now() - statSync(dest).mtimeMs < FRESH_MS;
  } catch {
    return false;
  }
}

async function collectDomain(domain, { probeUrls = [], refresh = false, progress = () => {} } = {}) {
  const dest = sitemapPath(domain);
  const prev = refresh ? null : loadJSON(dest);
  if (prev?.urls?.length && isFresh(prev, dest)) return { domain, status: "skipped", count: prev.urls.length };

  const candidates = [];
  const add = (u) => {
    try {
      const href = new URL(u).href;
      if (!candidates.includes(href)) candidates.push(href);
    } catch {
      /* not a URL */
    }
  };
  for (const u of probeUrls) add(u);
  add(`https://${domain}/sitemap.xml`);

  const sources = [];
  const attempts = [];
  const entries = [];
  const fetched = new Set();
  const seenIn = new Set(); // in-domain locs seen so far — lets us stop once the url cap is reached
  const want = domain.replace(/^www\./, "").toLowerCase();
  const deadline = Date.now() + DOMAIN_BUDGET;
  let stop = "";

  async function ingest(url, depth) {
    if (fetched.has(url)) return;
    if (sources.length >= MAX_SOURCES) stop = "source cap";
    else if (seenIn.size >= MAX_URLS) stop = "url cap";
    else if (Date.now() > deadline) stop = "time budget";
    if (stop) return;
    fetched.add(url);
    const r = await request(url);
    if (r.blocked) {
      attempts.push({ url, status: 0, kind: "blocked", reason: r.reason });
      return;
    }
    if (r.error || r.tooLarge) {
      const kind = r.tooLarge ? "too-large" : "error";
      attempts.push({ url, status: r.status, kind });
      sources.push({ url, status: r.status, kind, count: 0 });
      return;
    }
    const parsed = parseSitemap(r.text);
    const challenge = isChallenge(r.text, r.status);
    const kind = challenge ? "invalid" : parsed.kind;
    attempts.push({ url, status: r.status, kind: challenge ? "challenge" : parsed.kind });
    sources.push({ url, status: r.status, kind, count: parsed.entries.length });
    if (r.status !== 200 || challenge) return;
    if (parsed.kind === "index") {
      if (depth >= MAX_DEPTH) return;
      for (const child of parsed.entries.slice(0, MAX_SOURCES)) await ingest(child.loc, depth + 1);
    } else if (parsed.kind === "urlset") {
      entries.push(...parsed.entries);
      for (const e of parsed.entries) if (hostOf(e.loc) === want) seenIn.add(e.loc);
    }
  }

  for (const url of [...candidates]) await ingest(url, 1);

  const robots = await request(`https://${domain}/robots.txt`);
  if (robots.status === 200 && robots.text && !isChallenge(robots.text, robots.status)) {
    for (const line of robots.text.split(/\r?\n/)) {
      const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
      if (m) add(m[1]);
    }
  }
  for (const url of candidates) await ingest(url, 1);

  const { urls, foreign, truncated, repaired } = keepInDomain(entries, domain);
  const wasTruncated = truncated || !!stop;
  if (wasTruncated) progress(`  ${domain}: truncated at ${urls.length} urls (${stop || "url cap"})`);
  if (repaired) progress(`  ${domain}: repaired ${repaired} host-less locs`);

  if (urls.length) {
    saveJSON(dest, {
      domain,
      fetched_at: new Date().toISOString(),
      truncated: wasTruncated,
      foreign_dropped: foreign,
      host_repaired: repaired,
      sources,
      urls,
    });
    return { domain, status: "ok", count: urls.length, foreign, truncated: wasTruncated, repaired };
  }

  const stopped = attempts.find((a) => a.kind === "blocked");
  if (stopped) return { domain, status: "blocked", reason: `host-stopped:${stopped.reason}` };
  const responded = attempts.filter((a) => a.kind !== "error" && a.kind !== "too-large");
  const bad = responded.filter((a) => a.kind === "challenge" || [403, 429, 503].includes(a.status));
  if (responded.length && bad.length === responded.length) {
    const challenge = bad.some((a) => a.kind === "challenge");
    return { domain, status: "blocked", reason: challenge ? "challenge-html" : String(bad[0].status) };
  }
  if (attempts.length && attempts.every((a) => a.kind === "error" || a.kind === "too-large"))
    return { domain, status: "failed", reason: attempts[0].kind };
  return { domain, status: "empty", reason: attempts.length ? `${responded.length} bad/no-url responses` : "no source" };
}

// ------------------------------------------------------------------ runner

export function readDomains(file = DOMAIN_LIST) {
  return [
    ...new Set(
      readFileSync(file, "utf8")
        .split("\n")
        .map((l) => l.split("#")[0].trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function mergeReport(prev, next) {
  const touched = new Set([
    ...next.ok.map(([d]) => d),
    ...next.empty,
    ...next.blocked.map((b) => b.domain),
    ...next.failed,
  ]);
  const keep = (arr, key) => (prev?.[arr] || []).filter((x) => !touched.has(key(x)));
  return {
    ok: [...keep("ok", ([d]) => d), ...next.ok],
    empty: [...keep("empty", (d) => d), ...next.empty],
    blocked: [...keep("blocked", (b) => b.domain), ...next.blocked],
    failed: [...keep("failed", (d) => d), ...next.failed],
  };
}

export async function runSitemaps({ only, refresh = false, log = console.log, progress = console.error } = {}) {
  const wanted = only?.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const list = readDomains();
  const targets = wanted?.length ? [...new Set([...list.filter((d) => wanted.includes(d)), ...wanted])] : list;
  for (const d of wanted || []) if (!list.includes(d)) progress(`sitemaps: ${d} is not in ${DOMAIN_LIST.split("/").pop()} — running it anyway`);
  const byDomain = sitemapsByDomain(loadJSON(FILE.probe, { items: {} }));

  progress(`sitemaps: ${targets.length} domains · ${HOSTS_AT_ONCE} hosts at once · 2 req/s/host · ${refresh ? "refresh" : "resume <7d"}`);
  const t0 = Date.now();
  let done = 0;
  const results = await pool(targets, HOSTS_AT_ONCE, async (domain) => {
    try {
      const r = await collectDomain(domain, { probeUrls: byDomain.get(domain) || [], refresh, progress });
      if (["blocked", "failed"].includes(r.status)) progress(`  ${r.status}: ${domain} (${r.reason})`);
      return r;
    } catch (e) {
      return { domain, status: "failed", reason: String(e?.message || e) };
    } finally {
      if (++done % 25 === 0) progress(`  ${done}/${targets.length} domains`);
    }
  });

  const ok = [];
  const empty = [];
  const blocked = [];
  const failed = [];
  let total = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === "ok" || r.status === "skipped") {
      if (r.status === "skipped") skipped += 1;
      ok.push([r.domain, r.count]);
      total += r.count;
    } else if (r.status === "blocked") blocked.push({ domain: r.domain, reason: r.reason });
    else if (r.status === "failed") failed.push(r.domain);
    else empty.push(r.domain);
  }

  const fresh = { ok, empty, blocked, failed };
  const report = { generated_at: new Date().toISOString(), ...(only?.length ? mergeReport(loadJSON(FILE.sitemapsReport), fresh) : fresh) };
  saveJSON(FILE.sitemapsReport, report);
  await scraplingClient.close();

  const reasons = {};
  for (const b of blocked) reasons[b.reason] = (reasons[b.reason] || 0) + 1;
  log(
    `sitemaps: ${targets.length} tried · ok ${ok.length}${skipped ? ` (${skipped} resumed)` : ""} · empty ${empty.length} · failed ${failed.length} · blocked ${blocked.length}` +
      `${Object.keys(reasons).length ? ` (${Object.entries(reasons).map(([r, n]) => `${r}:${n}`).join(" ")})` : ""} · ${total.toLocaleString("en-US")} URLs · ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
  log(`sitemaps report -> ${FILE.sitemapsReport}`);
  log("largest:");
  for (const [d, c] of [...report.ok].sort((a, b) => b[1] - a[1]).slice(0, 20)) log(`  ${d} ${c}`);
  return report;
}

if (import.meta.main) {
  const only = (process.argv.find((a) => a.startsWith("--only=")) || "")
    .split("=")[1]
    ?.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  await runSitemaps({ only, refresh: process.argv.includes("--refresh") });
}

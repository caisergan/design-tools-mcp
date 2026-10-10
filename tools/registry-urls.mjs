#!/usr/bin/env bun
// Registry url templates (brief 16): the page url of a registry item that no sitemap lists, built from the
// registry name by a per-site template and kept only after a live check. Deterministic, no LLM.
//
//   catalog/registry-urls/<domain>.json                  the config (hand-written, format below)
//   catalog/corpus/sites/<domain>/registry-urls.json     the verified results (written here, read by tools/items.mjs)
//
//   bun tools/registry-urls.mjs --verify <domain>[,<domain>…] [--force]   check every url-less registry item, write the cache
//   bun tools/registry-urls.mjs --all [--force]                           the same for every config
//   bun tools/registry-urls.mjs --check <domain>                          validate, show candidates, verify 10 items live (writes nothing)
//
// Config: { templates: ["https://x.dev/docs/{name}", …], rewrite?: [[regex, replacement], …],
//   types?: ["registry:ui", …], exclude?: [regex, …], status: "hand"|"auto", note?: string }  or  { skip: "reason", status }.
// The registry name is the item's `slug` (else its id after `<entry id>/`). `rewrite` pairs run in order, each as
// `name.replace(new RegExp(re, "g"), replacement)` ("$1" works); `exclude` (an addition to the brief's format)
// names registry names that have no page of their own — they are never fetched and stay url-less.
//
// A candidate passes only when it answers 200 html at the path the template produced (same host up to `www.`,
// a trailing slash aside), its <title> is not the site's soft-404 title, and robots.txt allows it. A wrong link
// is worse than no link: anything unclear is a miss, and anything that may be transient (timeout, 403/429, 5xx)
// leaves the item unrecorded so the next run tries it again. One carve-out: a candidate that a sitemap we hold
// lists (the entry's corpus folder, or its host's) may pass although its template's probe is blind or soft — a
// site that answers 200 for every slug still names its real pages in its own sitemap. Every other rule applies.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FILE, OUT, loadJSON, pool, saveJSON } from "./lib.mjs";
import { buildItems, parentsByDomain, registryUrlsFile } from "./items.mjs";
import { UA, decodeXml } from "./sitemaps.mjs";
import { sitemapFile } from "./sitemap-items.mjs";
import { scraplingClient } from "./scrapling-backend.mjs";

export const CONFIG_DIR = join(OUT, "registry-urls");
export const configFile = (domain) => join(CONFIG_DIR, `${domain}.json`);
export const DEFAULT_TYPES = ["registry:ui", "registry:component", "registry:block", "registry:example"];
export const PROBE_NAME = "zz-design-tools-probe-404";

const TIMEOUT = 15_000;
const HOST_INTERVAL = 500; // ms between two request starts on one host → ≤ 2 req/s
const HOSTS_AT_ONCE = 4; // domains in flight
const MAX_BAD = 3; // 403 / 429 answers in a row before a host is stopped for the run
// html first and no text/plain: Mintlify sites content-negotiate and answer text/markdown to a `text/plain` Accept
export const ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";
const KEYS = new Set(["templates", "rewrite", "types", "exclude", "status", "note", "skip"]);
const STATUS = new Set(["hand", "auto"]);
const DOMAIN = /^[a-z0-9][a-z0-9.-]*$/i;

// ---------------------------------------------------------------- config

/** Throws a clear error for anything outside the format; returns the config unchanged. */
export function validateRegistryUrlConfig(cfg, domain = "?") {
  const fail = (msg) => {
    throw new Error(`catalog/registry-urls/${domain}.json: ${msg}`);
  };
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) fail("must be a JSON object");
  for (const k of Object.keys(cfg)) if (!KEYS.has(k)) fail(`unknown key ${JSON.stringify(k)} (allowed: ${[...KEYS].join(", ")})`);
  if (!STATUS.has(cfg.status)) fail(`status must be "hand" or "auto", got ${JSON.stringify(cfg.status)}`);
  if (cfg.note !== undefined && typeof cfg.note !== "string") fail('"note" must be a string');
  const regex = (src, where) => {
    if (typeof src !== "string" || !src) fail(`${where} must be a non-empty regex string: ${JSON.stringify(src)}`);
    try {
      return new RegExp(src);
    } catch (e) {
      fail(`${where} is not a valid regex: ${JSON.stringify(src)} (${e.message})`);
    }
  };
  if (cfg.skip !== undefined) {
    if (typeof cfg.skip !== "string" || !cfg.skip.trim()) fail("skip must be a non-empty reason string");
    for (const k of ["templates", "rewrite", "types", "exclude"]) if (cfg[k] !== undefined) fail(`a skip config has no ${JSON.stringify(k)}`);
    return cfg;
  }
  if (!Array.isArray(cfg.templates) || !cfg.templates.length) fail('"templates" must be a non-empty array of absolute https urls with {name}');
  for (const t of cfg.templates) {
    if (typeof t !== "string") fail(`template must be a string: ${JSON.stringify(t)}`);
    if (!t.includes("{name}")) fail(`template has no {name}: ${JSON.stringify(t)}`);
    let u;
    try {
      u = new URL(t.replaceAll("{name}", "x"));
    } catch {
      fail(`template is not an absolute url: ${JSON.stringify(t)}`);
    }
    if (u.protocol !== "https:") fail(`template must be https: ${JSON.stringify(t)}`);
    if (!t.startsWith(`${u.origin}/`) || t.indexOf("{name}") < u.origin.length) fail(`{name} must sit in the path or query, not the host: ${JSON.stringify(t)}`);
  }
  if (cfg.rewrite !== undefined) {
    if (!Array.isArray(cfg.rewrite)) fail('"rewrite" must be an array of [regex, replacement] pairs');
    cfg.rewrite.forEach((pair, i) => {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[1] !== "string") fail(`rewrite[${i}] must be a [regex, replacement] pair of strings: ${JSON.stringify(pair)}`);
      regex(pair[0], `rewrite[${i}][0]`);
    });
  }
  if (cfg.types !== undefined) {
    if (!Array.isArray(cfg.types) || !cfg.types.length) fail('"types" must be a non-empty array of registry types');
    for (const t of cfg.types) if (typeof t !== "string" || !/^registry:[a-z-]+$/.test(t)) fail(`type must look like "registry:ui": ${JSON.stringify(t)}`);
  }
  if (cfg.exclude !== undefined) {
    if (!Array.isArray(cfg.exclude)) fail('"exclude" must be an array of regex strings');
    cfg.exclude.forEach((src, i) => regex(src, `exclude[${i}]`));
  }
  return cfg;
}

/** The config of one domain, validated (throws when broken), or null when there is none. */
export function loadRegistryUrlConfig(domain) {
  if (!DOMAIN.test(String(domain))) throw new Error(`not a domain: ${JSON.stringify(domain)}`);
  const f = configFile(domain);
  if (!existsSync(f)) return null;
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    throw new Error(`catalog/registry-urls/${domain}.json: ${e.message}`);
  }
  return validateRegistryUrlConfig(cfg, domain);
}

/** Changes when anything that decides a candidate changes (not `note` or `status`): the cache is then rechecked. */
export const configHash = (cfg) =>
  createHash("sha256")
    .update(JSON.stringify({ templates: cfg.templates, rewrite: cfg.rewrite || [], types: cfg.types || DEFAULT_TYPES, exclude: cfg.exclude || [] }))
    .digest("hex")
    .slice(0, 16);

// ---------------------------------------------------------------- candidates (pure)

/** The registry name of an item: its `slug`, else the id after `<entry id>/`. */
export const registryName = (item) => item.slug || item.id.slice(item.id.indexOf("/") + 1);

export const isExcluded = (name, cfg) => (cfg.exclude || []).some((re) => new RegExp(re).test(name));

export const rewriteName = (name, cfg) => (cfg.rewrite || []).reduce((n, [re, to]) => n.replace(new RegExp(re, "g"), to), name);

/** Each "/"-separated part encoded; null when a part is empty, "." or ".." (a rewrite must not climb out of the template). */
function encodeName(name) {
  const parts = name.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return null;
  return parts.map(encodeURIComponent).join("/");
}

/** [{ url, template }] of `candidates`: the template that produced each url (its soft-404 probe hangs off it). */
export function candidateList(name, cfg) {
  if (isExcluded(name, cfg)) return [];
  const filled = encodeName(rewriteName(name, cfg));
  if (!filled) return [];
  const out = new Map();
  for (const template of cfg.templates) {
    const url = template.replaceAll("{name}", filled);
    if (!out.has(url)) out.set(url, { url, template });
  }
  return [...out.values()];
}

/** The rewritten name filled into each template, in order, deduped; [] for an excluded name or an empty rewrite. */
export const candidates = (name, cfg) => candidateList(name, cfg).map((c) => c.url);

/**
 * The soft-404 probe that stands for `candidate`: the same template with the last "/"-part of the rewritten name
 * replaced by PROBE_NAME, so `components/radix/{x}` is probed under `components/radix/` (for a plain name this is
 * exactly the template filled with PROBE_NAME).
 */
export function probeUrl(name, template, cfg) {
  const parts = rewriteName(name, cfg).split("/");
  parts[parts.length - 1] = PROBE_NAME;
  const filled = encodeName(parts.join("/"));
  return filled ? template.replaceAll("{name}", filled) : null;
}

// ---------------------------------------------------------------- verdicts (pure)

const RETRY_STATUS = new Set([0, 403, 408, 425, 429]);
const isHtml = (type) => /\b(text\/html|application\/xhtml\+xml)\b/i.test(type || "");
const NOT_FOUND_TITLE = /(^|[^a-z0-9])(404|not found)([^a-z0-9]|$)/i;
const NOT_FOUND_NAME = /404|not-?found/i;
const hostOf = (u) => u.hostname.toLowerCase().replace(/^www\./, "");
const pathOf = (u) => {
  let p = u.pathname.replace(/\/+$/, "") || "/";
  try {
    p = decodeURIComponent(p);
  } catch {
    /* compare the raw path */
  }
  return p;
};

/** The first <title> of a page, entities decoded and whitespace collapsed ("" when there is none). */
export function pageTitle(html) {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(String(html || ""));
  return m ? decodeXml(m[1]).replace(/\s+/g, " ").trim() : "";
}

/**
 * What a probe answer says about its template: "clean" (a made-up name is not served as a page), "soft"
 * (served, but its title tells it apart), "blind" (served with no title or with the made-up name echoed in it,
 * so a page can't be told from a miss) or "retry". `title` is set for "soft".
 */
export function probeState(res, url) {
  if (res.error === "robots") return { state: "blind", why: "probe disallowed by robots.txt" };
  if (RETRY_STATUS.has(res.status) || res.status >= 500) return { state: "retry", why: res.error || `http ${res.status}` };
  if (res.status !== 200 || !isHtml(res.type)) return { state: "clean" };
  let final;
  try {
    final = new URL(res.finalUrl || url);
  } catch {
    return { state: "blind", why: "unparsable final url" };
  }
  const want = new URL(url);
  if (hostOf(final) !== hostOf(want) || pathOf(final) !== pathOf(want)) return { state: "clean" }; // redirected away: the path rule catches it
  const title = res.title || "";
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (!title) return { state: "blind", why: "soft-404 without a <title>" };
  if (/\bprobe 404\b|\bzz design tools\b/.test(words)) return { state: "blind", why: "soft-404 echoes the requested name in its <title>" };
  return { state: "soft", title };
}

/**
 * The pass/miss decision for one candidate. `res` = { status, type, finalUrl, title, error? }; `probe` = the
 * probeState of the candidate's template (or null when none was taken); `listed` = a sitemap we hold lists the
 * candidate, which lifts only the blind/soft probe rules. → { verdict: "pass"|"miss"|"retry", why }; a pass that
 * needed the carve-out says `why: "ok (sitemap-listed)"`.
 */
export function judge(res, { candidate, probe = null, name = "", listed = false }) {
  if (res.error === "robots") return { verdict: "miss", why: "robots" };
  if (RETRY_STATUS.has(res.status) || res.status >= 500) return { verdict: "retry", why: res.error || `http ${res.status}` };
  if (res.status !== 200) return { verdict: "miss", why: `http ${res.status}` };
  if (!isHtml(res.type)) return { verdict: "miss", why: `not html (${res.type || "no content type"})` };
  let final;
  try {
    final = new URL(res.finalUrl || candidate);
  } catch {
    return { verdict: "miss", why: "unparsable final url" };
  }
  const want = new URL(candidate);
  if (hostOf(final) !== hostOf(want)) return { verdict: "miss", why: `moved to ${final.hostname}` };
  if (pathOf(final) === "/") return { verdict: "miss", why: "redirect to the site root" };
  if (pathOf(final) !== pathOf(want)) return { verdict: "miss", why: `redirect to ${final.pathname}` };
  if (NOT_FOUND_TITLE.test(res.title || "") && !NOT_FOUND_NAME.test(name)) return { verdict: "miss", why: `not-found title "${res.title}"` };
  const guarded = probe?.state === "blind" || (probe?.state === "soft" && res.title === probe.title);
  if (guarded && !listed) return { verdict: "miss", why: probe.state === "blind" ? `soft-404: ${probe.why}` : "soft-404: probe title" };
  return { verdict: "pass", why: guarded ? "ok (sitemap-listed)" : "ok" };
}

// ---------------------------------------------------------------- robots.txt (pure)

/** Allow/Disallow rules of the groups for `*` (and for our own UA token): [{ allow, path }]. */
export function parseRobots(text) {
  const rules = [];
  let agents = [];
  let inRules = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      inRules = true;
      if (!value || !agents.some((a) => a === "*" || a.includes("design-tools"))) continue;
      rules.push({ allow: key === "allow", path: value });
    }
  }
  return rules;
}

const ruleRegex = (path) =>
  new RegExp(
    "^" +
      path
        .replace(/\$$/, "\u0000")
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace("\u0000", "$"),
  );

/** Longest matching rule wins, Allow wins a tie; no matching rule = allowed. `path` includes the query. */
export function robotsAllows(rules, path) {
  let best = null;
  for (const r of rules) {
    if (!ruleRegex(r.path).test(path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------- sitemap carve-out

/** www-less host + decoded path without a trailing slash + query: how a candidate and a sitemap loc are compared. */
export function sitemapKey(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return `${hostOf(u)}${pathOf(u)}${u.search}`;
}

/**
 * `listed(url)` → true when the sitemap of the entry's corpus folder, or of the corpus folder of the url's host
 * (as is, or without/with `www.`), lists it. Sitemaps are read once each; `readSitemap(folder)` is the seam.
 */
export function createSitemapIndex(domain, { readSitemap = readSitemapFile } = {}) {
  const folders = new Map(); // folder → Set(key)
  const keysOf = (folder) => {
    if (!folders.has(folder)) {
      const urls = readSitemap(folder)?.urls || [];
      folders.set(folder, new Set(urls.map((x) => (typeof x === "string" ? x : x?.loc ?? x?.url)).filter((l) => typeof l === "string").map(sitemapKey).filter(Boolean)));
    }
    return folders.get(folder);
  };
  return (url) => {
    const key = sitemapKey(url);
    if (!key) return false;
    const host = new URL(url).hostname.toLowerCase();
    const bare = host.replace(/^www\./, "");
    return [...new Set([domain, host, bare, `www.${bare}`])].some((f) => keysOf(f).has(key));
  };
}

function readSitemapFile(folder) {
  if (!DOMAIN.test(folder)) return null;
  const f = sitemapFile(folder);
  if (!existsSync(f)) return null;
  try {
    const j = loadJSON(f);
    return j && Array.isArray(j.urls) ? j : null;
  } catch (e) {
    console.error(`warn: ${f}: ${e.message} — no sitemap carve-out from it`);
    return null;
  }
}

// ---------------------------------------------------------------- resume (pure)

/**
 * Which items a run checks. A cache with another config hash (or `force`) starts over; otherwise only ids missing
 * from `results` are checked. → { results (the ones kept), todo, fresh }.
 */
export function planRun(targets, cache, hash, { force = false } = {}) {
  const fresh = force || !cache || cache.config_hash !== hash || !cache.results || typeof cache.results !== "object";
  const results = fresh ? {} : { ...cache.results };
  return { results, todo: targets.filter((i) => !Object.hasOwn(results, i.id)), fresh };
}

// ---------------------------------------------------------------- network

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One page: the Scrapling client for an enabled host (as tools/patterns.mjs does), plain `fetch` otherwise. */
export async function getPage(url, via = scraplingClient) {
  try {
    const scraped = await via?.get(url);
    if (scraped) {
      if (scraped.error) return { status: 0, type: "", finalUrl: url, title: "", text: "", error: scraped.error };
      const type = scraped.content_type || "";
      const text = scraped.status === 200 && scraped.body ? scraped.body.toString("utf8") : "";
      return { status: scraped.status, type, finalUrl: scraped.final_url || url, title: isHtml(type) ? pageTitle(text) : "", text };
    }
  } catch (e) {
    console.error(`warn: scrapling ${url}: ${e?.message || e} — falling back to fetch`);
  }
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: ACCEPT },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const type = res.headers.get("content-type") || "";
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, type, finalUrl: res.url || url, title: "", text: "" };
    }
    const text = await res.text();
    return { status: res.status, type, finalUrl: res.url || url, title: isHtml(type) ? pageTitle(text) : "", text };
  } catch (e) {
    const aborted = e?.name === "AbortError" || e?.name === "TimeoutError";
    return { status: 0, type: "", finalUrl: url, title: "", text: "", error: aborted ? "timeout" : String(e?.message || e) };
  }
}

/**
 * Paced fetching for one run: ≤ 1 request per `interval` ms per host, robots.txt read once per host, a host stopped
 * after `maxBad` 403/429 answers in a row (or when its robots.txt can't be read). `get`, `sleep`, `now` are seams.
 * `scope()` is the same fetcher with its own request count and host list (one per domain of a parallel run).
 */
export function createFetcher({ get = getPage, wait = sleep, now = Date.now, interval = HOST_INTERVAL, maxBad = MAX_BAD } = {}) {
  const hosts = new Map(); // host → { chain, last, bad, stopped, robots }
  let requests = 0;
  const state = (host) => {
    let s = hosts.get(host);
    if (!s) hosts.set(host, (s = { chain: Promise.resolve(), last: -Infinity, bad: 0, stopped: "", robots: null }));
    return s;
  };
  function request(url, counter = null) {
    const host = new URL(url).host;
    const s = state(host);
    counter?.hosts.add(host);
    const run = s.chain.then(async () => {
      if (s.stopped) return { status: 0, type: "", finalUrl: url, title: "", error: `host stopped (${s.stopped})` };
      const gap = s.last + interval - now();
      if (gap > 0) await wait(gap);
      s.last = now();
      requests++;
      if (counter) counter.n++;
      const res = await get(url);
      if (res.status === 403 || res.status === 429) {
        if (++s.bad >= maxBad) s.stopped = `${maxBad}× ${res.status} in a row`;
      } else if (res.status) s.bad = 0;
      return res;
    });
    s.chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  /** true / false, or "retry" when robots.txt could not be read (the host is then stopped for this run). */
  async function allowed(url, counter = null) {
    const u = new URL(url);
    const s = state(u.host);
    counter?.hosts.add(u.host);
    s.robots ??= request(`${u.origin}/robots.txt`, counter).then((r) => {
      if (r.status === 200 && !isHtml(r.type)) return parseRobots(r.text);
      if (r.status === 200 || (r.status >= 400 && r.status < 500 && !RETRY_STATUS.has(r.status))) return []; // html (an app shell) or 4xx: no rules
      s.stopped ||= `robots.txt unreadable (${r.error || `http ${r.status}`})`;
      return null;
    });
    const rules = await s.robots;
    if (!rules) return "retry";
    return robotsAllows(rules, u.pathname + u.search);
  }
  const stoppedOf = (names) => [...names].filter((h) => hosts.get(h)?.stopped).map((h) => `${h}: ${hosts.get(h).stopped}`);
  return {
    request,
    allowed,
    requests: () => requests,
    stopped: () => stoppedOf(hosts.keys()),
    scope() {
      const counter = { n: 0, hosts: new Set() };
      return { request: (url) => request(url, counter), allowed: (url) => allowed(url, counter), requests: () => counter.n, stopped: () => stoppedOf(counter.hosts) };
    },
  };
}

/**
 * Check `todo` items in order against their candidates. A pass records the url, all-miss records null, and a
 * retry-class answer (or a stopped host) leaves the item out so the next run checks it. Pages and probes are
 * fetched once per run even when several items share them (group pages). Mutates and returns `results`.
 */
export async function verifyItems(todo, cfg, { fetcher, results = {}, listed = () => false, log = () => {}, progress = () => {} } = {}) {
  const stats = { tried: 0, found: 0, misses: 0, excluded: 0, unfinished: 0, soft404: 0, sitemap_listed: 0 };
  const pages = new Map(); // url → Promise<res> (without the body)
  const probes = new Map(); // probe url → Promise<probeState>
  const page = (url) => {
    if (!pages.has(url)) pages.set(url, fetcher.request(url).then(({ text, ...res }) => res));
    return pages.get(url);
  };
  const probeOf = (url) => {
    if (!probes.has(url))
      probes.set(
        url,
        fetcher.allowed(url).then((ok) => {
          if (ok === "retry") return { state: "retry", why: "robots.txt unreadable" };
          if (!ok) return probeState({ status: 0, error: "robots" }, url);
          return fetcher.request(url).then((r) => probeState(r, url));
        }),
      );
    return probes.get(url);
  };
  for (const [n, item] of todo.entries()) {
    if (n && n % 100 === 0) progress(n, stats);
    const name = registryName(item);
    const list = candidateList(name, cfg);
    if (!list.length) {
      if (isExcluded(name, cfg)) stats.excluded++;
      else stats.misses++;
      results[item.id] = null;
      continue;
    }
    stats.tried++;
    let outcome = "miss";
    for (const { url: candidate, template } of list) {
      const ok = await fetcher.allowed(candidate);
      if (ok === "retry") {
        outcome = "retry";
        break;
      }
      if (!ok) {
        log(`  ${item.id}: ${candidate} — miss (robots.txt)`);
        continue;
      }
      const pUrl = probeUrl(name, template, cfg);
      const probe = pUrl ? await probeOf(pUrl) : { state: "blind", why: "no probe url" };
      if (probe?.state === "retry") {
        outcome = "retry";
        break;
      }
      const res = await page(candidate);
      const v = judge(res, { candidate, probe, name, listed: listed(candidate) });
      log(`  ${item.id}: ${candidate} — ${v.verdict} (${v.why})${res.title ? ` "${res.title}"` : ""}`);
      if (v.why.startsWith("soft-404")) stats.soft404++;
      if (v.verdict === "pass") {
        if (v.why === "ok (sitemap-listed)") stats.sitemap_listed++;
        outcome = candidate;
        break;
      }
      if (v.verdict === "retry") {
        outcome = "retry";
        break;
      }
    }
    if (outcome === "retry") stats.unfinished++;
    else if (outcome === "miss") {
      stats.misses++;
      results[item.id] = null;
    } else {
      stats.found++;
      results[item.id] = outcome;
    }
  }
  return { results, stats };
}

// ---------------------------------------------------------------- runs

/** The url-less registry items a config applies to, as the build sees them before the template cache. */
export function targetsOf(domain, cfg, entries) {
  const parent = parentsByDomain(entries).get(domain);
  if (!parent) throw new Error(`${domain}: no catalog entry is the parent of this corpus folder`);
  const built = buildItems(entries, { only: domain, templateUrls: false }).get(parent.id) || [];
  const registry = built.filter((i) => i.from === "registry");
  const types = cfg.types || DEFAULT_TYPES;
  return { parent, registry, targets: registry.filter((i) => !i.url && types.includes(i.type)) };
}

async function verifyDomain(domain, entries, { force, fetcher: shared }) {
  const t0 = Date.now();
  const cfg = loadRegistryUrlConfig(domain);
  if (!cfg) return { domain, error: `no catalog/registry-urls/${domain}.json` };
  if (cfg.skip) return { domain, skip: cfg.skip };
  const { registry, targets } = targetsOf(domain, cfg, entries);
  const file = registryUrlsFile(domain);
  let cache = null;
  try {
    cache = loadJSON(file);
  } catch (e) {
    console.error(`warn: ${file}: ${e.message} — starting over`);
  }
  const hash = configHash(cfg);
  const plan = planRun(targets, cache, hash, { force });
  const fetcher = shared.scope();
  console.error(`${domain}: checking ${plan.todo.length} of ${targets.length} url-less items${plan.fresh ? "" : " (resume)"}`);
  const progress = (n, s) => console.error(`  ${domain}: ${n}/${plan.todo.length} · ${s.found} found · ${s.misses} misses · ${s.unfinished} unfinished`);
  const { results, stats } = await verifyItems(plan.todo, cfg, { fetcher, results: plan.results, listed: createSitemapIndex(domain), progress });
  const keep = new Set(registry.map((i) => i.id)); // ids that left the registry drop out
  const kept = Object.fromEntries(Object.entries(results).filter(([id]) => keep.has(id)).sort(([a], [b]) => (a < b ? -1 : 1)));
  const urls = Object.values(kept).filter((u) => typeof u === "string").length;
  const run = { ...stats, requests: fetcher.requests(), stopped_hosts: fetcher.stopped(), seconds: Math.round((Date.now() - t0) / 1000) };
  saveJSON(file, {
    checked_at: new Date().toISOString(),
    config_hash: hash,
    results: kept,
    stats: { targets: targets.length, urls, nulls: Object.keys(kept).length - urls, unchecked: targets.filter((i) => !Object.hasOwn(kept, i.id)).length, last_run: run },
  });
  return { domain, targets: targets.length, todo: plan.todo.length, fresh: plan.fresh, urls, ...run };
}

export function configDomains() {
  if (!existsSync(CONFIG_DIR)) return [];
  return readdirSync(CONFIG_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

async function cmdVerify(domains, { force }) {
  const entries = loadJSON(FILE.catalog)?.items || [];
  const fetcher = createFetcher();
  const rows = await pool(domains, HOSTS_AT_ONCE, async (domain) => {
    try {
      return await verifyDomain(domain, entries, { force, fetcher });
    } catch (e) {
      return { domain, error: e.message };
    }
  });
  await scraplingClient.close();
  for (const r of rows) {
    if (r.error) console.log(`${r.domain}: error — ${r.error}`);
    else if (r.skip) console.log(`${r.domain}: skip — ${r.skip}`);
    else
      console.log(
        `${r.domain}: ${r.targets} url-less items · checked ${r.todo}${r.fresh ? " (fresh)" : " (resume)"} · tried ${r.tried} · urls found ${r.found} · misses ${r.misses} · excluded ${r.excluded} · soft-404 hits ${r.soft404} · sitemap carve-out ${r.sitemap_listed} · unfinished ${r.unfinished} · stopped hosts ${r.stopped_hosts.length ? r.stopped_hosts.join("; ") : "none"} · requests ${r.requests} · ${r.seconds}s · cache now ${r.urls} urls`,
      );
  }
  const stopped = fetcher.stopped();
  console.log(`all domains: stopped hosts ${stopped.length ? stopped.join("; ") : "none"} · requests ${fetcher.requests()}`);
  if (rows.some((r) => r.error)) process.exitCode = 1;
}

/** Up to `n` items whose names differ in shape (rewrite hit, number of parts, digits, excluded), then any. */
export function shapeSample(items, cfg, n = 5) {
  const shape = (name) =>
    [isExcluded(name, cfg), (cfg.rewrite || []).map(([re]) => +new RegExp(re).test(name)).join(""), name.split(/[-_/]/).length, /\d/.test(name)].join("|");
  const seen = new Set();
  const out = [];
  for (const i of items) {
    const k = shape(registryName(i));
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
    if (out.length === n) return out;
  }
  for (const i of items) if (out.length < n && !out.includes(i)) out.push(i);
  return out;
}

async function cmdCheck(domain) {
  const cfg = loadRegistryUrlConfig(domain);
  if (!cfg) {
    console.error(`no catalog/registry-urls/${domain}.json`);
    process.exit(1);
  }
  if (cfg.skip) {
    console.log(`${domain}: skip — ${cfg.skip}`);
    return;
  }
  const entries = loadJSON(FILE.catalog)?.items || [];
  const { targets } = targetsOf(domain, cfg, entries);
  const excluded = targets.filter((i) => isExcluded(registryName(i), cfg)).length;
  console.log(`${domain}: config ok · ${cfg.templates.length} template(s) · ${(cfg.rewrite || []).length} rewrite(s) · ${targets.length} url-less items (${excluded} excluded) · hash ${configHash(cfg)}`);
  for (const i of shapeSample(targets, cfg)) {
    const name = registryName(i);
    const list = candidates(name, cfg);
    console.log(`  ${name} → ${list.length ? list.join("  |  ") : isExcluded(name, cfg) ? "(excluded)" : "(no candidate)"}`);
  }
  const pick = targets.filter((i) => candidates(registryName(i), cfg).length).sort(() => Math.random() - 0.5).slice(0, 10);
  console.log(`live check of ${pick.length} random items (nothing written):`);
  const fetcher = createFetcher();
  const { stats } = await verifyItems(pick, cfg, { fetcher, listed: createSitemapIndex(domain), log: (l) => console.log(l) });
  await scraplingClient.close();
  console.log(`found ${stats.found}/${pick.length} · misses ${stats.misses} · soft-404 hits ${stats.soft404} · sitemap carve-out ${stats.sitemap_listed} · unfinished ${stats.unfinished} · requests ${fetcher.requests()}${fetcher.stopped().length ? ` · stopped: ${fetcher.stopped().join("; ")}` : ""}`);
}

// ---------------------------------------------------------------- cli

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const a = args.find((x) => x === flag);
    if (a) return args[args.indexOf(a) + 1];
    const eq = args.find((x) => x.startsWith(`${flag}=`));
    return eq ? eq.slice(flag.length + 1) : null;
  };
  const force = args.includes("--force");
  try {
    if (args.includes("--verify") && value("--verify")) await cmdVerify([...new Set(value("--verify").split(",").map((d) => d.trim()).filter(Boolean))], { force });
    else if (args.includes("--all")) await cmdVerify(configDomains(), { force });
    else if (args.includes("--check") && value("--check")) await cmdCheck(value("--check"));
    else {
      console.log(`usage:
  bun tools/registry-urls.mjs --verify <domain>[,<domain>…] [--force]
  bun tools/registry-urls.mjs --all [--force]
  bun tools/registry-urls.mjs --check <domain>`);
      process.exit(1);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

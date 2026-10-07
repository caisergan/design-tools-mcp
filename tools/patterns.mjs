#!/usr/bin/env bun
// Pattern guesser + filter-page fetcher (MCP-PLAN 6.2). Deterministic, no LLM.
//   bun tools/patterns.mjs --suggest <domain>                     what the sitemap could be read as, writes nothing
//   bun tools/patterns.mjs --auto briefs/phase-6/sites/auto-sites.tsv   write high-confidence auto patterns
//   bun tools/patterns.mjs --check <domain>                       items, elements, variants, samples of one pattern
//   bun tools/patterns.mjs --fetch-filters [--only=<domain>] [--refresh]
// Network is only touched by --fetch-filters (≤ 2 req/s per host).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { saveJSON, saveText, loadJSON, FILE, slug } from "./lib.mjs";
import { TAXONOMY, tagItem, loadTagOverrides } from "./tag.mjs";
import { COMPONENT_SEGMENT, LOCALE, SKIP_SEGMENT, buildItems, parentsByDomain } from "./items.mjs";
import { PATTERNS_DIR, compilePattern, elementIndex, filterFile, filterJobs, hrefs, humanise, loadFilters, loadPattern, loadSitemap, matchingLinks, pathSegments, patternFile, renderFile, sitemapScan, sourceDomainOf } from "./sitemap-items.mjs";
import { scraplingClient } from "./scrapling-backend.mjs";

const UA = "Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)";

/** Listing/taxonomy pages are not items; a region locale segment (ko-kr, en-us) is a locale copy. */
const LISTING_SEGMENT = /^(tags?|categories|category|cat|collections?|topics?)$/i;
const REGION = /^[a-z]{2}-[a-z]{2}$/i;

// ---------------------------------------------------------------- guesser

const tagElements = (domain, child, overrides, taxonomy) =>
  tagItem({ reg: domain, name: child, title: humanise(child), type: "" }, { overrides, taxonomy }).elements;

/**
 * Group sitemap URLs by path prefix, the last segment being `{name}`; for deeper paths the last two segments are
 * tried too (`…/{name}/{n}` when the leaf is a number, `…/{element}/{n}` when the middle segment is an element).
 * Returns the groups with ≥ minChildren children, plus (small sites) 3–9 children under a component-like prefix,
 * most children first. Writes nothing.
 */
export function suggest(sitemap, { domain, taxonomy = TAXONOMY, overrides = loadTagOverrides(), minChildren = 10 } = {}) {
  const { bySlug } = elementIndex(taxonomy);
  const host = domain.replace(/^www\./, "");
  // key → { mode: "A"|"N"|"S", dir, entries: Map(url → name part) }
  const groups = new Map();
  const add = (mode, dir, name, url) => {
    const key = `${mode}:${dir}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { mode, dir, entries: new Map() }));
    if (!g.entries.has(url)) g.entries.set(url, name);
  };
  for (const u of sitemap?.urls || []) {
    let url;
    try {
      url = new URL(u?.loc ?? u?.url);
    } catch {
      continue;
    }
    if (url.hostname.replace(/^www\./, "") !== host) continue;
    const segs = pathSegments(url.pathname);
    if (!segs.length) continue;
    const last = segs[segs.length - 1];
    if (!slug(last) || /\.[a-z0-9]{2,4}$/i.test(last)) continue; // junk or files (.xml, .jpg, .html …)
    const loc = url.toString();
    if (!/^\d+$/.test(last)) add("A", segs.slice(0, -1).join("/"), last, loc); // /dir/{name}
    if (segs.length >= 3) {
      const mid = segs[segs.length - 2];
      const digitLeaf = /^\d+$/.test(last);
      // /dir2/{name or element}/{n} · only when the leaf is a number or the middle segment is an element already
      if (digitLeaf || bySlug.has(slug(mid))) add(digitLeaf ? "N" : "S", segs.slice(0, -2).join("/"), mid, loc);
    }
  }

  const rows = [];
  for (const g of groups.values()) {
    const entries = [...g.entries.entries()]; // [url, name]
    const names = [...new Set(entries.map(([, name]) => name))];
    const allElements = names.every((c) => bySlug.has(slug(c)));
    const template = g.mode === "A" ? `/${g.dir}/{name}` : `/${g.dir}/{${allElements ? "element" : "name"}}/${g.mode === "N" ? "{n}" : "{*}"}`;
    const literals = template.split("/").filter((s) => s && !/^\{[^}]*\}$/.test(s));
    const meta = literals.find((s) => LOCALE.test(s) || REGION.test(s) || SKIP_SEGMENT.test(s));
    const last = literals[literals.length - 1];
    const listing = !!last && LISTING_SEGMENT.test(last);
    const componentLike = !!last && (COMPONENT_SEGMENT.test(last) || bySlug.has(slug(last)));
    // small sites: a 3–9-child prefix is still a candidate when the prefix itself is component-like
    const small = entries.length < minChildren;
    if (small && !(entries.length >= 3 && componentLike)) continue;
    let tagged = 0;
    for (const name of names) if (tagElements(domain, name, overrides, taxonomy).length) tagged++;
    const elemPct = Math.round((100 * tagged) / names.length);
    let why;
    if (meta) why = `meta segment "${meta}"`;
    else if (!literals.length) why = "no literal prefix segment";
    else if (listing) why = `prefix "${last}" is a tag/category/collection listing, not items`;
    else if (small && elemPct < 60) why = `only ${entries.length} children and ${elemPct}% of them tag to an element`;
    else if (componentLike) why = `prefix "${last}" is a component segment or an element`;
    else if (elemPct >= 30) why = `${elemPct}% of children tag to an element`;
    else why = `prefix "${last}" is neither component-like nor element-tagged (${elemPct}%)`;
    const high = !meta && !listing && literals.length > 0 && (small ? elemPct >= 60 : componentLike || elemPct >= 30);
    rows.push({
      template,
      prefix: template.replace(/\/?\{[^}]*\}.*$/, ""),
      children: entries.length,
      elemPct,
      samples: entries.slice(0, 5).map(([url]) => url),
      high,
      why,
    });
  }
  return rows.sort((a, b) => b.children - a.children || (a.template < b.template ? -1 : 1));
}

function cmdSuggest(domain) {
  const sitemap = loadSitemap(domain);
  if (!sitemap) {
    console.error(`no catalog/corpus/sites/${domain}/sitemap.json (yet)`);
    process.exit(1);
  }
  const rows = suggest(sitemap, { domain });
  console.log(`${domain}: ${sitemap.urls.length} sitemap URLs${sitemap.truncated ? " (truncated)" : ""} · ${rows.length} candidate prefix groups`);
  for (const r of rows)
    console.log(
      `${r.high ? "HIGH" : "low "} ${r.template} · ${r.children} children · ${r.elemPct}% element-tagged · ${r.why}\n     ${r.samples.join("\n     ")}`,
    );
  if (!rows.length) console.log("  (no prefix with 10+ children, and none of 3–9 under a component prefix)");
}

// ---------------------------------------------------------------- --auto

export function parseDomainList(text) {
  const rows = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("\t"));
  return rows.filter((r) => r.length > 1 && r[0] !== "entry_id").map((r) => r[1].trim()).filter(Boolean);
}

function cmdAuto(file) {
  if (!existsSync(file)) {
    console.error(`list not found: ${file}`);
    process.exit(1);
  }
  const domains = parseDomainList(readFileSync(file, "utf8"));
  const written = [];
  const queued = [];
  let existing = 0;
  for (const domain of domains) {
    if (existsSync(patternFile(domain))) {
      existing++;
      continue;
    }
    const sitemap = loadSitemap(domain);
    if (!sitemap || !sitemap.urls.length) {
      queued.push({ domain, reason: "no sitemap.json", top_prefixes: [] });
      continue;
    }
    const rows = suggest(sitemap, { domain });
    const high = rows.filter((r) => r.high);
    if (!high.length) {
      queued.push({
        domain,
        reason: rows.length ? `no high-confidence prefix (${rows.length} candidates)` : "no prefix with 10+ children, and none of 3–9 under a component prefix",
        top_prefixes: rows.slice(0, 3).map((r) => ({ template: r.template, children: r.children, elem_pct: r.elemPct })),
      });
      continue;
    }
    const match = high.slice(0, 8).map((r) => r.template);
    saveJSON(patternFile(domain), {
      match,
      granularity: "page",
      access: "page",
      status: "auto",
      note: `guesser: ${high
        .slice(0, 8)
        .map((r) => `${r.template} (${r.children} children, ${r.elemPct}% element-tagged)`)
        .join("; ")}`,
    });
    written.push({ domain, templates: match.length, children: high.reduce((n, r) => n + r.children, 0) });
  }
  // review queue: keep entries for domains this run did not see, replace the ones it did
  const reviewFile = "catalog/patterns-review.json";
  const seen = new Set([...written.map((w) => w.domain), ...queued.map((q) => q.domain)]);
  const prev = loadJSON(reviewFile, []);
  const merged = [...prev.filter((r) => r?.domain && !seen.has(r.domain)), ...queued].sort((a, b) => (a.domain < b.domain ? -1 : 1));
  saveJSON(reviewFile, merged);
  console.log(`--auto ${file}: ${domains.length} domains · pattern files written ${written.length} · queued for review ${queued.length} · already had a pattern ${existing}`);
  for (const w of written.slice(0, 40)) console.log(`  wrote ${w.domain}: ${w.templates} template(s), ${w.children} urls`);
  const byReason = {};
  for (const q of queued) byReason[q.reason.replace(/\d+/g, "#")] = (byReason[q.reason.replace(/\d+/g, "#")] || 0) + 1;
  for (const [reason, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`  queued ${n}× ${reason}`);
  console.log(`-> ${reviewFile} (${merged.length} entries)`);
}

// ---------------------------------------------------------------- --check

function cmdCheck(domain) {
  const pattern = loadPattern(domain); // strict: a broken pattern is an error
  if (!pattern) {
    console.error(`no catalog/patterns/${domain}.json`);
    process.exit(1);
  }
  if (pattern.skip) {
    console.log(`${domain}: skip — ${pattern.skip}`);
    return;
  }
  const entries = loadJSON(FILE.catalog)?.items || [];
  const parent = parentsByDomain(entries).get(domain);
  if (!parent) {
    console.error(`${domain}: no catalog entry is the parent of this corpus folder`);
    process.exit(1);
  }
  const sitemap = loadSitemap(domain);
  const filters = loadFilters(domain, pattern, { quiet: false });
  const src = sourceDomainOf(domain, pattern);
  for (const e of filters.empty) console.error(`warn: ${domain}: filter page ${e.kind} "${e.key}" yielded 0 matching links (JS-rendered, or not fetched yet)`);
  const scan = sitemapScan(domain, parent, { pattern, sitemap, filters, taken: new Map() });
  const built = buildItems(entries).get(parent.id) || [];
  const items = built.filter((i) => i.from === "sitemap");
  const withEl = items.filter((i) => i.elements.length).length;
  const variants = {};
  for (const i of items) for (const [el, vs] of Object.entries(i.variants || {})) for (const v of vs) variants[`${el}:${v}`] = (variants[`${el}:${v}`] || 0) + 1;
  const vlist = Object.entries(variants).sort((a, b) => b[1] - a[1]);
  console.log(
    `${domain}${src === domain ? "" : ` → source ${src}`}: pattern ${pattern.status}${pattern.render ? " · render" : ""}${pattern.source_domain ? ` · source_domain ${pattern.source_domain}` : ""} · match ${JSON.stringify(pattern.match)}${pattern.element ? ` · element ${pattern.element}` : ""} · granularity ${pattern.granularity || "page"}`,
  );
  console.log(
    `${sitemap ? `${sitemap.urls.length} sitemap URLs` : "no sitemap"}${filters.urls.length ? ` + ${filters.urls.length} urls_from links` : ""}${filters.anchors.length ? ` + ${filters.anchors.length} anchors_from sections` : ""} → ${scan.candidates} candidates · ${scan.matched} matched · ${items.length} items (${scan.skipped} skipped as duplicates) · ${withEl} with an element (${items.length ? Math.round((100 * withEl) / items.length) : 0}%)`,
  );
  console.log(`elements: ${[...new Set(items.flatMap((i) => i.elements))].sort().join(", ") || "— none —"}`);
  console.log(`variants: ${vlist.length ? vlist.map(([k, n]) => `${k} ${n}`).join(" · ") : "— none —"}`);
  for (const i of items.slice(0, 8)) console.log(`  ${i.id}  ${i.name}  [${i.elements.join(",")}] ${JSON.stringify(i.variants)}  ${i.url}`);
}

// ---------------------------------------------------------------- render (headless Chrome)

const RENDER_SESSION = "catalog-render";
const RENDER_WAIT_MS = 3000; // the CLI's `wait`: client-rendered pages need a beat after `open`
const RENDER_PACE = 1000; // ms between rendered pages of one host
const AXI = "chrome-devtools-axi";

/** Runs inside the page (via the CLI's `eval`): absolute links + in-page sections. Mirrors `extractAnchors`. */
function browseScript() {
  const junk = (id) => {
    if (!id || id.length > 80) return true;
    if (/^(top|main|content|nav|footer|header|root|__next|app)$/i.test(id)) return true;
    if (/^(?:radix-|headlessui-|react-|mui-|base-ui-|reka-|aria-|:r)/i.test(id)) return true;
    const core = id.replace(/[^a-z0-9]/gi, "");
    if (!/[a-z]/i.test(core)) return true;
    if ((core.match(/\d/g) || []).length / core.length > 0.5) return true;
    return /^[0-9a-f]{12,}$/i.test(core);
  };
  const text = (el) => (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const links = [];
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href;
    if (/^https?:/i.test(href) && href.indexOf("#") < 0 && links.indexOf(href) < 0) links.push(href);
  }
  const anchors = [];
  const seen = {};
  const add = (id, name) => {
    if (!id || seen[id] || junk(id)) return;
    seen[id] = true;
    anchors.push({ id, text: name || "" });
  };
  for (const el of document.querySelectorAll("[id]")) {
    const tag = el.tagName.toLowerCase();
    let heading = null;
    if (/^h[1-4]$/.test(tag)) heading = el;
    else if (tag === "section" || tag === "article" || tag === "div") heading = el.querySelector("h1,h2,h3,h4");
    if (heading) add(el.id, text(heading));
  }
  for (const a of document.querySelectorAll('a[href^="#"]')) {
    let id = (a.getAttribute("href") || "").slice(1);
    try {
      id = decodeURIComponent(id);
    } catch (e) {
      /* keep the raw id */
    }
    if (!id) continue;
    if (seen[id]) {
      for (const row of anchors)
        if (row.id === id && !row.text) {
          row.text = text(a);
          break;
        }
      continue;
    }
    add(id, text(a));
  }
  return JSON.stringify({ links, anchors });
}

async function axi(args, timeout = 90_000) {
  const env = { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: RENDER_SESSION };
  const proc = Bun.spawn([AXI, ...args], { env, stdout: "pipe", stderr: "pipe", timeout, killSignal: "SIGKILL" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

/** `eval` prints `result: "<JSON string>"` — the value is JSON-encoded once or twice more by the CLI. */
export function parseEvalResult(out) {
  const line = String(out || "")
    .split("\n")
    .find((l) => l.trimStart().startsWith("result:"));
  if (!line) return null;
  let value = line.slice(line.indexOf("result:") + "result:".length).trim();
  for (let i = 0; i < 5; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return null;
  }
  return null;
}

/** One page through headless Chrome → the cache object; throws when the CLI or the page fails. */
export async function renderPage(url) {
  const opened = await axi(["open", url]);
  if (opened.code !== 0) throw new Error(`open failed: ${(opened.err || opened.out).trim().split("\n")[0] || `exit ${opened.code}`}`);
  const waited = await axi(["wait", String(RENDER_WAIT_MS)], RENDER_WAIT_MS + 30_000);
  if (waited.code !== 0) console.error(`warn: ${AXI} wait failed for ${url}: ${(waited.err || waited.out).trim().split("\n")[0]}`);
  // `--full`: without it the CLI truncates a result bigger than ~8 kB mid-JSON (animista's link list)
  const ev = await axi(["eval", `(${browseScript.toString()})()`, "--full"], 60_000);
  if (/Result was truncated/i.test(ev.out)) throw new Error("eval output was truncated by chrome-devtools-axi");
  const parsed = parseEvalResult(ev.out);
  if (!parsed) throw new Error(`eval returned no parsable result (exit ${ev.code})`);
  return { url, fetched_at: new Date().toISOString(), links: parsed.links || [], anchors: parsed.anchors || [] };
}

const stopRenderer = async () => {
  try {
    await axi(["stop"], 20_000);
  } catch {
    /* no session to stop */
  }
};

// ---------------------------------------------------------------- --fetch-filters

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE = 500; // ms between requests → ≤ 2 req/s per host

/**
 * One filter page: the opt-in Scrapling backend when the host is enabled (brief 11), plain `fetch` otherwise.
 * Same result shape either way — `{ok, status, type, body}` (plus `error` for a backend refusal such as robots).
 */
export async function get(url, via = scraplingClient) {
  try {
    const scraped = await via?.get(url);
    if (scraped) {
      const ok = !scraped.error && scraped.status >= 200 && scraped.status < 300;
      return {
        ok,
        status: scraped.status,
        type: scraped.content_type || "",
        body: scraped.body ? scraped.body.toString("utf8") : "",
        ...(scraped.error ? { error: scraped.error } : {}),
      };
    }
  } catch (e) {
    console.error(`warn: scrapling ${url}: ${e?.message || e} — falling back to fetch`);
  }
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(20_000) });
  const body = res.ok ? await res.text() : "";
  return { ok: res.ok, status: res.status, type: res.headers.get("content-type") || "", body };
}

/** The link to page `n` of the same listing, when the page states it plainly (`?page=2`, Webflow `?ab12_page=2`). */
export function nextPageUrl(html, base, n) {
  const baseUrl = new URL(base);
  const want = String(n);
  for (const href of hrefs(html, base)) {
    let u;
    try {
      u = new URL(href);
    } catch {
      continue;
    }
    if (u.hostname.replace(/^www\./, "") !== baseUrl.hostname.replace(/^www\./, "")) continue;
    if (u.pathname.replace(/\/+$/, "") !== baseUrl.pathname.replace(/\/+$/, "")) continue;
    if ([...u.searchParams].some(([k, v]) => /(^|_)page$/i.test(k) && v === want)) return u.toString();
  }
  return null;
}

/** Page `n` of a `paginate` job: the same path at `?<param>=<n>`, merged into any query the path already has. */
export function pageUrl(base, param, page) {
  if (page <= 1) return base;
  const u = new URL(base);
  u.searchParams.set(param, String(page));
  return u.toString();
}

/**
 * One filter job → its cached pages, in `filters/<prefix>-<key>.html`, `.2`, `.3` … A `paginate` pattern walks
 * `<path>?<param>=2,3,…` up to `max` pages and stops at the first page that adds **no new** link matching the
 * pattern (an out-of-range page repeats the last one or comes back empty); without it, the page's own
 * "next page" link decides, ≤ 20 pages. `deps` are the seams tests replace (`get`, `exists`, `readFile`, `save`, `pace`).
 */
export async function fetchFilterJob(job, { domain, src, pattern, compiled = compilePattern(pattern), refresh = false, deps = {} } = {}) {
  const {
    get: getPage = get,
    exists = existsSync,
    readFile = (p) => readFileSync(p, "utf8"),
    save = saveText,
    pace = () => sleep(PACE),
    log = console.log,
    warn = console.error,
  } = deps;
  const out = { fetched: 0, cached: 0, failed: 0, pages: 0, stop: "" };
  const paginate = job.kind === "anchors" ? null : pattern.paginate || null;
  const max = paginate ? paginate.max : 20;
  const seen = new Set(); // paginate: every matching link the job has produced so far
  let next = job.url;
  for (let page = 1; page <= max && next; page++) {
    const url = next;
    const file = filterFile(src, job.kind, job.key, page);
    let html;
    if (exists(file) && !refresh) {
      html = readFile(file);
      out.cached++;
    } else {
      await pace();
      try {
        const res = await getPage(url);
        if (!res.ok) {
          warn(`warn: ${domain} ${job.kind} "${job.key}" page ${page}: HTTP ${res.status}${res.error ? ` (${res.error})` : ""} — ${url}`);
          out.failed++;
          break;
        }
        html = res.body;
        save(file, html);
        out.fetched++;
        log(`${domain} ${job.kind}:${job.key} page ${page} → ${file.replace(/^.*catalog\/corpus\//, "corpus/")} (${(html.length / 1024).toFixed(0)} kB)`);
      } catch (e) {
        warn(`warn: ${domain} ${job.kind} "${job.key}" page ${page}: ${e.message}`);
        out.failed++;
        break;
      }
    }
    out.pages = page;
    if (job.kind === "anchors") {
      next = null;
    } else if (paginate) {
      const links = matchingLinks(html, url, src, compiled);
      const added = [...links].filter((u) => !seen.has(u)).length;
      for (const u of links) seen.add(u);
      if (page > 1 && !added) {
        out.stop = "no-new-links";
        break;
      }
      next = pageUrl(job.url, paginate.param, page + 1);
    } else {
      next = nextPageUrl(html, url, page + 1);
    }
  }
  return out;
}

async function cmdFetchFilters({ only, refresh }) {
  const domains = existsSync(PATTERNS_DIR)
    ? readdirSync(PATTERNS_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
        .filter((d) => !only || d === only)
        .sort()
    : [];
  if (!domains.length) {
    console.error(only ? `no catalog/patterns/${only}.json` : "no pattern files yet");
    process.exit(1);
  }
  let fetched = 0;
  let rendered = 0;
  let cached = 0;
  let failed = 0;
  let usedRender = false;
  let axiBroken = "";
  for (const domain of domains) {
    const pattern = loadPattern(domain, { strict: false });
    if (!pattern || pattern.skip) continue;
    const src = pattern.source_domain || domain; // a redirecting domain downloads into the target's folder
    const compiled = compilePattern(pattern);
    for (const job of filterJobs(src, pattern, compiled)) {
      if (pattern.render) {
        // rendered pages: the DOM result is the cache, one page per job (no pagination, no HTML)
        const file = renderFile(src, job.kind, job.key);
        if (existsSync(file) && !refresh) {
          cached++;
          continue;
        }
        if (axiBroken) {
          failed++;
          continue;
        }
        try {
          const data = await renderPage(job.url);
          saveJSON(file, data);
          rendered++;
          usedRender = true;
          console.log(
            `${domain} render ${job.kind}:${job.key} → ${file.replace(/^.*catalog\/corpus\//, "corpus/")} (${data.links.length} links, ${data.anchors.length} anchors)`,
          );
        } catch (e) {
          const msg = String(e?.message || e);
          if (/ENOENT|not found|spawn/i.test(msg)) axiBroken = msg;
          console.error(`warn: ${domain} render ${job.kind} "${job.key}": ${msg} — page skipped`);
          failed++;
          await sleep(RENDER_PACE);
          continue;
        }
        await sleep(RENDER_PACE);
        continue;
      }
      const r = await fetchFilterJob(job, { domain, src, pattern, compiled, refresh });
      fetched += r.fetched;
      cached += r.cached;
      failed += r.failed;
    }
  }
  if (usedRender) await stopRenderer();
  await scraplingClient.close();
  if (axiBroken) console.error(`warn: chrome-devtools-axi is not runnable (${axiBroken}) — rendered pages were skipped`);
  console.log(
    `--fetch-filters: ${fetched} pages downloaded · ${rendered} rendered · ${cached} pages already cached · ${failed} failed`,
  );
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
  if (args.includes("--suggest")) cmdSuggest(value("--suggest"));
  else if (args.includes("--auto")) await cmdAuto(value("--auto"));
  else if (args.includes("--check")) cmdCheck(value("--check"));
  else if (args.includes("--fetch-filters")) await cmdFetchFilters({ only: value("--only"), refresh: args.includes("--refresh") });
  else {
    console.log(`usage:
  bun tools/patterns.mjs --suggest <domain>
  bun tools/patterns.mjs --auto briefs/phase-6/sites/auto-sites.tsv
  bun tools/patterns.mjs --check <domain>
  bun tools/patterns.mjs --fetch-filters [--only=<domain>] [--refresh]`);
    process.exit(1);
  }
}

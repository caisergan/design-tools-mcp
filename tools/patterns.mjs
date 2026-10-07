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
import { PATTERNS_DIR, elementIndex, filterFile, filterJobs, hrefs, humanise, loadFilters, loadPattern, loadSitemap, pathSegments, patternFile, sitemapScan } from "./sitemap-items.mjs";

const UA = "Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)";

// ---------------------------------------------------------------- guesser

const tagElements = (domain, child, overrides, taxonomy) =>
  tagItem({ reg: domain, name: child, title: humanise(child), type: "" }, { overrides, taxonomy }).elements;

/**
 * Group sitemap URLs by path prefix, the last segment being `{name}`; for deeper paths the last two segments are
 * tried too (`…/{name}/{n}` when the leaf is a number, `…/{element}/{n}` when the middle segment is an element).
 * Returns the groups with ≥ 10 children, most children first. Writes nothing.
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
    if (entries.length < minChildren) continue;
    const names = [...new Set(entries.map(([, name]) => name))];
    const allElements = names.every((c) => bySlug.has(slug(c)));
    const template = g.mode === "A" ? `/${g.dir}/{name}` : `/${g.dir}/{${allElements ? "element" : "name"}}/${g.mode === "N" ? "{n}" : "{*}"}`;
    const literals = template.split("/").filter((s) => s && !/^\{[^}]*\}$/.test(s));
    const meta = literals.find((s) => LOCALE.test(s) || SKIP_SEGMENT.test(s));
    const last = literals[literals.length - 1];
    let tagged = 0;
    for (const name of names) if (tagElements(domain, name, overrides, taxonomy).length) tagged++;
    const elemPct = Math.round((100 * tagged) / names.length);
    const componentLike = !!last && (COMPONENT_SEGMENT.test(last) || bySlug.has(slug(last)));
    let why;
    if (meta) why = `meta segment "${meta}"`;
    else if (!literals.length) why = "no literal prefix segment";
    else if (componentLike) why = `prefix "${last}" is a component segment or an element`;
    else if (elemPct >= 30) why = `${elemPct}% of children tag to an element`;
    else why = `prefix "${last}" is neither component-like nor element-tagged (${elemPct}%)`;
    const high = !meta && literals.length > 0 && (componentLike || elemPct >= 30);
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
  console.log(`${domain}: ${sitemap.urls.length} sitemap URLs${sitemap.truncated ? " (truncated)" : ""} · ${rows.length} groups with ≥ 10 children`);
  for (const r of rows)
    console.log(
      `${r.high ? "HIGH" : "low "} ${r.template} · ${r.children} children · ${r.elemPct}% element-tagged · ${r.why}\n     ${r.samples.join("\n     ")}`,
    );
  if (!rows.length) console.log("  (no group of 10+ children)");
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
        reason: rows.length ? `no high-confidence prefix (${rows.length} candidates)` : "no path prefix with ≥ 10 children",
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
  for (const e of filters.empty) console.error(`warn: ${domain}: filter page ${e.kind} "${e.key}" yielded 0 matching links (JS-rendered, or not fetched yet)`);
  const scan = sitemapScan(domain, parent, { pattern, sitemap, filters, taken: new Map() });
  const built = buildItems(entries).get(parent.id) || [];
  const items = built.filter((i) => i.from === "sitemap");
  const withEl = items.filter((i) => i.elements.length).length;
  const variants = {};
  for (const i of items) for (const [el, vs] of Object.entries(i.variants || {})) for (const v of vs) variants[`${el}:${v}`] = (variants[`${el}:${v}`] || 0) + 1;
  const vlist = Object.entries(variants).sort((a, b) => b[1] - a[1]);
  console.log(
    `${domain}: pattern ${pattern.status} · match ${JSON.stringify(pattern.match)}${pattern.element ? ` · element ${pattern.element}` : ""} · granularity ${pattern.granularity || "page"}`,
  );
  console.log(
    `${sitemap ? `${sitemap.urls.length} sitemap URLs` : "no sitemap"}${filters.urls.length ? ` + ${filters.urls.length} urls_from links` : ""} → ${scan.candidates} candidates · ${scan.matched} matched · ${items.length} items (${scan.skipped} skipped as duplicates) · ${withEl} with an element (${items.length ? Math.round((100 * withEl) / items.length) : 0}%)`,
  );
  console.log(`elements: ${[...new Set(items.flatMap((i) => i.elements))].sort().join(", ") || "— none —"}`);
  console.log(`variants: ${vlist.length ? vlist.map(([k, n]) => `${k} ${n}`).join(" · ") : "— none —"}`);
  for (const i of items.slice(0, 8)) console.log(`  ${i.id}  ${i.name}  [${i.elements.join(",")}] ${JSON.stringify(i.variants)}  ${i.url}`);
}

// ---------------------------------------------------------------- --fetch-filters

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE = 500; // ms between requests → ≤ 2 req/s per host

async function get(url) {
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
  let cached = 0;
  let failed = 0;
  for (const domain of domains) {
    const pattern = loadPattern(domain, { strict: false });
    if (!pattern || pattern.skip) continue;
    for (const job of filterJobs(domain, pattern)) {
      let next = job.url;
      for (let page = 1; page <= 20 && next; page++) {
        const file = filterFile(domain, job.kind, job.key, page);
        let html;
        if (existsSync(file) && !refresh) {
          html = readFileSync(file, "utf8");
          cached++;
        } else {
          await sleep(PACE);
          try {
            const res = await get(next);
            if (!res.ok) {
              console.error(`warn: ${domain} ${job.kind} "${job.key}" page ${page}: HTTP ${res.status} — ${next}`);
              failed++;
              break;
            }
            html = res.body;
            saveText(file, html);
            fetched++;
            console.log(`${domain} ${job.kind}:${job.key} page ${page} → ${file.replace(/^.*catalog\/corpus\//, "corpus/")} (${(html.length / 1024).toFixed(0)} kB)`);
          } catch (e) {
            console.error(`warn: ${domain} ${job.kind} "${job.key}" page ${page}: ${e.message}`);
            failed++;
            break;
          }
        }
        next = nextPageUrl(html, next, page + 1);
      }
    }
  }
  console.log(`--fetch-filters: ${fetched} pages downloaded · ${cached} pages already cached · ${failed} failed`);
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

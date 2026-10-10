#!/usr/bin/env bun
// Item layer (MCP-PLAN 3.1–3.4): one record per component or docs page inside a catalog entry.
// Adapters 1–2 only read what is already on disk (no network, no LLM):
//   1 registry — catalog/corpus/sites/<domain>/registry.json   → access code | gated
//   2 llms.txt — link lines of catalog/corpus/sites/<domain>/llms.txt that point at component pages → access page
// After the sitemap (3) and api (5) adapters, a registry item still without a url takes the page url that
// tools/registry-urls.mjs verified for it (catalog/corpus/sites/<domain>/registry-urls.json).
// Tags come from tools/tag.mjs (taxonomy aliases). Output: catalog/items/<entry-id>.json (generated, never edit).
//
//   bun tools/items.mjs            build + write catalog/items/, print items per entry and the change since last build
//   bun tools/items.mjs --dry      build + print the report only
import { readdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FILE, OUT, loadJSON, saveJSON, slug } from "./lib.mjs";
import { tagItem, loadTagOverrides, SKIP_TYPE } from "./tag.mjs";
import { loadFilters, loadPattern, loadSitemap, sitemapScan } from "./sitemap-items.mjs";
import { apiItems } from "./api-21st.mjs";

export const ITEMS_DIR = join(OUT, "items");
const SITES = join(FILE.corpus, "sites");

const registryOf = (e) => e.probe?.registry || e.probe?.registry_index || e.probe?.registry_root || null;

/** The entry that owns a corpus folder: the root site of the domain, else the first entry with a registry, else the first. */
export function parentsByDomain(entries) {
  const byDomain = new Map();
  for (const e of entries) {
    const cur = byDomain.get(e.domain);
    const rank = (x) => (x.kind === "site" ? 0 : registryOf(x) ? 1 : 2);
    if (!cur || rank(e) < rank(cur)) byDomain.set(e.domain, e);
  }
  return byDomain;
}

// ---------------------------------------------------------------- adapter 1: registries

// reactbits ships every component four times: Name-TS-TW, -TS-CSS, -JS-TW, -JS-CSS.
const STACK = /[-_](ts|js)[-_](tw|css)$/i;
export const stackOf = (name) => (STACK.exec(name) || []).slice(1, 3).join("-").toLowerCase() || null;
export const baseName = (name) => name.replace(STACK, "");
// demo-* / *-demo / registry:example items illustrate a component; they attach to it instead of being items.
const DEMO = /(^|[-_])demos?([-_]|$)/i;
export const isDemo = (raw) => raw.type === "registry:example" || DEMO.test(raw.name);
const demoBase = (name) => name.replace(/(^|[-_])demos?(?=[-_]|$)/i, "").replace(/^[-_]+|[-_]+$/g, "");

function registryItems(domain, parent, ov) {
  const file = join(SITES, domain, "registry.json");
  let data;
  try {
    data = loadJSON(file);
  } catch {
    return [];
  }
  const list = (Array.isArray(data) ? data : data?.items || []).filter((r) => r?.name);
  const reg = registryOf(parent) || {};
  const gated = reg.item_status === 401 || reg.item_status === 403;
  const base = reg.item_status === 200 && reg.url ? reg.url.replace(/\/[^/]+\.json$/, "") : null;
  const out = new Map(); // id -> item
  const demos = [];
  for (const raw of list) {
    if (isDemo(raw) && !SKIP_TYPE.test(raw.type || "")) {
      demos.push(raw);
      continue;
    }
    const stack = stackOf(raw.name);
    const name = stack ? baseName(raw.name) : raw.name;
    const id = `${parent.id}/${slug(name)}`;
    const prev = out.get(id);
    if (prev) {
      // stack builds of one component (or a name that slugs the same): one item, every registry name kept
      if (stack && !prev.stacks?.includes(stack)) (prev.stacks ||= []).push(stack);
      prev.names.push(raw.name);
      continue;
    }
    const t = tagItem({ reg: domain, name, title: raw.title || "", description: raw.description || "", type: raw.type || "" }, { overrides: ov });
    const local = existsSync(join(SITES, domain, "items", `${slug(raw.name)}.json`));
    out.set(id, {
      id,
      parent: parent.id,
      name: raw.title || name,
      ...(raw.title && raw.title !== name ? { slug: name } : {}),
      names: [raw.name], // registry names to fetch (get_component); several when stack builds merged
      ...(raw.description ? { description: String(raw.description).replace(/\s+/g, " ").trim() } : {}),
      elements: t.elements,
      variants: t.variants,
      access: gated ? "gated" : "code",
      granularity: "variant",
      ...(stack ? { stacks: [stack] } : {}),
      ...(raw.type ? { type: raw.type } : {}),
      ...(base ? { install_url: `${base}/${raw.name}.json` } : {}),
      ...(local ? { local: true } : {}),
      from: "registry",
    });
  }
  // demos attach to the component they show (by name), else stay items of their own
  const byName = new Map([...out.values()].map((i) => [(i.slug || i.name).toLowerCase(), i]));
  for (const raw of demos) {
    const target = byName.get(baseName(demoBase(raw.name)).toLowerCase()) || out.get(`${parent.id}/${slug(baseName(demoBase(raw.name)))}`);
    if (target) (target.examples ||= []).push(raw.name);
    else {
      const id = `${parent.id}/${slug(raw.name)}`;
      if (out.has(id)) continue;
      const t = tagItem({ reg: domain, name: demoBase(raw.name) || raw.name, title: raw.title || "", type: "" }, { overrides: ov });
      out.set(id, {
        id,
        parent: parent.id,
        name: raw.title || raw.name,
        names: [raw.name],
        ...(raw.description ? { description: String(raw.description).replace(/\s+/g, " ").trim() } : {}),
        elements: t.elements,
        variants: t.variants,
        access: gated ? "gated" : "code",
        granularity: "example",
        ...(raw.type ? { type: raw.type } : {}),
        ...(base ? { install_url: `${base}/${raw.name}.json` } : {}),
        from: "registry",
      });
    }
  }
  for (const i of out.values()) for (const k of ["stacks", "examples"]) if (i[k]?.length > 1) i[k].sort();
  return [...out.values()];
}

// ---------------------------------------------------------------- adapter 2: llms.txt link lines

// A docs page is an item when its path sits under a component-ish segment, or under /docs/ and its slug names an element.
// Locale copies (/cn/, /ja/ …) and blog, changelog, guide and API pages are not.
const COMPONENT_SEGMENT = /^(components?|blocks?|ui|sections?|elements|primitives|effects|animations?|backgrounds|text-animations|widgets|patterns|charts|buttons|cards|inputs|layouts?|navigation|overlays?|feedback|forms?|data-display)$/i;
const SKIP_SEGMENT = /^(blog|posts?|news|changelog|releases?|careers|jobs|legal|privacy|terms|pricing|about|contact|press|showcase|customers|stories|compare|vs|alternatives|glossary|api|reference|llms|guides?|tutorials?|articles|help|support|faq|getting-started|installation|introduction|migration|cli|mcp|theming|themes?)$/i;
const LOCALE = /^(cn|zh|zh-cn|zh-hans|zh-hant|zh-tw|ja|jp|ko|kr|fr|de|es|pt|pt-br|ru|it|id|tr|vi|th|pl|nl|ar|hi|uk|he|sv|da|fi|no|nb|cs|hu|ro|el|bg|fa|ms)$/i;
export { COMPONENT_SEGMENT, SKIP_SEGMENT, LOCALE };
// Only design entries get docs-page items: a Stripe API reference or a support centre also has "elements" and "contact" pages.
const UI_CATEGORIES = new Set(["components", "sections", "inspiration", "templates", "motion", "color-effects", "layout", "registries"]);
const LINK = /^\s*[-*]\s*\[([^\]]+)\]\(([^)\s]+)\)(?:\s*[:—–-]\s*(.*))?$/gm;

export function llmsLinks(text, domain) {
  const out = [];
  for (const m of text.matchAll(LINK)) {
    let u;
    try {
      u = new URL(m[2], `https://${domain}/`);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol)) continue;
    out.push({ title: m[1].trim(), url: u.toString(), host: u.hostname.replace(/^www\./, ""), path: u.pathname, desc: (m[3] || "").trim() });
  }
  return out;
}

/** null when the link is not a component docs page; else { slug, segs } */
export function docsPage(link, domain, { ov }) {
  if (link.host !== domain.replace(/^www\./, "")) return null;
  const segs = link.path
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s).replace(/\.(md|mdx|txt|html?)$/i, ""));
  if (segs.length < 2) return null;
  if (segs.some((s) => LOCALE.test(s) || SKIP_SEGMENT.test(s))) return null;
  const last = segs[segs.length - 1];
  if (!/[a-z]/i.test(last) || last === "index" || COMPONENT_SEGMENT.test(last)) return null; // section index pages
  const under = segs.slice(0, -1).some((s) => COMPONENT_SEGMENT.test(s));
  if (under) return { slug: last, segs };
  if (segs.includes("docs")) {
    const t = tagItem({ reg: domain, name: last, title: "", type: "" }, { overrides: ov });
    if (t.elements.length) return { slug: last, segs };
  }
  return null;
}

const pageKey = (u) => {
  try {
    const x = new URL(u);
    return x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
};

/**
 * An llms.txt link to a raw markdown file (`/components/haptic.md`, `/raw/docs/…/x.md`, `/markdown/docs/x.md`) is
 * what an agent reads, not the page a person opens. When the site's own sitemap lists the html twin — the path
 * without the extension, without a /raw[/en] or /markdown prefix, or under /docs — that page is the url.
 * `sitemapKeys` = Map(pageKey → sitemap loc). Anything else keeps the link as it is.
 */
export function htmlTwin(url, sitemapKeys) {
  if (!sitemapKeys?.size || !/\.mdx?$/i.test(new URL(url).pathname)) return url;
  const x = new URL(url);
  const host = x.hostname.replace(/^www\./, "");
  const path = x.pathname.replace(/\.mdx?$/i, "").replace(/\/+$/, "");
  const paths = [path];
  for (const pre of ["/raw/en", "/raw", "/markdown", "/md"])
    if (path.startsWith(`${pre}/`)) paths.push(path.slice(pre.length), `/docs${path.slice(pre.length)}`);
  for (const p of paths) {
    const loc = sitemapKeys.get(host + p);
    if (loc) return loc;
  }
  return url;
}

const cleanTitle = (t) => t.replace(/\s*\(\d+\)\s*$/, "").replace(/\s+/g, " ").trim();

function llmsItems(domain, parent, ov, taken) {
  const file = join(SITES, domain, "llms.txt");
  if (!existsSync(file)) return [];
  if (!parent.categories.some((c) => UI_CATEGORIES.has(c)) && !registryOf(parent)) return [];
  const out = [];
  let keys; // pageKey → loc of the site's sitemap, read only when a markdown link shows up
  const pageUrl = (u) => {
    if (!/\.mdx?$/i.test(new URL(u).pathname)) return u;
    keys ??= new Map((loadSitemap(domain)?.urls || []).map((x) => x?.loc ?? x?.url ?? x).filter((l) => typeof l === "string").map((l) => [pageKey(l), l]));
    return htmlTwin(u, keys);
  };
  for (const link of llmsLinks(readFileSync(file, "utf8"), domain)) {
    const page = docsPage(link, domain, { ov });
    if (!page) continue;
    link.url = pageUrl(link.url);
    const id = `${parent.id}/${slug(page.slug)}`;
    const reg = taken.get(id);
    if (reg) {
      // the registry already has this component: the docs page becomes its url
      if (reg.from === "registry" && !reg.url) reg.url = link.url;
      continue;
    }
    const name = cleanTitle(link.title) || page.slug;
    const t = tagItem({ reg: domain, name: page.slug, title: name, type: "" }, { overrides: ov });
    const item = {
      id,
      parent: parent.id,
      name,
      url: link.url,
      ...(link.desc ? { description: link.desc.replace(/\s+/g, " ") } : {}),
      elements: t.elements,
      variants: t.variants,
      access: "page",
      granularity: "page",
      from: "llms",
    };
    taken.set(id, item);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------- registry url templates (brief 16)

/** Cache of tools/registry-urls.mjs: verified page urls of registry items no sitemap lists. */
export const registryUrlsFile = (domain) => join(SITES, domain, "registry-urls.json");

/** `results` (item id → url | null) of one domain's cache, or null; a broken file warns and counts as none. */
export function loadTemplateUrls(domain, { file = registryUrlsFile(domain), warn = console.error } = {}) {
  if (!existsSync(file)) return null;
  try {
    const results = JSON.parse(readFileSync(file, "utf8"))?.results;
    if (!results || typeof results !== "object" || Array.isArray(results)) throw new Error("no results object");
    return results;
  } catch (e) {
    warn(`warn: ${file.replace(/^.*catalog\/corpus\//, "corpus/")}: ${e.message} — template urls ignored`);
    return null;
  }
}

/** A url-less registry item takes `results[item.id]` when it is an http(s) url; nothing else changes. Returns the count. */
export function applyTemplateUrls(items, results) {
  if (!results) return 0;
  let n = 0;
  for (const i of items) {
    const url = results[i.id];
    if (i.from !== "registry" || i.url || typeof url !== "string" || !/^https?:\/\//.test(url)) continue;
    i.url = url;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- build

/** Per-entry stats of the last buildItems() run: entry id → { domain, scan, auto }. */
export const sitemapStats = new Map();
/** Per-entry count of urls the last buildItems() run took from registry-urls.json: entry id → { domain, filled }. */
export const templateStats = new Map();

/**
 * entries = catalog.json items → Map(entry id → items[]); `only` limits the build to one corpus folder;
 * `templateUrls: false` leaves the registry-urls.json cache out (tools/registry-urls.mjs decides what to check).
 */
export function buildItems(entries, { overrides = loadTagOverrides(), only = null, templateUrls = true } = {}) {
  const parents = parentsByDomain(entries);
  const byEntry = new Map();
  sitemapStats.clear();
  templateStats.clear();
  const itemFixes = loadJSON(FILE.overrides, {})?.item_fixes || {};
  if (!existsSync(SITES)) return byEntry;
  for (const domain of readdirSync(SITES).sort()) {
    if (only && domain !== only) continue; // --check: one corpus folder
    const parent = parents.get(domain);
    if (!parent) continue;
    const reg = existsSync(join(SITES, domain, "registry.json")) ? registryItems(domain, parent, overrides) : [];
    const taken = new Map(reg.map((i) => [i.id, i]));
    const docs = llmsItems(domain, parent, overrides, taken);
    const maps = [];
    const pattern = loadPattern(domain, { strict: false }); // adapter 3: catalog/patterns/<domain>.json
    if (pattern && !pattern.skip) {
      const filters = loadFilters(domain, pattern);
      for (const e of filters.empty)
        console.error(`warn: ${domain}: filter page ${e.kind} "${e.key}" yielded 0 matching links (JS-rendered, or not fetched)`);
      const scan = sitemapScan(domain, parent, { overrides, taken, pattern, sitemap: loadSitemap(domain), filters });
      maps.push(...scan.items);
      sitemapStats.set(parent.id, { domain, scan, auto: pattern.status === "auto" });
    }
    const api = apiItems(domain, parent, { overrides, taken }); // adapter 5: 21st.dev component pages (gated)
    const filled = templateUrls ? applyTemplateUrls(reg, loadTemplateUrls(domain)) : 0;
    if (filled) templateStats.set(parent.id, { domain, filled });
    const all = [...reg, ...docs, ...maps, ...api];
    for (const i of all) if (itemFixes[i.id]) Object.assign(i, itemFixes[i.id]);
    if (all.length) byEntry.set(parent.id, all);
  }
  return byEntry;
}

export function writeItems(byEntry) {
  rmSync(ITEMS_DIR, { recursive: true, force: true });
  for (const [id, items] of byEntry) saveJSON(join(ITEMS_DIR, `${id}.json`), { parent: id, count: items.length, items });
}

export function loadItems() {
  if (!existsSync(ITEMS_DIR)) return [];
  return readdirSync(ITEMS_DIR)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => loadJSON(join(ITEMS_DIR, f)).items);
}

function report(byEntry, previous) {
  const all = [...byEntry.values()].flat();
  const n = (f) => all.filter(f).length;
  console.log(`items ${all.length} in ${byEntry.size} entries · registry ${n((i) => i.from === "registry")} · llms ${n((i) => i.from === "llms")} · sitemap ${n((i) => i.from === "sitemap")} (auto ${n((i) => i.auto)}) · api ${n((i) => i.from === "api")}`);
  console.log(`access: code ${n((i) => i.access === "code")} · gated ${n((i) => i.access === "gated")} · page ${n((i) => i.access === "page")} · with an element ${n((i) => i.elements.length)}`);
  console.log(`stack-merged ${n((i) => i.stacks?.length > 1)} · with demos attached ${n((i) => i.examples?.length)} · registry items with a docs url ${n((i) => i.from === "registry" && i.url)}`);
  const siteRows = [...sitemapStats.entries()]
    .map(([id, s]) => ({ id, ...s, items: (byEntry.get(id) || []).filter((i) => i.from === "sitemap") }))
    .sort((a, b) => b.items.length - a.items.length);
  if (siteRows.length) {
    // top sites by item count, plus any site below the cut that attached urls to registry items: a site
    // whose pages all belong to registry items makes no sitemap items and would never be shown otherwise
    const shown = siteRows.slice(0, 80);
    for (const s of siteRows.slice(80)) if (s.scan.urls_attached) shown.push(s);
    console.log(`sitemap sites ${siteRows.length}:`);
    for (const s of shown)
      console.log(
        `  ${s.domain} ${s.items.length} items · ${s.scan.matched}/${s.scan.candidates} urls matched · ${s.scan.urls_attached} urls attached · ${s.items.filter((i) => i.elements.length).length} with an element · ${s.items.reduce((t, i) => t + Object.values(i.variants).flat().length, 0)} variant tags · ${s.auto ? "auto" : "hand"}`,
      );
    if (shown.length < siteRows.length) console.log(`  … ${siteRows.length - shown.length} more sites with sitemap items`);
  }
  const tplRows = [...templateStats.values()].sort((a, b) => b.filled - a.filled || (a.domain < b.domain ? -1 : 1));
  if (tplRows.length) {
    console.log(`registry url templates ${tplRows.length} sites · ${tplRows.reduce((t, s) => t + s.filled, 0)} urls from templates:`);
    for (const s of tplRows) console.log(`  ${s.domain} ${s.filled} urls from templates`);
  }
  const nav = all.filter((i) => i.elements.includes("navbar"));
  console.log(`navbar: ${nav.length} items · ${new Set(nav.filter((i) => i.from === "registry").map((i) => i.parent)).size} registries · ${nav.filter((i) => i.from === "llms").length} docs pages · ${nav.filter((i) => i.from === "sitemap").length} sitemap pages`);
  if (previous.size) {
    const changes = [];
    for (const id of new Set([...previous.keys(), ...byEntry.keys()])) {
      const a = previous.get(id) || 0;
      const b = byEntry.get(id)?.length || 0;
      if (a !== b) changes.push(`${id} ${a} → ${b}`);
    }
    console.log(changes.length ? `changed since last build (${changes.length}):\n  ${changes.slice(0, 40).join("\n  ")}` : "no change since last build");
  }
}

if (import.meta.main) {
  const entries = loadJSON(FILE.catalog)?.items;
  if (!entries) {
    console.error("catalog.json missing — run: bun tools/build.mjs");
    process.exit(1);
  }
  const previous = new Map();
  if (existsSync(ITEMS_DIR))
    for (const f of readdirSync(ITEMS_DIR)) if (f.endsWith(".json")) previous.set(f.slice(0, -5), loadJSON(join(ITEMS_DIR, f)).count);
  const byEntry = buildItems(entries);
  report(byEntry, previous);
  if (!process.argv.includes("--dry")) {
    writeItems(byEntry);
    console.log(`-> ${ITEMS_DIR.replace(OUT + "/", "catalog/")}/ (${byEntry.size} files)`);
  }
}

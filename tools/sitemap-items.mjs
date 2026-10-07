#!/usr/bin/env bun
// Adapter 3 (MCP-PLAN 6.2): a per-site pattern file (catalog/patterns/<domain>.json) turns sitemap URLs and
// filter-page links into items. Everything here is pure except the loaders at the bottom, so tests can pass
// objects in. No network, no LLM.
//
//   catalog/corpus/sites/<domain>/sitemap.json          full sitemap (brief 01)
//   catalog/corpus/sites/<domain>/filters/<key>.html    cached kind/category filter pages (tools/patterns.mjs --fetch-filters)
//   catalog/patterns/<domain>.json                      the pattern itself
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FILE, OUT, loadJSON, normalizeUrl, slug } from "./lib.mjs";
import { TAXONOMY, tagItem } from "./tag.mjs";

export const PATTERNS_DIR = join(OUT, "patterns");
const SITES = join(FILE.corpus, "sites");

export const patternFile = (domain) => join(PATTERNS_DIR, `${domain}.json`);
export const sitemapFile = (domain) => join(SITES, domain, "sitemap.json");
export const filtersDir = (domain) => join(SITES, domain, "filters");

// ---------------------------------------------------------------- templates

const PH = /\{([a-z*]+)\}/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const humanise = (s) =>
  String(s ?? "")
    .split(/[-_.%\s]+/)
    .filter(Boolean)
    .map((w) => (/^\d+$/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");

/** slug form of every element id and alias → element id. Ids win over aliases, earlier elements win. */
export function elementIndex(taxonomy = TAXONOMY) {
  const bySlug = new Map();
  const byId = new Map();
  for (const e of taxonomy.elements) byId.set(e.id, e);
  for (const e of taxonomy.elements) {
    const k = slug(e.id);
    if (k && !bySlug.has(k)) bySlug.set(k, e.id);
  }
  for (const e of taxonomy.elements) for (const a of e.aliases || []) {
    const k = slug(a);
    if (k && !bySlug.has(k)) bySlug.set(k, e.id);
  }
  return { bySlug, byId };
}

export const resolveElement = (name, { bySlug } = elementIndex()) =>
  bySlug.get(slug(String(name || "").replace(/\s+/g, "-"))) || null;

export const elementLabel = (id, taxonomy = TAXONOMY) => taxonomy.elements.find((e) => e.id === id)?.label || humanise(id);

const variantBelongsTo = (elId, variantId, { byId }) => !!byId.get(elId)?.variants?.some((v) => v.id === variantId);

/** One template → per-segment anchored regexes; `{name}` is greedy inside its segment, others take one segment. */
export function compileTemplate(template, { alt, bySlug }) {
  if (typeof template !== "string" || !template.startsWith("/"))
    throw new Error(`template must start with "/": ${JSON.stringify(template)}`);
  const raw = template.split("/").filter(Boolean); // a trailing slash is ignored
  if (!raw.length) throw new Error(`template has no path segments: ${JSON.stringify(template)}`);
  const segs = raw.map((seg) => {
    let src = "^";
    let last = 0;
    const kinds = [];
    for (const m of seg.matchAll(PH)) {
      src += esc(seg.slice(last, m.index));
      const kind = m[1];
      if (kind === "element") {
        if (!alt) throw new Error(`{element} used but no element alternation available in ${template}`);
        src += `(${alt})`;
        kinds.push({ kind, bySlug });
      } else if (kind === "name") {
        src += "(.+)";
        kinds.push({ kind });
      } else if (kind === "author") {
        src += "([^/]+)";
        kinds.push({ kind });
      } else if (kind === "n") {
        src += "(\\d+)";
        kinds.push({ kind });
      } else if (kind === "*") {
        src += "([^/]+)";
        kinds.push({ kind: "star" });
      } else throw new Error(`unknown placeholder {${kind}} in ${template}`);
      last = m.index + m[0].length;
    }
    src += esc(seg.slice(last)) + "$";
    return { re: new RegExp(src, "i"), kinds };
  });
  return { template, segs };
}

export function compilePattern(pattern, { taxonomy = TAXONOMY } = {}) {
  const { bySlug, byId } = elementIndex(taxonomy);
  const alt = [...bySlug.keys()]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map(esc)
    .join("|");
  const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  return {
    pattern,
    taxonomy,
    bySlug,
    byId,
    templates: list(pattern.match).map((t) => compileTemplate(t, { alt, bySlug })),
    excludes: list(pattern.exclude).map((t) => compileTemplate(t, { alt, bySlug })),
  };
}

export const pathSegments = (pathname) =>
  String(pathname)
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

function matchSegments(tmpl, segs) {
  if (tmpl.segs.length !== segs.length) return null;
  const captures = [];
  for (let i = 0; i < segs.length; i++) {
    const t = tmpl.segs[i];
    const m = t.re.exec(segs[i]);
    if (!m) return null;
    let g = 1;
    for (const k of t.kinds) {
      const raw = m[g++];
      if (k.kind === "element") {
        const id = k.bySlug.get(String(raw).toLowerCase());
        if (!id) return null;
        captures.push({ kind: "element", raw, id, seg: i });
      } else captures.push({ kind: k.kind, raw, seg: i });
    }
  }
  return captures;
}

/** null or { url, path, segs, captures } — query and trailing slash ignored. */
export function matchTemplate(compiled, url) {
  let u;
  try {
    u = url instanceof URL ? url : new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const segs = pathSegments(u.pathname);
  const captures = matchSegments(compiled, segs);
  return captures ? { url: u.toString(), path: u.pathname, segs, captures } : null;
}

/** First matching template wins; any matching exclude template drops the URL. */
export function matchUrl(url, compiled) {
  const m = compiled.templates.map((t) => matchTemplate(t, url)).find(Boolean);
  if (!m) return null;
  return compiled.excludes.some((t) => matchTemplate(t, url)) ? null : m;
}

export const captureOf = (m, kind) => m.captures.find((c) => c.kind === kind);

// ---------------------------------------------------------------- validation

const GRANULARITY = new Set(["page", "example", "variant"]);
const ACCESS = new Set(["page", "gated"]);
const STATUS = new Set(["hand", "auto"]);
const TEMPLATE_RE = /\{[a-z*]+\}/g;

export function validatePattern(pattern, domain = "?") {
  const fail = (msg) => {
    throw new Error(`catalog/patterns/${domain}.json: ${msg}`);
  };
  if (!pattern || typeof pattern !== "object" || Array.isArray(pattern)) fail("must be a JSON object");
  if (pattern.status !== undefined && !STATUS.has(pattern.status)) fail(`status must be "hand" or "auto", got ${JSON.stringify(pattern.status)}`);
  if (pattern.skip !== undefined) {
    if (typeof pattern.skip !== "string" || !pattern.skip.trim()) fail("skip must be a non-empty reason string");
    return pattern;
  }
  const { bySlug, byId } = elementIndex();
  const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

  if (typeof pattern.match !== "string" && !Array.isArray(pattern.match)) fail('"match" must be a template string or an array of them');
  const templates = list(pattern.match);
  if (!templates.length) fail('"match" is empty');
  for (const t of templates) if (typeof t !== "string" || !t.startsWith("/")) fail(`match template must be a "/"-path: ${JSON.stringify(t)}`);
  if (pattern.exclude !== undefined) {
    if (!Array.isArray(pattern.exclude)) fail('"exclude" must be an array of templates');
    for (const t of pattern.exclude) if (typeof t !== "string" || !t.startsWith("/")) fail(`exclude template must be a "/"-path: ${JSON.stringify(t)}`);
  }
  if (pattern.granularity !== undefined && !GRANULARITY.has(pattern.granularity)) fail(`granularity must be page, example or variant — got ${JSON.stringify(pattern.granularity)}`);
  if (pattern.access !== undefined && !ACCESS.has(pattern.access)) fail(`access must be page or gated — got ${JSON.stringify(pattern.access)}`);
  if (pattern.element !== undefined && !resolveElement(pattern.element, { bySlug }))
    fail(`element ${JSON.stringify(pattern.element)} is not a taxonomy element id or alias`);

  for (const [k, v] of [["variants_from", pattern.variants_from], ["elements_from", pattern.elements_from]]) {
    if (v === undefined) continue;
    if (!v || typeof v !== "object" || Array.isArray(v)) fail(`"${k}" must be an object of id → page path`);
    for (const [id, path] of Object.entries(v)) {
      if (typeof path !== "string" || !path.startsWith("/")) fail(`${k}["${id}"] must be a "/"-path: ${JSON.stringify(path)}`);
      if (k === "elements_from" && !resolveElement(id, { bySlug })) fail(`elements_from key ${JSON.stringify(id)} is not a taxonomy element id or alias`);
    }
  }
  if (pattern.urls_from !== undefined) {
    if (!Array.isArray(pattern.urls_from)) fail('"urls_from" must be an array of page paths');
    for (const p of pattern.urls_from) if (typeof p !== "string" || !p.startsWith("/")) fail(`urls_from entry must be a "/"-path: ${JSON.stringify(p)}`);
  }

  // variant ids must belong to the pattern's element, or to an element the `{element}` capture can yield
  const owners = pattern.element ? [resolveElement(pattern.element, { bySlug })] : [...byId.keys()];
  for (const [vid] of Object.entries(pattern.variants_from || {})) {
    if (!owners.some((id) => variantBelongsTo(id, vid, { byId })))
      fail(
        pattern.element
          ? `variants_from "${vid}" is not a variant of ${pattern.element} (${(byId.get(owners[0])?.variants || []).map((v) => v.id).join(", ") || "no variants"})`
          : `variants_from "${vid}" is not a variant id in the taxonomy`,
      );
  }

  const placeholders = new Set(templates.flatMap((t) => (t.match(TEMPLATE_RE) || []).map((p) => p.slice(1, -1))));
  for (const p of placeholders) if (!["name", "author", "n", "*", "element"].includes(p)) fail(`unknown placeholder {${p}} in match`);
  compilePattern(pattern); // throws on anything the checks above missed
  return pattern;
}

// ---------------------------------------------------------------- the adapter

const dedupeSorted = (a) => [...new Set(a)].sort();

/** Same page reached through www and non-www is one page: normalizeUrl plus a www-less host. */
const urlKeyOf = (raw) => {
  const n = normalizeUrl(raw);
  if (!n) return null;
  try {
    const u = new URL(n);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return n;
  }
};

/**
 * Sitemap URLs (+ urls_from links) + pattern → items. `taken` is the id → item map of the entry (registry and
 * llms items win); items made here are added to it. Pure: pass `sitemap`, `pattern` and `filters` in.
 */
export function sitemapScan(domain, parent, { overrides = { assetDomains: new Set(), components: {} }, taken = new Map(), pattern, sitemap = null, filters = null, taxonomy = TAXONOMY } = {}) {
  const out = [];
  if (!pattern || pattern.skip || parent?.id === undefined) return { items: out, candidates: 0, matched: 0, skipped: 0, unmapped: 0 };
  const compiled = compilePattern(pattern, { taxonomy });
  const fixed = pattern.element ? resolveElement(pattern.element, compiled) : null;

  // candidate URLs: the sitemap first, then the urls_from pages (sites without a sitemap)
  const candidates = [];
  const seenUrl = new Set();
  const push = (raw) => {
    const n = normalizeUrl(raw);
    if (!n || seenUrl.has(n)) return;
    seenUrl.add(n);
    candidates.push(n);
  };
  for (const u of sitemap?.urls || []) push(u?.loc ?? u?.url);

  const fv = filters?.variants || {};
  const fe = filters?.elements || {};
  const filterVariantKeys = new Map(); // variant id → page keys of the filter page's links
  for (const [vid, list] of Object.entries(fv)) filterVariantKeys.set(vid, new Set([...(list || [])].map(urlKeyOf).filter(Boolean)));
  const filterElementKeys = new Map();
  for (const [eid, list] of Object.entries(fe)) {
    const id = resolveElement(eid, compiled) || eid;
    filterElementKeys.set(id, new Set([...(list || [])].map(urlKeyOf).filter(Boolean)));
  }
  for (const u of filters?.urls || []) push(u);

  const takenUrls = new Set();
  for (const it of taken.values()) {
    const n = it?.url ? urlKeyOf(it.url) : null;
    if (n) takenUrls.add(n);
  }

  let matched = 0;
  let skipped = 0;
  let unmapped = 0;
  for (const url of candidates) {
    const m = matchUrl(url, compiled);
    if (!m) continue;
    matched++;
    const key = urlKeyOf(url);
    if (!key || takenUrls.has(key)) {
      skipped++;
      continue;
    }
    // id and name come from the whole captured segment: /sections/{name}-{element}-{n} on
    // "rig-ai-hero-1" is id "<parent>/rig-ai-hero-1" and name "Rig Ai Hero 1" — never a bare "Rig Ai",
    // and never dependent on sitemap order.
    const cElement = captureOf(m, "element") ?? null;
    const cAuthor = captureOf(m, "author") ?? null;
    const nameSeg = captureOf(m, "name")?.seg ?? captureOf(m, "element")?.seg ?? captureOf(m, "star")?.seg ?? m.segs.length - 1;
    const base = m.segs[nameSeg];
    const parts = [];
    if (cAuthor && cAuthor.seg !== nameSeg) parts.push(cAuthor.raw);
    parts.push(base);
    for (const c of m.captures) if (c.seg !== nameSeg && c.kind !== "name" && c.kind !== "author") parts.push(c.raw);
    const idBase = parts.join("-");
    const id = `${parent.id}/${slug(idBase)}`;
    if (taken.has(id)) {
      // registry and llms items win, and two pages whose segment slugs the same are one item
      skipped++;
      continue;
    }

    const els = new Set();
    if (fixed) els.add(fixed);
    if (cElement) els.add(cElement.id);
    for (const [eid, keys] of filterElementKeys) if (keys.has(key)) els.add(eid);
    const tagged = tagItem({ reg: domain, name: base, title: humanise(base), type: "" }, { overrides, taxonomy });
    if (!els.size) for (const e of tagged.elements) els.add(e);
    if (!els.size) unmapped++;

    const variants = {};
    const addVariant = (elId, vid) => {
      if (!elId) return null;
      (variants[elId] ||= []).push(vid);
      return elId;
    };
    for (const [vid, keys] of filterVariantKeys) {
      if (!keys.has(key)) continue;
      addVariant([...els].find((el) => variantBelongsTo(el, vid, compiled)) || fixed, vid);
    }
    for (const [elId, vids] of Object.entries(tagged.variants || {})) if (els.has(elId)) for (const vid of vids) addVariant(elId, vid);
    for (const k of Object.keys(variants)) variants[k] = dedupeSorted(variants[k]);

    const label = fixed ? elementLabel(fixed, taxonomy) : null;
    const item = {
      id,
      parent: parent.id,
      name: humanise(idBase) + (label ? ` — ${label}` : ""),
      url,
      elements: [...els].sort(),
      variants,
      access: pattern.access || "page",
      granularity: pattern.granularity || "page",
      from: "sitemap",
      ...(pattern.status === "auto" ? { auto: true } : {}),
    };
    out.push(item);
    taken.set(id, item);
    takenUrls.add(key);
  }
  return { items: out, candidates: candidates.length, matched, skipped, unmapped };
}

export const sitemapItems = (domain, parent, opts) => sitemapScan(domain, parent, opts).items;

// ---------------------------------------------------------------- loaders (files, no network)

export function loadPattern(domain, { strict = true } = {}) {
  const f = patternFile(domain);
  if (!existsSync(f)) return null;
  try {
    return validatePattern(JSON.parse(readFileSync(f, "utf8")), domain);
  } catch (e) {
    if (strict) throw e;
    console.error(`warn: ${e.message} — pattern ignored`);
    return null;
  }
}

export function loadSitemap(domain) {
  const f = sitemapFile(domain);
  if (!existsSync(f)) return null;
  try {
    const j = loadJSON(f);
    return j && Array.isArray(j.urls) ? j : null;
  } catch (e) {
    console.error(`warn: ${f}: ${e.message}`);
    return null;
  }
}

const ENTITIES = [
  [/&amp;/gi, "&"],
  [/&quot;/gi, '"'],
  [/&#(?:39|x27);/gi, "'"],
  [/&#x2f;/gi, "/"],
  [/&#47;/g, "/"],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
];
const decodeEntities = (s) => ENTITIES.reduce((acc, [re, v]) => acc.replace(re, v), s);

/** Absolute http(s) links of an HTML page, resolved against `base`. */
export function hrefs(html, base) {
  const out = [];
  const re = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gi;
  for (const m of String(html).matchAll(re)) {
    const raw = decodeEntities((m[1] ?? m[2] ?? m[3] ?? "").trim());
    if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(raw)) continue;
    try {
      const u = new URL(raw, base);
      if (/^https?:$/.test(u.protocol)) out.push(u.toString());
    } catch {
      /* unparsable href */
    }
  }
  return out;
}

const hostOf = (u) => new URL(u).hostname.replace(/^www\./, "");

export const filterFile = (domain, kind, key, page = 1) =>
  join(filtersDir(domain), `${kind === "urls" ? "urls" : kind === "element" ? "e" : "v"}-${slug(key)}${page > 1 ? `.${page}` : ""}.html`);

/** One job per filter page of the pattern: variants_from, elements_from and urls_from. */
export function filterJobs(domain, pattern, compiled = compilePattern(pattern)) {
  const jobs = [];
  for (const [vid, path] of Object.entries(pattern.variants_from || {})) jobs.push({ kind: "variant", key: vid, path, url: `https://${domain}${path}` });
  for (const [eid, path] of Object.entries(pattern.elements_from || {})) jobs.push({ kind: "element", key: resolveElement(eid, compiled) || eid, path, url: `https://${domain}${path}` });
  (pattern.urls_from || []).forEach((path, i) => jobs.push({ kind: "urls", key: String(i + 1), path, url: `https://${domain}${path}` }));
  return jobs;
}

/** Cached filter HTML → { variants: {id: [urls]}, elements: {id: [urls]}, urls: [urls], empty: [{kind, key}] } */
export function loadFilters(domain, pattern, { taxonomy = TAXONOMY, quiet = true, exists = existsSync, readFile = (p) => readFileSync(p, "utf8") } = {}) {
  const compiled = compilePattern(pattern, { taxonomy });
  const out = { variants: {}, elements: {}, urls: [], empty: [] };
  for (const job of filterJobs(domain, pattern, compiled)) {
    const links = new Set();
    for (let page = 1; page <= 20; page++) {
      const f = filterFile(domain, job.kind, job.key, page);
      if (!exists(f)) break;
      let html;
      try {
        html = readFile(f);
      } catch {
        break;
      }
      for (const href of hrefs(html, job.url)) {
        if (hostOf(href) !== domain.replace(/^www\./, "")) continue;
        if (!matchUrl(href, compiled)) continue;
        const n = normalizeUrl(href);
        if (n) links.add(n);
      }
    }
    if (!links.size) {
      out.empty.push({ kind: job.kind, key: job.key });
      if (!quiet) console.error(`warn: ${domain}: filter page ${job.kind} "${job.key}" yielded 0 matching links (JS-rendered, or not fetched yet)`);
    }
    if (job.kind === "variant") out.variants[job.key] = [...links].sort();
    else if (job.kind === "element") out.elements[job.key] = [...links].sort();
    else out.urls.push(...[...links].sort());
  }
  return out;
}

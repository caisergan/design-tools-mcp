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
  const anchorsFrom = list(pattern.anchors_from);

  if (typeof pattern.match !== "string" && !Array.isArray(pattern.match) && !anchorsFrom.length)
    fail('"match" must be a template string or an array of them (or "anchors_from" for a one-page site)');
  const templates = list(pattern.match);
  if (!templates.length && !anchorsFrom.length) fail('"match" is empty');
  for (const t of templates) if (typeof t !== "string" || !t.startsWith("/")) fail(`match template must be a "/"-path: ${JSON.stringify(t)}`);
  if (pattern.anchors_from !== undefined) {
    if (!Array.isArray(pattern.anchors_from) || !pattern.anchors_from.length) fail('"anchors_from" must be a non-empty array of page paths');
    for (const p of pattern.anchors_from) if (typeof p !== "string" || !p.startsWith("/")) fail(`anchors_from entry must be a "/"-path: ${JSON.stringify(p)}`);
  }
  if (pattern.anchors_exclude !== undefined) {
    if (!Array.isArray(pattern.anchors_exclude)) fail('"anchors_exclude" must be an array of "#id" strings');
    for (const x of pattern.anchors_exclude) if (typeof x !== "string" || !x.trim()) fail(`anchors_exclude entry must be a non-empty string: ${JSON.stringify(x)}`);
  }
  if (pattern.render !== undefined && typeof pattern.render !== "boolean") fail('"render" must be true or false');
  if (pattern.source_domain !== undefined && (typeof pattern.source_domain !== "string" || !/^[a-z0-9.-]+$/i.test(pattern.source_domain)))
    fail(`source_domain must be a bare domain: ${JSON.stringify(pattern.source_domain)}`);
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

  if (pattern.paginate !== undefined) {
    const p = pattern.paginate;
    if (!p || typeof p !== "object" || Array.isArray(p)) fail('"paginate" must be {param: string, max: 1-500}');
    for (const k of Object.keys(p)) if (k !== "param" && k !== "max") fail(`paginate has an unknown key ${JSON.stringify(k)} (only param and max)`);
    if (typeof p.param !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(p.param)) fail(`paginate.param must be a query parameter name: ${JSON.stringify(p.param)}`);
    if (!Number.isInteger(p.max) || p.max < 1 || p.max > 500) fail(`paginate.max must be an integer 1-500: ${JSON.stringify(p.max)}`);
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

const NAME_WORDS = /[-_.%\s]+/;
const words = (s) =>
  String(s ?? "")
    .split(NAME_WORDS)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

/**
 * Two items of one site sharing a display name are ambiguous (two collections of the same block, two variants
 * of the same page, a heading used twice). The positional name rule keeps the grouping segments out of the
 * name, so a repeated name gets them appended — `Contact2 — Contact` → `Contact2 C Blocks — Contact`,
 * `Quartz Landing` → `Quartz Landing Dark` — skipping words the name already carries, and a counter if that
 * still collides. Ids never change; the temporary fields are removed afterwards.
 */
function finalizeNames(items) {
  const groups = new Map();
  for (const it of items) {
    const g = groups.get(it.name);
    if (g) g.push(it);
    else groups.set(it.name, [it]);
  }
  if ([...groups.values()].some((g) => g.length > 1)) {
    const taken = new Set(groups.keys());
    for (const [name, group] of groups) {
      if (group.length < 2) continue;
      taken.delete(name);
      for (const it of group) {
        const label = it.__label ? ` — ${it.__label}` : "";
        const have = new Set(words(it.__core));
        const extra = words(it.__hint).filter((w) => !have.has(w));
        const base = humanise(extra.length ? `${it.__core}-${extra.join("-")}` : it.__core);
        let repaired = base + label;
        for (let n = 2; taken.has(repaired); n++) repaired = `${base} ${n}${label}`;
        taken.add(repaired);
        it.name = repaired;
      }
    }
  }
  for (const it of items) {
    delete it.__core;
    delete it.__hint;
    delete it.__label;
  }
}

/**
 * Sitemap URLs (+ urls_from links, or the variants_from/elements_from links of a site without a sitemap) +
 * pattern → items. `taken` is the id → item map of the entry (registry and llms items win); items made here
 * are added to it. Pure: pass `sitemap`, `pattern` and `filters` in.
 */
export function sitemapScan(domain, parent, { overrides = { assetDomains: new Set(), components: {} }, taken = new Map(), pattern, sitemap = null, filters = null, taxonomy = TAXONOMY } = {}) {
  const out = [];
  if (!pattern || pattern.skip || parent?.id === undefined) return { items: out, candidates: 0, matched: 0, skipped: 0, unmapped: 0, anchors: 0 };
  const compiled = compilePattern(pattern, { taxonomy });
  const fixed = pattern.element ? resolveElement(pattern.element, compiled) : null;

  // candidate URLs: the sitemap first, then the urls_from pages — and, on a site without a sitemap, the
  // variants_from/elements_from links too: those filter pages are the only place such items are listed.
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
    const keys = filterElementKeys.get(id) || new Set(); // two jobs can feed one element (checkbox + radio)
    for (const u of list || []) {
      const k = urlKeyOf(u);
      if (k) keys.add(k);
    }
    filterElementKeys.set(id, keys);
  }
  for (const u of filters?.urls || []) push(u);
  if (!sitemap?.urls?.length) {
    for (const list of Object.values(fv)) for (const u of list || []) push(u);
    for (const list of Object.values(fe)) for (const u of list || []) push(u);
  }

  const takenUrls = new Set();
  for (const it of taken.values()) {
    const n = it?.url ? urlKeyOf(it.url) : null;
    if (n) takenUrls.add(n);
  }

  let matched = 0;
  let skipped = 0;
  let unmapped = 0;

  /** Variant tags of one item: filter-page membership first, then the taxonomy tags of its name. */
  const variantsFor = (els, tagged, key) => {
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
    return variants;
  };

  for (const url of candidates) {
    const m = matchUrl(url, compiled);
    if (!m) continue;
    matched++;
    const key = urlKeyOf(url);
    if (!key || takenUrls.has(key)) {
      skipped++;
      continue;
    }
    // id: every capture of the template in capture order, the whole captured segment first —
    // /sections/{name}-{element}-{n} on "rig-ai-hero-1" is id "<parent>/rig-ai-hero-1", never dependent
    // on sitemap order. The id is the item's identity, so it never changes with the display name.
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

    // name: the {author} prefix + the {name} capture (with the {element}/{n} text of its own path segment,
    // e.g. /sections/{name}-{element}-{n} → "navattic-com-hero-1"). Position decides what the other captures
    // do: a {*} / {n} before the name segment only groups the page (/play/text/bounce-in/bounce-in-fwd →
    // "Bounce In Fwd", /templates/c-blocks/contact/contact2 → "Contact2 — Contact"), one after it — or a {*}
    // on the leaf itself — qualifies the item and is appended (/components/accordion/history →
    // "Accordion History", /components/accretion-disc/03 → "Accretion Disc 03").
    const leaf = m.segs.length - 1;
    const segCaps = m.captures.filter((c) => c.seg === nameSeg);
    const named = segCaps.filter((c) => c.kind === "name" || c.kind === "element" || c.kind === "n");
    const nameParts = [];
    if (cAuthor) nameParts.push(cAuthor.raw);
    if (named.length) nameParts.push(...named.map((c) => c.raw));
    else if (!(segCaps.length && segCaps.every((c) => c.kind === "author")) && !(nameSeg === leaf && segCaps.some((c) => c.kind === "star"))) nameParts.push(base);
    for (const c of m.captures) if (c.seg > nameSeg && (c.kind === "star" || c.kind === "n")) nameParts.push(c.raw);
    if (!nameParts.length) nameParts.push(base);
    const nameBase = nameParts.join("-");

    const els = new Set();
    if (fixed) els.add(fixed);
    if (cElement) els.add(cElement.id);
    for (const [eid, keys] of filterElementKeys) if (keys.has(key)) els.add(eid);
    const tagged = tagItem({ reg: domain, name: base, title: humanise(base), type: "" }, { overrides, taxonomy });
    if (!els.size) for (const e of tagged.elements) els.add(e);
    if (!els.size) unmapped++;

    const variants = variantsFor(els, tagged, key);

    // fixed element → its label; an {element} captured in a segment of its own → the label of that element
    const label = fixed ? elementLabel(fixed, taxonomy) : cElement && cElement.seg !== nameSeg ? elementLabel(cElement.id, taxonomy) : null;
    // grouping captures (a {*}/{n} before the name segment) stay out of the name, but they are what tells
    // two items of one site apart — `finalizeNames` appends them when a name would repeat.
    const grouping = m.captures.filter((c) => (c.kind === "star" || c.kind === "n") && c.seg < nameSeg).map((c) => c.raw);
    const item = {
      id,
      parent: parent.id,
      name: humanise(nameBase) + (label ? ` — ${label}` : ""),
      __core: nameBase,
      __hint: (grouping.length ? grouping : [idBase]).join("-"),
      __label: label || "",
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

  // anchors_from: one item per in-page section of a one-page library. The url keeps its `#hash`, so these
  // are deduped by full url rather than through normalizeUrl (which drops the hash).
  const anchorRows = filters?.anchors || [];
  const anchorUrls = new Set([...taken.values()].map((i) => i?.url).filter(Boolean));
  let anchors = 0;
  for (const a of anchorRows) {
    const anchorSlug = slug(a?.id || "");
    if (!anchorSlug) continue;
    const id = `${parent.id}/${anchorSlug}`;
    const url = `${a.url}#${a.id}`;
    if (taken.has(id) || anchorUrls.has(url)) {
      skipped++;
      continue;
    }
    anchors++;
    const els = new Set();
    if (fixed) els.add(fixed);
    const tagged = tagItem({ reg: domain, name: a.id, title: a.text || humanise(a.id), type: "" }, { overrides, taxonomy });
    if (!els.size) for (const e of tagged.elements) els.add(e);
    if (!els.size) unmapped++;
    const label = fixed ? elementLabel(fixed, taxonomy) : null;
    const core = a.text?.trim() || humanise(a.id);
    const item = {
      id,
      parent: parent.id,
      name: core + (label ? ` — ${label}` : ""),
      __core: core,
      __hint: a.id, // a heading can name two sections (simply-buttons' "Pixel load"): the id separates them
      __label: label || "",
      url,
      elements: [...els].sort(),
      variants: variantsFor(els, tagged, urlKeyOf(a.url)),
      access: pattern.access || "page",
      granularity: pattern.granularity || "page",
      from: "sitemap",
      ...(pattern.status === "auto" ? { auto: true } : {}),
    };
    out.push(item);
    taken.set(id, item);
    anchorUrls.add(url);
  }
  finalizeNames(out);
  return { items: out, candidates: candidates.length, matched, skipped, unmapped, anchors };
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

/** Corpus folder that serves this pattern: `source_domain` when the site's own domain redirects elsewhere. */
export const sourceDomainOf = (domain, pattern = undefined) => (pattern ?? loadPattern(domain, { strict: false }))?.source_domain || domain;

/** Sitemap of the source domain (usually the pattern's own domain, see `source_domain`). */
export function loadSitemap(domain, { pattern = undefined, exists = existsSync, readFile = loadJSON } = {}) {
  const f = sitemapFile(sourceDomainOf(domain, pattern));
  if (!exists(f)) return null;
  try {
    const j = readFile(f);
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

/**
 * The links of one filter page that belong to this pattern: same host as the source site, matching the
 * template, tracking params stripped, deduped. The pagination stop rule and `loadFilters` both read this.
 */
export function matchingLinks(html, base, host, compiled) {
  const want = String(host).replace(/^www\./, "");
  const links = new Set();
  for (const href of hrefs(html, base)) {
    if (hostOf(href) !== want || !matchUrl(href, compiled)) continue;
    const n = normalizeUrl(href);
    if (n) links.add(n);
  }
  return links;
}

const KIND_PREFIX = (kind) => (kind === "urls" ? "urls" : kind === "element" ? "e" : kind === "anchors" ? "anchors" : "v");

export const filterFile = (domain, kind, key, page = 1) =>
  join(filtersDir(domain), `${KIND_PREFIX(kind)}-${slug(key)}${page > 1 ? `.${page}` : ""}.html`);

/** Rendered-fetch cache of one filter page: `{ url, fetched_at, links, anchors }` — the DOM result, never the HTML. */
export const renderFile = (domain, kind, key, page = 1) =>
  join(filtersDir(domain), `rendered-${KIND_PREFIX(kind)}-${slug(key)}${page > 1 ? `.${page}` : ""}.json`);

/**
 * One job per filter page of the pattern: variants_from, elements_from, urls_from and anchors_from.
 * An elements_from key is the item-facing element; the job keeps its own (slugged) key so two categories that
 * map to one element (`/checkboxes` + `/radio-buttons` → `checkbox`) get separate cache files.
 */
export function filterJobs(domain, pattern, compiled = compilePattern(pattern)) {
  const src = pattern?.source_domain || domain;
  const jobs = [];
  for (const [vid, path] of Object.entries(pattern.variants_from || {})) jobs.push({ kind: "variant", key: vid, path, url: `https://${src}${path}` });
  for (const [eid, path] of Object.entries(pattern.elements_from || {})) jobs.push({ kind: "element", key: slug(eid), path, url: `https://${src}${path}` });
  (pattern.urls_from || []).forEach((path, i) => jobs.push({ kind: "urls", key: String(i + 1), path, url: `https://${src}${path}` }));
  (pattern.anchors_from || []).forEach((path, i) => jobs.push({ kind: "anchors", key: String(i + 1), path, url: `https://${src}${path}` }));
  return jobs;
}

// ---------------------------------------------------------------- anchors (one-page libraries)

const GENERIC_ANCHOR = /^(top|main|content|nav|footer|header|root|__next|app)$/i;
const NOISE_ANCHOR = /^(?:radix-|headlessui-|react-|mui-|base-ui-|reka-|aria-|:r)/i;

/** Landmarks, framework/tab ids, all-digit ids and hashes name nothing an agent could ask for. */
export function isJunkAnchorId(id) {
  const s = String(id ?? "").trim();
  if (!s || s.length > 80) return true;
  if (GENERIC_ANCHOR.test(s) || NOISE_ANCHOR.test(s)) return true;
  const core = s.replace(/[^a-z0-9]/gi, "");
  if (!/[a-z]/i.test(core)) return true;
  if ((core.match(/\d/g) || []).length / core.length > 0.5) return true;
  return /^[0-9a-f]{12,}$/i.test(core);
}

const ATTR_ID = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+))/i;
const collapse = (s) =>
  decodeEntities(String(s).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

/** The heading that names an open `<section id=…>`: the first h1–h4 before its matching close tag. */
function headingIn(text, from) {
  const re = /<\/?(?:section|article|div)\b[^>]*>|<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] === undefined) {
      if (m[0].startsWith("</")) {
        if (--depth <= 0) return null;
      } else depth++;
    } else return collapse(m[2]);
  }
  return null;
}

/**
 * In-page sections of one HTML page: `{ id, text }` rows in document order — headings with an `id`,
 * `section` / `article` / `div` with an `id` and a heading inside, and same-page `href="#…"` links.
 * Junk ids are dropped; the name is the heading text, else the link text (else an empty string).
 */
export function extractAnchors(html) {
  const text = String(html ?? "");
  const named = new Map(); // id → heading text (wins)
  const linked = new Map(); // id → link text
  const open = /<(h[1-4]|section|article|div)\b([^>]*)>/gi;
  let m;
  while ((m = open.exec(text))) {
    const tag = m[1].toLowerCase();
    const a = ATTR_ID.exec(m[2]);
    if (!a) continue;
    const id = decodeEntities(a[1] ?? a[2] ?? a[3] ?? "");
    if (isJunkAnchorId(id) || named.has(id)) continue;
    if (/^h[1-4]$/.test(tag)) {
      const close = new RegExp(`</${tag}\\s*>`, "i");
      const rest = text.slice(open.lastIndex);
      const end = close.exec(rest);
      named.set(id, collapse(end ? rest.slice(0, end.index) : rest));
    } else {
      const h = headingIn(text, open.lastIndex);
      if (h) named.set(id, h);
    }
  }
  const link = /<a\b[^>]*\bhref\s*=\s*(?:"#([^"]*)"|'#([^']*)'|#([^\s"'<>`]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
  while ((m = link.exec(text))) {
    const id = decodeEntities((m[1] ?? m[2] ?? m[3] ?? "").trim());
    if (!id || isJunkAnchorId(id) || named.has(id) || linked.has(id)) continue;
    const t = collapse(m[4]);
    if (t) linked.set(id, t);
  }
  return [...[...named, ...linked].map(([id, text2]) => ({ id, text: text2 }))];
}

/**
 * Cached filter pages → { variants: {id: [urls]}, elements: {id: [urls]}, urls: [urls], anchors: [{url, id, text}],
 * empty: [{kind, key}] }. `render: true` patterns read `rendered-<key>.json` (the DOM result) instead of the HTML.
 */
export function loadFilters(domain, pattern, { taxonomy = TAXONOMY, quiet = true, exists = existsSync, readFile = (p) => readFileSync(p, "utf8") } = {}) {
  const compiled = compilePattern(pattern, { taxonomy });
  const src = pattern?.source_domain || domain;
  const srcHost = src.replace(/^www\./, "");
  const excluded = new Set((pattern.anchors_exclude || []).map((x) => String(x).replace(/^#/, "")));
  const out = { variants: {}, elements: {}, urls: [], anchors: [], empty: [] };
  // every cached page of a job, not just the first: `paginate` patterns can keep up to `max` pages
  const pageCap = Math.max(20, Number(pattern.paginate?.max) || 0);
  for (const job of filterJobs(src, pattern, compiled)) {
    const links = new Set();
    const anchors = [];
    if (pattern.render) {
      const f = renderFile(src, job.kind, job.key);
      let data = null;
      if (exists(f))
        try {
          data = JSON.parse(readFile(f));
        } catch {
          data = null;
        }
      for (const href of data?.links || []) {
        if (hostOf(href) !== srcHost || !matchUrl(href, compiled)) continue;
        const n = normalizeUrl(href);
        if (n) links.add(n);
      }
      if (job.kind === "anchors")
        for (const a of data?.anchors || []) if (a?.id && !isJunkAnchorId(a.id)) anchors.push({ url: job.url, id: String(a.id), text: String(a.text || "") });
    } else {
      for (let page = 1; page <= (job.kind === "anchors" ? 1 : pageCap); page++) {
        const f = filterFile(src, job.kind, job.key, page);
        if (!exists(f)) break;
        let html;
        try {
          html = readFile(f);
        } catch {
          break;
        }
        if (job.kind === "anchors") {
          for (const a of extractAnchors(html)) anchors.push({ url: job.url, id: a.id, text: a.text });
        } else {
          for (const link of matchingLinks(html, job.url, srcHost, compiled)) links.add(link);
        }
      }
    }
    if (job.kind === "anchors") {
      const seen = new Set();
      for (const a of anchors) {
        if (excluded.has(a.id) || seen.has(a.id)) continue;
        seen.add(a.id);
        out.anchors.push(a);
      }
      if (!seen.size) out.empty.push({ kind: job.kind, key: job.key });
      continue;
    }
    if (!links.size) {
      out.empty.push({ kind: job.kind, key: job.key });
      if (!quiet) console.error(`warn: ${domain}: filter page ${job.kind} "${job.key}" yielded 0 matching links (JS-rendered, or not fetched yet)`);
    }
    if (job.kind === "variant") out.variants[job.key] = [...links].sort();
    else if (job.kind === "element") out.elements[job.key] = [...new Set([...(out.elements[job.key] || []), ...links])].sort(); // two jobs can feed one element
    else out.urls.push(...[...links].sort());
  }
  return out;
}

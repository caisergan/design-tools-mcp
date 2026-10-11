// Phase 2B metadata records (MCP-PLAN 2B): paths, source hints and their hash, the record check (schema + taxonomy),
// keyword normalization and the no-LLM hint fallback for entries without a record. Pure apart from the file helpers;
// shared by tools/crawl.mjs, metadata-queue.mjs, metadata-batch.mjs, metadata-check.mjs and build.mjs.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { OUT, loadJSON } from "./lib.mjs";
import { TAXONOMY, elementsIn } from "./tag.mjs";
import { categorize } from "./categorize.mjs";
import { schemaProblems } from "./json-schema.mjs";

export const METADATA_DIR = join(OUT, "metadata");
export const CRAWL_DIR = join(OUT, "crawl"); // gitignored: third-party text never reaches the public repo
export const SCHEMA_FILE = join(METADATA_DIR, "schema.json");
export const recordFile = (id, dir = METADATA_DIR) => join(dir, `${id}.json`);
export const digestFile = (id, dir = CRAWL_DIR) => join(dir, `${id}.json`);
export const SCHEMA = loadJSON(SCHEMA_FILE);
export const PROMPT_ID = "metadata-v2";
export const STALE_DAYS = 90;
/** Records whose content the build does not merge: the entry keeps its source values and says so. */
export const UNREAD_STATUS = new Set(["blocked", "dead"]);

/** catalog/metadata/ also holds schema.json, pilot.json, RUN.md and the generated _queue / _review / _batches. */
const NOT_RECORDS = new Set(["schema.json", "pilot.json"]);
export function recordIds(dir = METADATA_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_") && !NOT_RECORDS.has(f))
    .map((f) => f.slice(0, -5))
    .sort();
}
export const loadRecord = (id, dir = METADATA_DIR) => loadJSON(recordFile(id, dir));

// ---------------------------------------------------------------- source hints

/** `reach.reason` dead / repo-gone: skipped by the crawl and the queue. `reach.ok: false` alone is not dead (no-endpoint …). */
export const isDead = (e) => e.reach?.reason === "dead" || e.reach?.reason === "repo-gone";

/**
 * What the sources say about an entry — the extractor reads these as hints, never as facts. No social signals.
 * `entry` is a source entry (tools/build.mjs loadItems with `metadata: false`), not a merged catalog.json entry.
 */
export function hintsOf(e) {
  const h = { url: e.url, kind: e.kind, name: e.name, desc: e.desc || "" };
  if (e.title && e.title !== e.desc) h.title = e.title;
  if (e.about && e.about !== e.desc) h.about = e.about;
  if (e.labels?.length) h.labels = e.labels;
  if (e.note) h.note = e.note;
  h.categories = e.categories;
  return h;
}

/** A record is re-queued when this changes (MCP-PLAN 2B queue: "the entry's source hints changed"). */
export const hintsHash = (e) => createHash("sha256").update(JSON.stringify(hintsOf(e))).digest("hex").slice(0, 16);

export function isStale(record, now = Date.now(), days = STALE_DAYS) {
  const t = Date.parse(record?.extracted_at || "");
  return !Number.isFinite(t) || now - t > days * 86_400_000;
}

// ---------------------------------------------------------------- hint fallback (no record yet)

// Prose (about, note) and labels name elements in passing; these elements mostly mean something else there
// ("security teams", "features" the verb, any "agent" tool, Cursor the editor, "map every file", "one pager").
const PROSE_NOISY = new Set(["team", "features", "ai-agent-ui", "cursor", "map", "list", "select", "404", "command-palette", "switch", "contact", "stats", "changelog", "timeline", "form", "input", "banner", "alert", "pagination"]);
// About / note count only for entries the sources already file as UI resources.
const UI_CATEGORIES = new Set(["components", "sections", "inspiration", "templates", "motion", "layout", "color-effects", "registries"]);
const NOTE_MAX = 100; // a short curated note ("UI kit and admin dashboard …"); longer ones are X post text
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Provisional elements from the source hints (MCP-PLAN 2B "Before the run"): taxonomy alias matching over the name and
 * desc (as search.mjs did at index time) — `strong` — plus each label and, for UI entries, about and a short note,
 * minus the elements that are noise in prose — `weak` (they say what an entry contains, not what it is: search counts
 * them less). Never from a glued brand name (HeroUI), never from the source category label ("Bölüm galerileri
 * (navbar / hero / footer / CTA)" would tag 31 galleries with all four). → { strong: [ids], weak: [ids not in strong] }
 */
export function hintElements(e, taxonomy = TAXONOMY) {
  const nameRe = new RegExp(escapeRe(e.name), "gi");
  const strip = (s) => (s || "").replace(nameRe, " ");
  const found = (text) => elementsIn(text, { field: "title", taxonomy }).map((h) => h.el);
  const strong = new Set(found([e.name.toLowerCase(), strip(e.desc)].join(" | ")));
  const weak = new Set();
  const quiet = (els) => els.filter((el) => !PROSE_NOISY.has(el) && !strong.has(el)).forEach((el) => weak.add(el));
  for (const l of e.labels || []) quiet(found(strip(l)));
  if (e.categories?.some((c) => UI_CATEGORIES.has(c))) {
    if (e.about && e.about !== e.desc) quiet(found(strip(e.about)));
    if (e.note && e.note.length <= NOTE_MAX) quiet(found(strip(e.note)));
  }
  return { strong: [...strong], weak: [...weak] };
}

/**
 * Categories the source hints point at: the entry's source categories (from its list labels, or its text) plus what
 * its text alone says — never the bare default bucket, which is the absence of a hint.
 */
export function hintCategories(e, taxonomy = TAXONOMY) {
  const out = new Set((e.categories || []).filter((c) => c !== taxonomy.categorize.default));
  const byText = categorize({ ...e, categories: [] }, taxonomy);
  if (byText.via === "text") byText.categories.forEach((c) => out.add(c));
  return out;
}

// ---------------------------------------------------------------- keywords

// Words whose trailing s is not a plural (and spellings that end in one).
const KEEP_S = /(ss|us|is|as|os|ics|js|ous|news|series|species)$/;
const KEEP_WORDS = new Set(["docs", "sales", "postgres", "kubernetes", "aws", "less", "express", "lens", "plus", "yes"]);
const PLURALS = { menus: "menu", emojis: "emoji", canvases: "canvas", statuses: "status", lenses: "lens", indices: "index" };
/** Singular of one English word (only what plural endings say; anything unclear stays as written). */
export function singular(w) {
  if (PLURALS[w]) return PLURALS[w];
  if (w.length < 4 || /\d/.test(w) || KEEP_S.test(w) || KEEP_WORDS.has(w)) return w;
  if (/ies$/.test(w) && w.length > 5 && !/(movies|cookies)$/.test(w)) return w.slice(0, -3) + "y";
  if (/(ch|sh|x|z|ss)es$/.test(w)) return w.slice(0, -2);
  if (/oes$/.test(w)) return w.slice(0, -2);
  if (/[^s']s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Lowercase, NFKC, single spaces, no surrounding punctuation, the last word singular. */
export function cleanKeyword(k) {
  const s = String(k || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[_\s]+/g, " ")
    .replace(/^[^\p{L}\p{N}#.+]+|[^\p{L}\p{N}#+]+$/gu, "")
    .trim();
  if (!s) return "";
  // the head noun is the last word, also after a hyphen ("mega-menus" → "mega-menu")
  return s.replace(/([\p{L}\p{N}.+#']+)$/u, (w) => singular(w));
}

const compact = (s) => cleanKeyword(s).replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * keyword → canonical spelling, from catalog/taxonomy.json: spelling variants of an element / variant id, an element
 * or synonym alias ("nav bar", "nav-bar", "navbars" → "navbar"; "megamenu" → "mega menu"), and Turkish search words
 * to their English term ("animasyon" → "animation"). Different wordings are not merged: "tool call" stays "tool call"
 * (it says more than ai-agent-ui), so search keeps every word the extractor chose.
 */
export function keywordMap(taxonomy = TAXONOMY) {
  const map = new Map();
  const put = (spelling, canonical) => {
    const k = compact(spelling);
    if (k && !map.has(k)) map.set(k, canonical);
  };
  const spaced = (id) => id.replace(/-/g, " ");
  for (const e of taxonomy.elements) {
    put(e.id, spaced(e.id));
    const weak = new Set(e.weak_aliases || []);
    // an alias written as one glued word is a spelling of the id ("navbar" ~ "nav bar"); other wordings stay
    for (const a of e.aliases) if (!weak.has(a) && compact(a) === compact(e.id)) put(a, spaced(e.id));
    for (const v of e.variants || []) {
      put(v.id, spaced(v.id));
      for (const a of v.aliases) if (compact(a) === compact(v.id)) put(a, spaced(v.id));
    }
  }
  for (const s of taxonomy.synonyms) for (const a of s.aliases) put(a, cleanKeyword(a));
  for (const a of taxonomy.aliases_tr) {
    const list = a.target === "categories" ? taxonomy.categories : a.target === "elements" ? taxonomy.elements : taxonomy.types;
    const target = list.find((x) => x.id === a.id);
    if (!target) continue;
    const english = a.target === "elements" ? spaced(target.id) : cleanKeyword(target.aliases?.[0] || target.label);
    for (const w of a.aliases) put(w, english);
  }
  return map;
}
const KEYWORD_MAP = keywordMap();

/** Clean, map, dedupe (first wins). */
export function normalizeKeywords(list, map = KEYWORD_MAP) {
  const out = [];
  for (const k of list || []) {
    const c = cleanKeyword(k);
    if (!c) continue;
    const n = map.get(compact(c)) || c;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// The spellings extractors write for one stack; everything else is lowercased and spaces become "-".
const STACK_ALIASES = {
  tailwindcss: "tailwind", "tailwind css": "tailwind", "next.js": "nextjs", next: "nextjs", "vue.js": "vue", vuejs: "vue",
  "react.js": "react", reactjs: "react", "react native": "react-native", threejs: "three.js", three: "three.js",
  "framer motion": "framer-motion", "svelte kit": "sveltekit", "angular.js": "angular", typescript: "typescript", ts: "typescript",
  "shadcn/ui": "shadcn", "shadcn ui": "shadcn", "radix ui": "radix", "node.js": "node", nodejs: "node", "html5": "html", css3: "css",
};
export function normalizeStack(list) {
  const out = [];
  for (const s of list || []) {
    const k = String(s || "").normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
    if (!k) continue;
    const n = STACK_ALIASES[k] || k.replace(/ /g, "-");
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** The record with keywords / stack / elements normalized (keywords_manual untouched). Returns a new object. */
export function normalizeRecord(r) {
  const out = { ...r };
  if (Array.isArray(r.keywords)) out.keywords = normalizeKeywords(r.keywords);
  if (Array.isArray(r.stack)) out.stack = normalizeStack(r.stack);
  if (Array.isArray(r.elements)) out.elements = [...new Set(r.elements.map((x) => String(x).trim().toLowerCase()))];
  return out;
}

// ---------------------------------------------------------------- check

/** Unknown taxonomy ids and catalog links: errors. */
export function taxonomyProblems(r, { taxonomy = TAXONOMY, ids = null } = {}) {
  const out = [];
  const cats = new Set(taxonomy.categories.map((c) => c.id));
  const types = new Set(taxonomy.types.map((t) => t.id));
  const els = new Map(taxonomy.elements.map((e) => [e.id, new Set((e.variants || []).map((v) => v.id))]));
  if (r.type !== undefined && !types.has(r.type)) out.push(`type: unknown type id "${r.type}"`);
  for (const c of r.categories || []) if (!cats.has(c)) out.push(`categories: unknown category id "${c}"`);
  for (const el of r.elements || []) if (!els.has(el)) out.push(`elements: unknown element id "${el}"`);
  for (const [el, vs] of Object.entries(r.variants || {})) {
    if (!els.has(el)) out.push(`variants: unknown element id "${el}"`);
    else {
      if (!(r.elements || []).includes(el)) out.push(`variants: "${el}" is not in elements`);
      for (const v of vs || []) if (!els.get(el).has(v)) out.push(`variants.${el}: unknown variant id "${v}"`);
    }
  }
  if (ids && r.related?.parent && !ids.has(r.related.parent)) out.push(`related.parent: "${r.related.parent}" is not a catalog id`);
  return out;
}

/**
 * Every error of one record: schema, taxonomy, and agreement with the catalog entry it describes
 * (`entry` from loadItems; `fileId` = the file name). [] when it is valid.
 */
export function recordProblems(r, { fileId = r?.id, entry = null, ids = null, taxonomy = TAXONOMY, schema = SCHEMA } = {}) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return ["not a JSON object"];
  const out = schemaProblems(schema, r).map((p) => p.replace(/^\$\.?/, "") || "record");
  out.push(...taxonomyProblems(r, { taxonomy, ids }));
  if (fileId && r.id !== fileId) out.push(`id: "${r.id}" but the file is ${fileId}.json`);
  if (ids && !ids.has(r.id)) out.push(`id: "${r.id}" is not a catalog entry`);
  if (entry) {
    if (r.kind !== entry.kind) out.push(`kind: "${r.kind}" but the catalog entry is a ${entry.kind}`);
    if (r.url !== entry.url) out.push(`url: "${r.url}" but the catalog entry is ${entry.url}`);
  }
  return out;
}

/** Why one record goes to _review.md (not errors): low confidence, or a primary category no source hint supports. */
export function reviewReasons(r, entry, { taxonomy = TAXONOMY, threshold = 0.6 } = {}) {
  if (UNREAD_STATUS.has(r.status)) return [];
  const out = [];
  if (typeof r.confidence === "number" && r.confidence < threshold) out.push(`confidence ${r.confidence}`);
  const primary = r.categories?.[0];
  if (primary && entry) {
    const hinted = hintCategories(entry, taxonomy);
    if (hinted.size && !hinted.has(primary)) out.push(`primary category ${primary}, hints say ${[...hinted].join(", ")}`);
  }
  return out;
}

export const mtimeOf = (f) => (existsSync(f) ? statSync(f).mtimeMs : 0);

// Ranked search over catalog entries and their items (MCP-PLAN 3.5–3.6). No dependencies, no network.
// buildIndex() turns catalog entries + items into BM25 postings (written by tools/index.mjs to
// catalog/search-index.json); createSearch() answers queries against it with taxonomy query expansion.
import { existsSync, statSync } from "node:fs";
import { FILE, loadJSON } from "./lib.mjs";
import { TAXONOMY, elementsIn, variantsIn, tok as tokAscii } from "./tag.mjs";

export const INDEX_FILE = FILE.catalog.replace(/catalog\.json$/, "search-index.json");
export const INDEX_SCHEMA = 4; // 3: item records carry `auto`, prior() reads it · 4: packed on disk (packIndex / unpackIndex)

// ---------------------------------------------------------------- tokens

// Unicode letters stay together (Turkish queries), camelCase and letter/digit boundaries split.
// Exported for tools/sections.mjs, which tokenises with the same boundaries.
export const split = (s) =>
  String(s || "")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{L})(\d)/gu, "$1 $2")
    .replace(/(\d)(\p{L})/gu, "$1 $2")
    .toLocaleLowerCase("en")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Light English stemming: plurals, -ing, -ed, -ation (animated / animating / animation → animat). */
export function stemWord(w) {
  if (w.length < 4 || /\d/.test(w)) return w;
  if (/(ss|us|is)$/.test(w)) return w;
  if (/ies$/.test(w) && w.length > 4) w = w.slice(0, -3) + "y";
  else if (/(ches|shes|xes|zes|sses)$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 6 && w.endsWith("ation")) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2);
  return w;
}

export const tokens = (s) => split(s).map(stemWord);

const STOP = new Set(
  "a an the and or of for to in on with my our your their its it is are be this that these those from by at as into when what how which who has have no not any some can i we you me show find give get need want looking like".split(" "),
);

// ---------------------------------------------------------------- index

// Field ids and their BM25F weights. `matched` names the field a query word hit.
export const FIELDS = ["name", "element", "variant", "description", "labels", "about", "category", "domain"];
const W = { name: 3, element: 3, variant: 2, description: 2, labels: 2, about: 1, category: 1, domain: 1 };
const ITEM_DESC_WEIGHT = 1; // item descriptions are long and generic: they count less than an entry's one-liner

const K1 = 1.2;
const B = 0.75;

const elTerm = (id) => `el:${id}`;
const vaTerm = (el, v) => `va:${el}/${v}`;
const catTerm = (id) => `cat:${id}`;

/** Entries carry elements too ("Navbar Gallery" → navbar), from their description and name — never from a glued brand name (HeroUI). */
function entryElements(e) {
  const nameRe = new RegExp(e.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const text = [e.name.toLowerCase(), (e.desc || "").replace(nameRe, " ")].join(" | ");
  return [...new Set(elementsIn(text, { field: "title" }).map((h) => h.el))];
}

function entryFields(e) {
  const cats = e.categories.map((id) => TAXONOMY.categories.find((c) => c.id === id)).filter(Boolean);
  const els = entryElements(e);
  return {
    elements: els,
    fields: {
      name: [...tokens(e.name), ...split(e.name).filter((w) => w.length > 2)].concat(e.name.includes(" ") ? [] : [e.name.toLowerCase()]),
      element: els.map(elTerm),
      description: tokens(e.desc),
      labels: tokens((e.labels || []).join(" ")),
      about: tokens(e.about && e.about !== e.desc ? e.about : ""),
      category: [...cats.flatMap((c) => tokens(c.label)), ...e.categories.map(catTerm)],
      domain: tokens(e.domain.replace(/^www\./, "")),
    },
  };
}

function itemFields(i, parent) {
  const els = i.elements || [];
  return {
    name: [...tokens(i.name), ...(i.slug ? tokens(i.slug) : [])],
    element: els.map(elTerm),
    variant: Object.entries(i.variants || {}).flatMap(([el, vs]) => vs.map((v) => vaTerm(el, v))),
    description: tokens(i.description),
    // the parent's domain without its TLD ("magicui.design" → magicui): its name can be a page title
    // ("… shadcn/ui theme generator") and its TLD a query word ("design") that every item would inherit.
    // The registry type (ui, block, example) is a filter, not text.
    domain: parent ? tokens(parent.domain.replace(/^www\./, "").replace(/\.[a-z]+$/, "")) : [],
  };
}

// Item records as the server shows them: short description, no per-stack registry names unless needed.
const clipText = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s || "");
function itemRecord(i) {
  const r = { id: i.id, parent: i.parent, name: i.name, access: i.access, granularity: i.granularity, from: i.from };
  if (i.auto) r.auto = true;
  for (const k of ["slug", "url", "type", "install_url", "stacks", "examples", "local"]) if (i[k] !== undefined) r[k] = i[k];
  if (i.description) r.description = clipText(i.description, 200);
  if (i.elements?.length) r.elements = i.elements;
  if (i.variants && Object.keys(i.variants).length) r.variants = i.variants;
  if (i.names && (i.names.length > 1 || i.names[0] !== (i.slug || i.name))) r.names = i.names;
  return r;
}

/**
 * docs 0 … entries.length-1 are entries (same order as catalog.json), then the items.
 * postings: term → flat [doc, tf×100, fieldMask, …]; tf is the field-weighted count, already
 * length-normalised (BM25, against the average of its own doc kind), so a query only adds idf and saturation.
 */
export function buildIndex(entries, items) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const entryEls = [];
  const docs = [];
  entries.forEach((e) => {
    const { elements, fields } = entryFields(e);
    entryEls.push(elements);
    docs.push({ kind: 0, fields });
  });
  for (const i of items) docs.push({ kind: 1, fields: itemFields(i, byId.get(i.parent)) });
  const postings = new Map();
  // An item's description does not count towards its length: a documented component should not lose to an undocumented one.
  const docLen = ({ kind, fields }) =>
    Object.entries(fields).reduce((n, [f, toks]) => n + (f === "description" && kind === 1 ? 0 : toks.length * W[f]), 0);
  const lens = docs.map(docLen);
  const avgLen = [0, 1].map((k) => {
    const l = lens.filter((_, d) => docs[d].kind === k);
    return Math.max(1, l.reduce((a, b) => a + b, 0) / Math.max(1, l.length));
  });
  docs.forEach(({ kind, fields }, doc) => {
    const tf = new Map(); // term → [normalised weighted tf, mask]
    const norm = 1 - B + B * (lens[doc] / avgLen[kind]);
    for (const [f, toks] of Object.entries(fields)) {
      if (!toks.length) continue;
      const w = f === "description" && kind === 1 ? ITEM_DESC_WEIGHT : W[f];
      const bit = 1 << FIELDS.indexOf(f);
      const counts = new Map();
      for (const t of toks) counts.set(t, (counts.get(t) || 0) + 1);
      for (const [t, n] of counts) {
        const cur = tf.get(t) || [0, 0];
        cur[0] += (w * n) / norm;
        cur[1] |= bit;
        tf.set(t, cur);
      }
    }
    for (const [t, [w, mask]] of tf) {
      let p = postings.get(t);
      if (!p) postings.set(t, (p = []));
      p.push(doc, Math.max(1, Math.round(w * 100)), mask);
    }
  });
  return {
    schema: INDEX_SCHEMA,
    built_at: new Date().toISOString(),
    entries: entries.length,
    docs: docs.length,
    entry_ids: entries.map((e) => e.id),
    entry_elements: entryEls,
    items: items.map(itemRecord),
    postings: Object.fromEntries(postings),
  };
}

// ---------------------------------------------------------------- on-disk form
// The file keeps the 40 MB budget (MCP-PLAN decision 10): item records are grouped by parent (the id loses its "<parent>/" prefix,
// urls their shared origin, and fields equal to the group's most common value are left out), keys are short,
// and each posting list is one string of base-36 numbers with delta-coded doc ids. unpackIndex() rebuilds
// exactly what buildIndex() returned, so search never sees the difference.
const PACK_KEYS = [["id", "i"], ["name", "n"], ["access", "a"], ["granularity", "g"], ["from", "f"], ["auto", "au"], ["slug", "s"], ["url", "u"], ["type", "t"], ["install_url", "iu"], ["stacks", "st"], ["examples", "ex"], ["local", "l"], ["description", "d"], ["elements", "e"], ["variants", "v"], ["names", "ns"]];
const LONG_KEY = Object.fromEntries(PACK_KEYS.map(([k, short]) => [short, k]));
const GROUP_DEFAULTS = ["access", "granularity", "from", "type"];
const mostCommon = (vals) => {
  const n = new Map();
  for (const v of vals) if (v !== undefined) n.set(v, (n.get(v) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
};
const originOf = (url) => /^https?:\/\/[^/]+/.exec(url || "")?.[0] || null;

export function packIndex(idx) {
  const groups = [];
  for (const r of idx.items) {
    const g = groups.at(-1);
    if (g && g.parent === r.parent) g.items.push(r);
    else groups.push({ parent: r.parent, items: [r] });
  }
  const items = groups.map(({ parent, items }) => {
    const origin = mostCommon(items.map((r) => originOf(r.url)));
    const defaults = Object.fromEntries(GROUP_DEFAULTS.map((k) => [k, mostCommon(items.map((r) => r[k]))]).filter(([, v]) => v !== undefined));
    const recs = items.map((r) => {
      const o = {};
      for (const [k, short] of PACK_KEYS) {
        let v = r[k];
        if (v === undefined) continue;
        if (k === "id") v = v.slice(parent.length + 1);
        else if (k === "slug" && r.id === `${parent}/${v}`) v = 1; // same as the id's suffix
        else if (k === "url" && origin && v.startsWith(origin + "/")) v = v.slice(origin.length);
        else if (k in defaults && defaults[k] === v) continue;
        o[short] = v;
      }
      for (const k of Object.keys(defaults)) if (r[k] === undefined) o["-" + k] = 1; // a default the record does not have
      return o;
    });
    return [parent, origin, defaults, recs];
  });
  const postings = {};
  for (const [t, p] of Object.entries(idx.postings)) {
    const out = [];
    for (let k = 0, last = 0; k < p.length; k += 3) {
      out.push((p[k] - last).toString(36), p[k + 1].toString(36), p[k + 2].toString(36));
      last = p[k];
    }
    postings[t] = out.join(",");
  }
  return { ...idx, packed: 1, items, postings };
}

export function unpackIndex(idx) {
  if (!idx?.packed) return idx;
  const items = [];
  for (const [parent, origin, defaults, recs] of idx.items) {
    const dkeys = Object.keys(defaults);
    for (const o of recs) {
      const r = { id: `${parent}/${o.i}`, parent };
      for (const short in o) {
        const k = LONG_KEY[short];
        if (!k || k === "id") continue;
        let v = o[short];
        if (k === "url" && origin && v.startsWith("/")) v = origin + v;
        else if (k === "slug" && v === 1) v = o.i;
        r[k] = v;
      }
      for (const k of dkeys) if (r[k] === undefined && !o["-" + k]) r[k] = defaults[k];
      items.push(r);
    }
  }
  // Posting lists are decoded on first use: a query touches a few dozen of the ~24k terms, so startup
  // stays as fast as with the unpacked file. P[t] and Object.keys(P) are all createSearch() needs.
  const raw = idx.postings;
  const decoded = new Map();
  const decode = (str) => {
    const nums = str.split(",").map((x) => parseInt(x, 36));
    for (let k = 0, last = 0; k < nums.length; k += 3) last = nums[k] += last;
    return nums;
  };
  const postings = new Proxy(raw, {
    get(target, t) {
      if (typeof t !== "string" || !Object.hasOwn(target, t)) return undefined;
      let p = decoded.get(t);
      if (!p) decoded.set(t, (p = decode(target[t])));
      return p;
    },
    getOwnPropertyDescriptor(target, t) {
      const d = Reflect.getOwnPropertyDescriptor(target, t);
      return d && { ...d, value: this.get(target, t) };
    },
  });
  const { packed, ...rest } = idx;
  return { ...rest, items, postings };
}

/** The prebuilt index when it is newer than catalog.json, else null (the caller builds one in memory). */
export function loadIndex() {
  if (!existsSync(INDEX_FILE)) return null;
  if (statSync(INDEX_FILE).mtimeMs < statSync(FILE.catalog).mtimeMs) return null;
  const idx = loadJSON(INDEX_FILE);
  return idx?.schema === INDEX_SCHEMA ? unpackIndex(idx) : null;
}

// ---------------------------------------------------------------- query


// Phrase lookup tables built once from the taxonomy. Each row's alts are scored as the sum of their terms,
// so "free fonts" rewards a fonts-category entry that says "fonts" over a release page named "Free … Fonts".
function phraseTable() {
  const rows = [];
  const seen = new Set();
  const push = (phrase, row) => {
    const p = split(phrase);
    const key = p.join(" ") + "|" + row.kind;
    if (!p.length || seen.has(key)) return;
    seen.add(key);
    rows.push({ phrase: p, ...row });
  };
  const elementIds = new Set(TAXONOMY.elements.map((e) => e.id));
  for (const s of TAXONOMY.synonyms) {
    // a synonym group named after an element (pricing-plans, toggle-switch, modal-dialog) also means that element
    const el = s.id.split("-").find((p) => elementIds.has(p));
    const tag = el ? [elTerm(el)] : [];
    for (const a of s.aliases)
      push(a, {
        kind: "synonym",
        group: s.id,
        alts: [{ terms: [...tokens(a), ...tag], weight: 1 }, ...s.aliases.filter((x) => x !== a).map((x) => ({ terms: [...tokens(x), ...tag], weight: 0.7 }))],
      });
  }
  for (const c of TAXONOMY.categories)
    for (const a of c.aliases) push(a, { kind: "category", alts: [{ terms: [...tokens(a), catTerm(c.id)], weight: 1 }] });
  for (const a of TAXONOMY.aliases_tr) {
    const isCat = a.target === "categories";
    const target = (isCat ? TAXONOMY.categories : a.target === "elements" ? TAXONOMY.elements : TAXONOMY.types).find((x) => x.id === a.id);
    if (!target) continue;
    const tag = isCat ? catTerm(a.id) : a.target === "elements" ? elTerm(a.id) : null;
    const english = [target.label, ...(target.aliases || []).slice(0, 4)];
    const alts = english.map((x) => ({ terms: [...tokens(x), ...(tag ? [tag] : [])], weight: 0.9 }));
    if (tag) alts.push({ terms: [tag], weight: 0.9 });
    for (const p of a.aliases) push(p, { kind: "tr", alts: [{ terms: tokens(p), weight: 1 }, ...alts] });
  }
  return rows.sort((a, b) => b.phrase.length - a.phrase.length);
}

const editDistance1 = (a, b) => {
  if (Math.abs(a.length - b.length) > 1 || a === b) return a === b;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
};

export function createSearch(entries, index) {
  const N = index.docs;
  const E = index.entries;
  const P = index.postings;
  const items = index.items;
  const byEntryId = new Map(entries.map((e, n) => [e.id, n]));
  const entryOfItem = items.map((i) => byEntryId.get(i.parent));
  const PHRASES = phraseTable();
  const vocab = Object.keys(P).filter((t) => !t.includes(":"));
  const idf = (t) => {
    const p = P[t];
    if (!p) return 0;
    const df = p.length / 3;
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  };
  const isItem = (d) => d >= E;
  const itemOf = (d) => items[d - E];
  const entryOf = (d) => (d < E ? entries[d] : entries[entryOfItem[d - E]]);

  /** One query → concepts: [{ word, alts: [{ terms: [term], weight }] }] (score of a concept = best alt). */
  function analyse(query) {
    // Phrases are matched on every word ("list has no items" → empty-state); stopwords only never score alone.
    const words = split(query);
    const used = words.map(() => false);
    const concepts = [];
    const els = [];
    // tag.mjs tokenises ASCII-only: map its token positions back to our words
    const at = [];
    words.forEach((w, k) => tokAscii(w).forEach(() => at.push(k)));
    const text = words.join(" ");
    const take = (a, b) => {
      for (let k = a; k <= b; k++) used[k] = true;
      return words.slice(a, b + 1).join(" ");
    };
    // 1. taxonomy elements and variants ("nav menu" → el:navbar, "mega menu navbar" → + va:navbar/mega-menu)
    for (const h of elementsIn(text, { field: "name" })) {
      if (els.includes(h.el) || at[h.span[0]] === undefined) continue;
      els.push(h.el);
      const word = take(at[h.span[0]], at[h.span[1] - 1]);
      const typed = split(word).filter((w) => !STOP.has(w)).map(stemWord);
      // the tag and the typed words add up: "Navbar Gallery" (tag + name) ranks above a tagged "awwwards-nav".
      // When a stopword was dropped the words no longer mean the phrase, so they count only on a tagged doc (`gated`):
      // "no items" (empty-state) types just "item", which every "List Item" has.
      const gated = typed.length < split(word).length;
      concepts.push({ word, kind: "element", el: h.el, alts: [{ terms: [elTerm(h.el), ...typed], weight: 1, gated }] });
    }
    for (const el of els)
      for (const v of variantsIn(text, el)) {
        const va = TAXONOMY.elements.find((e) => e.id === el).variants.find((x) => x.id === v);
        const alias = va.aliases.find((a) => text.includes(a)) || v;
        split(alias).forEach((w) => {
          const k = words.indexOf(w);
          if (k >= 0) used[k] = true;
        });
        concepts.push({ word: alias, kind: "variant", el, variant: v, alts: [{ terms: [vaTerm(el, v), ...tokens(alias)], weight: 1 }] });
      }
    // 2. synonyms, categories and Turkish aliases, longest phrase first; one concept per synonym group
    const stems = words.map(stemWord);
    const groups = new Set();
    for (const row of PHRASES)
      for (let i = 0; i + row.phrase.length <= words.length; i++) {
        if (row.phrase.some((w, j) => used[i + j] || (words[i + j] !== w && stems[i + j] !== stemWord(w)))) continue;
        if (row.phrase.every((w) => STOP.has(w))) continue;
        const word = take(i, i + row.phrase.length - 1);
        if (row.group && groups.has(row.group)) continue;
        if (row.group) groups.add(row.group);
        concepts.push({ word, kind: row.kind, alts: row.alts });
      }
    // 3. the remaining words, with a fuzzy fallback for unknown words of 5+ letters
    words.forEach((w, k) => {
      if (used[k] || STOP.has(w)) return;
      const t = stemWord(w);
      const alts = [{ terms: [t], weight: 1 }];
      if (!P[t] && w.length >= 5) for (const v of vocab) if (editDistance1(t, v)) alts.push({ terms: [v], weight: 0.6 });
      concepts.push({ word: w, kind: "word", alts });
    });
    return { concepts, elements: els, empty: !words.length };
  }

  // BM25F contribution of one term: Map(doc → [score, mask])
  function termScores(t) {
    const p = P[t];
    const out = new Map();
    if (!p) return out;
    const w = idf(t);
    for (let k = 0; k < p.length; k += 3) {
      const d = p[k];
      const tf = p[k + 1] / 100;
      out.set(d, [(w * tf * (K1 + 1)) / (tf + K1), p[k + 2]]);
    }
    return out;
  }

  const termCache = new Map();
  const scoresOf = (t) => {
    if (!termCache.has(t)) {
      if (termCache.size > 2000) termCache.clear();
      termCache.set(t, termScores(t));
    }
    return termCache.get(t);
  };

  const fieldNames = (mask) => FIELDS.filter((_, i) => mask & (1 << i));

  // Prior: small, capped. Readable entries and items with code first; no popularity.
  // Items an auto pattern wrote (`auto: true`, tools/sitemap-items.mjs) are one of hundreds of
  // look-alikes on the same site: they rank just below curated and hand-mapped items.
  const AUTO_ITEM = 0.92;
  function prior(d) {
    if (isItem(d)) {
      const i = itemOf(d);
      return (i.access === "code" ? 1.06 : i.access === "gated" ? 0.94 : 1) * (i.local ? 1.04 : 1) * (i.auto ? AUTO_ITEM : 1);
    }
    const e = entries[d];
    if (e.reach && e.reach.ok === false) return 0.85;
    const p = e.probe || {};
    return p.registry || p.registry_index || p.registry_root || p.llms || e.kind === "repo" ? 1.08 : 1;
  }

  /** filters: { element, variant, kind, category, registry, access, stack, scope: "all" | "entries" | "items" } */
  function passes(d, f) {
    if (f.scope === "entries" && isItem(d)) return false;
    if (f.scope === "items" && !isItem(d)) return false;
    const entry = entryOf(d);
    if (f.kind && (isItem(d) || entry.kind !== f.kind)) return false;
    if (f.category && !entry?.categories.includes(f.category)) return false;
    if (f.registry && (!isItem(d) || (entry.id !== f.registry && entry.domain !== f.registry))) return false;
    if (isItem(d)) {
      const i = itemOf(d);
      if (f.element && !(i.elements || []).includes(f.element)) return false;
      if (f.variant && !Object.values(i.variants || {}).some((vs) => vs.includes(f.variant))) return false;
      if (f.access && i.access !== f.access) return false;
      if (f.stack && !(i.stacks || []).includes(f.stack)) return false;
    } else {
      if (f.element && !index.entry_elements[d].includes(f.element)) return false;
      if (f.variant || f.access || f.stack) return false;
    }
    return true;
  }

  /** → { analysis, ranked: [{ d, score, matched: [[word, field]] }] } over every doc that passes the filters */
  function rank(query, f = {}) {
    const analysis = analyse(query || "");
    const { concepts } = analysis;
    const acc = new Map(); // doc → { s, hit: count of concepts, matched }
    for (const c of concepts) {
      const best = new Map(); // doc → [score, mask]
      for (const alt of c.alts) {
        // tags (el:, va:, cat:) add up on their own; the words of an alt count only when all of them are there,
        // so "no items" (empty state) does not reward every "list item"
        const tags = alt.terms.filter((t) => t.includes(":")).map(scoresOf);
        const words = alt.terms.filter((t) => !t.includes(":")).map(scoresOf);
        const docs = new Set([...tags, ...words].flatMap((m) => [...m.keys()]));
        for (const d of docs) {
          let s = 0;
          let mask = 0;
          for (const m of tags) {
            const v = m.get(d);
            if (v) {
              s += v[0];
              mask |= v[1];
            }
          }
          if ((!alt.gated || s) && words.every((m) => m.has(d)))
            for (const m of words) {
              const v = m.get(d);
              s += v[0];
              mask |= v[1];
            }
          if (!s) continue;
          s *= alt.weight;
          const cur = best.get(d);
          if (!cur || s > cur[0]) best.set(d, [s, mask]);
        }
      }
      for (const [d, [s, mask]] of best) {
        let a = acc.get(d);
        if (!a) acc.set(d, (a = { s: 0, hit: 0, matched: [] }));
        a.s += s;
        a.hit++;
        a.matched.push([c.word, fieldNames(mask)[0] || "text"]);
      }
    }
    const ranked = [];
    if (!concepts.length) {
      // filters only: every passing doc, code first, then by name
      for (let d = 0; d < N; d++) if (passes(d, f)) ranked.push({ d, score: prior(d), matched: [] });
      const nameOf = (d) => (isItem(d) ? itemOf(d).name : entries[d].name).toLowerCase();
      ranked.sort((a, b) => b.score - a.score || nameOf(a.d).localeCompare(nameOf(b.d)));
      return { analysis, ranked };
    }
    const n = concepts.length;
    for (const [d, a] of acc) {
      if (!passes(d, f)) continue;
      const coverage = a.hit / n;
      const score = a.s * (0.35 + 0.65 * coverage * coverage) * (a.hit === n && n > 1 ? 1.25 : 1) * prior(d);
      ranked.push({ d, score, matched: a.matched });
    }
    ranked.sort((a, b) => b.score - a.score || a.d - b.d);
    return { analysis, ranked };
  }

  return { analyse, rank, isItem, itemOf, entryOf, entries, items, N, E, entryElements: index.entry_elements };
}

// Sectioning and section ranking for one model-readable document (brief 07 — get_content).
// Pure functions over text: no network, no file reads. tools/mcp.mjs caches the result per document.
//
//   splitSections(text)  → [{ n, title, path, source, start, end, chars }]  (deterministic, no model)
//   sectionStats(text, sections) → BM25 term stats (postings) over the sections
//   rankSections(text, sections, concepts, { limit, offset, stats }) → { hits: [{ n, score }], total }
//   bestWindow(text, section, concepts, { size }) → the best ~size-char window of one section
//
// Boundaries, in priority order: markdown headings outside fenced code blocks; the `---` page
// separators llms-full generators emit (they carry a `Source:` / `URL:` line); and, for a stretch a
// heading never interrupts (sunglasses.dev is 2.3 MB of flat pages under two `#` lines), fixed
// ~3 KB chunks cut at blank lines.
import { TAXONOMY } from "./tag.mjs";
import { tokens, stemWord, split } from "./search.mjs";

const K1 = 1.2;
const B = 0.75;
const MIN_SECTION = 200; // a shorter section is merged into the next one
const MAX_SECTION = 12_000; // a longer section is split at blank lines
const FLAT_SPAN = 200_000; // a stretch this long with no heading at all is a dump: chunk it
const CHUNK = 3_000; // fixed chunk length when a text has no headings at all
const CHUNK_FLOOR = 1_200; // …but never cut a chunk under this, even without a blank line
const CHUNK_CLIP = 80; // title = the chunk's first non-empty line, clipped to this
const META_SCAN = 600; // a section's own `Source:` / `URL:` line must sit in its first chars
const FENCE_W = 0.3; // a word inside a fenced code block is an identifier, not the topic
const PREFIX_W = 0.8; // "deploy" also reaches "deployment" at this weight
const PREFIX_MIN = 4; // …for query words of this many characters or more
const OWN_HEAD_W = 2; // a concept the section's own heading carries
const PARENT_HEAD_W = 1; // a concept only a heading above it carries
const ALL_MATCH_BONUS = 1.25; // every concept matched (the same idea as tools/search.mjs)
const NON_LATIN_MAX = 0.3; // a section this much CJK/non-Latin is a translation of the page
const NON_LATIN_PENALTY = 0.5; // …and ranks below the original when the query is ASCII
const META_RE = /^\s*(?:Source|URL):\s*(\S.*?)\s*$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const CLOSE_FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*$/;
const HEADING_RE = /^(#{1,3})[ \t]+(\S.*?)[ \t]*#*[ \t]*$/;
const ANCHOR_RE = /\s*\[#[\w.-]+\]\s*$/; // "## Install Hooks [#install-hooks]" → "Install Hooks"
const LETTER_RE = /\p{L}/u;
const LATIN_RE = /\p{Script=Latin}/u;
const NON_ASCII_RE = /[^\x00-\x7F]/;

/** Lines with their start offsets, so a boundary can be sliced back out of the text. */
function linesOf(text) {
  const out = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? text.length : nl;
    out.push({ start, end, text: text.slice(start, end) });
    if (nl < 0) return out;
    start = nl + 1;
  }
}

const headingTitle = (raw) => raw.replace(ANCHOR_RE, "").trim();

/** Toggles the fenced-code-block state on one line: null outside, { ch, len, at } inside. */
function fenceStep(fence, lineText, at) {
  if (fence) {
    const close = CLOSE_FENCE_RE.exec(lineText);
    return close && close[1][0] === fence.ch && close[1].length >= fence.len ? null : fence;
  }
  const open = FENCE_RE.exec(lineText);
  return open ? { ch: open[1][0], len: open[1].length, at } : null;
}

/** The fenced-code-block ranges of a text slice — the same fence rules splitSections applies. */
function fenceRanges(text) {
  const out = [];
  let fence = null;
  let at = 0;
  for (const line of text.split("\n")) {
    const inside = fence;
    fence = fenceStep(fence, line, at);
    if (inside && !fence) out.push([inside.at, at + line.length]); // the closer ends the block
    at += line.length + 1;
  }
  if (fence) out.push([fence.at, text.length]);
  return out;
}

/** The URL a `Source:` / `URL:` line carries (`Source: [url](url)` included), else null. */
function metaUrl(line) {
  const m = META_RE.exec(line);
  if (!m) return null;
  const link = /^\[([^\]\s]+)\]\(/.exec(m[1]); // replit.com writes Source: [https://…](https://…)
  return (link ? link[1] : m[1].split(/\s+/)[0]) || null;
}

/** The first `Source:` / `URL:` URL inside [from, to) — `metas` is sorted by offset. */
function metaIn(metas, from, to) {
  let lo = 0;
  let hi = metas.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (metas[mid].start < from) lo = mid + 1;
    else hi = mid;
  }
  return metas[lo] && metas[lo].start < to ? metas[lo].url : null;
}

/** The first non-empty line of a text (skipping `---` markers) — the title of a chunk or a preamble. */
function firstLine(text, clip = CHUNK_CLIP) {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || /^-{3,}$/.test(t)) continue;
    return t.length > clip ? t.slice(0, clip - 1).trimEnd() + "…" : t;
  }
  return "(empty)";
}

/** A cut at the last blank line before `to` (never before start + CHUNK_FLOOR), else straight at `to`. */
function cutPoint(text, start, to) {
  const floor = Math.min(to, start + CHUNK_FLOOR);
  for (let i = to; i > floor; i--) {
    if (text[i] !== "\n") continue;
    const prev = text.lastIndexOf("\n", i - 1);
    if (prev < 0 || !text.slice(prev + 1, i).trim()) return i - 1; // blank line above: end the chunk there
  }
  return to;
}

/**
 * Fixed chunks for a heading-free span: ~3 KB, cut at a blank line, titled by its first line. A
 * chunk also inherits the `URL:` / `Source:` line above it, so a flat dump keeps its page URLs.
 */
function chunks(text, from, to, metas) {
  let meta = null;
  let mi = 0;
  while (mi < metas.length && metas[mi].start <= from) meta = metas[mi++].url;
  const out = [];
  for (let start = from; start < to; ) {
    let end = Math.min(to, start + CHUNK);
    if (end < to) end = cutPoint(text, start, end);
    while (mi < metas.length && metas[mi].start <= start) meta = metas[mi++].url;
    let cut = end;
    while (cut > start && /\s/.test(text[cut - 1])) cut--;
    if (cut > start) out.push({ start, end: cut, level: 1, title: firstLine(text.slice(start, cut)), source: meta });
    start = Math.max(end, start + 1);
  }
  return out;
}

/** A section longer than MAX_SECTION, cut at blank lines (a hard cut when a stretch has none). */
function splitLong(text, s) {
  const out = [];
  for (let start = s.start; start < s.end; ) {
    let end = Math.min(s.end, start + MAX_SECTION);
    if (end < s.end) end = cutPoint(text, start, end);
    let to = end;
    while (to > start && /\s/.test(text[to - 1])) to--;
    if (to > start) out.push({ ...s, start, end: to });
    start = Math.max(end, start + 1);
  }
  return out;
}

/**
 * Split one document into sections. Every section is a real slice of `text` ([start, end)), `n` is
 * 1-based and stable for a given text, and `source` is the page URL a separator or a metadata line
 * carries (null when the text has none).
 */
export function splitSections(text) {
  const lines = linesOf(text);
  const headings = []; // { start, level, title } — outside fenced code blocks
  const separators = []; // { start, line } — a `---` line that may open a page
  const metas = []; // { start, url } — every `Source:` / `URL:` line, so a section can take one
  let fence = null; // { ch, len } while inside ``` or ~~~
  lines.forEach((line, i) => {
    const step = fenceStep(fence, line.text, line.start);
    if (fence) {
      fence = step; // a line inside a fence, its closer included
      return;
    }
    if (step) {
      fence = step; // the line that opens one
      return;
    }
    const url = metaUrl(line.text);
    if (url) metas.push({ start: line.start, url });
    const h = HEADING_RE.exec(line.text);
    if (h) headings.push({ start: line.start, level: h[1].length, title: headingTitle(h[2]) });
    else if (line.text.trim() === "---") separators.push({ start: line.start, line: i });
  });

  // `---` + a heading, or `---` + a `Source:` / `URL:` line, opens a page. A page with no heading
  // anywhere is a flat dump (sunglasses.dev's 112 `---`/`URL:` blocks): its `---` lines carry page
  // metadata, they do not section it — the chunker handles that text better.
  const pages = new Map(); // separator start → the heading that entitles its page
  let hi = 0; // both lists are in ascending order: one forward pass
  for (let si = 0; si < separators.length; si++) {
    const sep = separators[si];
    let j = sep.line + 1;
    while (j < lines.length && !lines[j].text.trim()) j++;
    const first = lines[j]?.text ?? "";
    if (!HEADING_RE.test(first) && !META_RE.test(first)) continue;
    const end = separators[si + 1]?.start ?? text.length;
    while (hi < headings.length && headings[hi].start <= sep.start) hi++;
    const h = headings[hi];
    if (h && h.start < end) pages.set(sep.start, h);
  }
  const claimed = new Set([...pages.values()].map((h) => h.start));
  const boundaries = [
    ...[...pages].map(([start, h]) => ({ start, level: h.level, title: h.title, page: true })),
    ...headings.filter((h) => !claimed.has(h.start)).map((h) => ({ start: h.start, level: h.level, title: h.title })),
  ].sort((a, b) => a.start - b.start || b.level - a.level);

  const raw = [];
  const push = (start, end, level, title, path) => {
    let to = end;
    while (to > start && /\s/.test(text[to - 1])) to--;
    if (to > start) raw.push({ start, end: to, level, title, path });
  };
  const trail = [];
  boundaries.forEach((b, i) => {
    if (i === 0 && text.slice(0, b.start).trim()) {
      const t = firstLine(text.slice(0, b.start));
      push(0, b.start, 1, t, t);
    }
    // a `---` page starts a new page: its heading is nobody's child
    if (b.page) trail.length = 0;
    while (trail.length && trail[trail.length - 1].level >= b.level) trail.pop();
    trail.push({ level: b.level, title: b.title });
    push(b.start, boundaries[i + 1]?.start ?? text.length, b.level, b.title, trail.map((s) => s.title).join(" › "));
  });
  if (!boundaries.length) raw.push(...chunks(text, 0, text.length, metas));

  // A section's own `Source:` / `URL:` line (under the separator, or under its heading) is its source.
  for (const s of raw) if (s.source === undefined) s.source = metaIn(metas, s.start, Math.min(s.end, s.start + META_SCAN));

  // A tiny section folds into the next one (a trailing tiny one into the previous), source included.
  const merged = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (s.end - s.start < MIN_SECTION && raw.length > 1) {
      if (raw[i + 1]) {
        if (raw[i + 1].source == null) raw[i + 1].source = s.source;
        raw[i + 1].start = s.start;
        continue;
      }
      if (merged.length) {
        if (merged[merged.length - 1].source == null) merged[merged.length - 1].source = s.source;
        merged[merged.length - 1].end = s.end;
        continue;
      }
    }
    merged.push({ ...s });
  }
  // A 200 KB stretch with no heading in it (sunglasses.dev's flat page dump) is chunked, not cut
  // blindly at 12 KB; anything else long is cut at blank lines.
  const out = merged.flatMap((s) =>
    s.end - s.start > FLAT_SPAN ? chunks(text, s.start, s.end, metas) : s.end - s.start > MAX_SECTION ? splitLong(text, s) : [s],
  );
  return out.map((s, i) => ({
    n: i + 1,
    title: s.title,
    path: s.path ?? s.title,
    source: s.source ?? null,
    depth: s.level,
    start: s.start,
    end: s.end,
    chars: s.end - s.start,
  }));
}

/** Every token of `text` with its offset — search.mjs's split()+stemWord, camelCase boundaries included. */
function tokenizeSpans(text) {
  const out = [];
  const re = /[\p{L}\p{N}]+/gu;
  for (let m; (m = re.exec(text)); ) {
    const lower = m[0].toLocaleLowerCase("en");
    let at = 0;
    for (const piece of split(m[0])) {
      const i = lower.indexOf(piece, at);
      const rel = i < 0 ? at : i;
      out.push({ term: stemWord(piece), at: m.index + rel });
      at = rel + piece.length;
    }
  }
  return out;
}

/** Tokens of a section's own heading and of the heading trail above it. */
function headTokens(s) {
  const own = new Set(tokens(s.title));
  const parents = new Set();
  if (s.path.length > s.title.length && s.path.endsWith(s.title))
    for (const t of tokens(s.path.slice(0, s.path.length - s.title.length))) parents.add(t);
  for (const t of own) parents.delete(t);
  return { own, parents };
}

/** Share of a section's letters that are not Latin script: gpui-kit ships a zh copy of every page. */
function nonLatinRatio(text) {
  if (!NON_ASCII_RE.test(text)) return 0;
  let letters = 0;
  let foreign = 0;
  for (const ch of text) {
    if (!LETTER_RE.test(ch)) continue;
    letters++;
    if (!LATIN_RE.test(ch)) foreign++;
  }
  return letters ? foreign / letters : 0;
}

/**
 * BM25 term stats over the sections: postings[term] = flat [section index, weighted tf, …]. Built once
 * per document and cached by the server. Only the body counts here — the headings are scored
 * separately (rankSections' title bonus) — and a word inside a fenced code block counts FENCE_W.
 */
export function sectionStats(text, sections) {
  const postings = new Map();
  const parentTerms = new Map(); // term → sections whose heading trail above carries it
  const lens = [];
  const heads = [];
  const nonLatin = [];
  sections.forEach((s, i) => {
    const body = text.slice(s.start, s.end);
    const fences = fenceRanges(body);
    const tf = new Map();
    let fi = 0;
    for (const { term, at } of tokenizeSpans(body)) {
      while (fi < fences.length && fences[fi][1] <= at) fi++;
      const inFence = fi < fences.length && fences[fi][0] <= at;
      tf.set(term, (tf.get(term) || 0) + (inFence ? FENCE_W : 1));
    }
    let len = 0;
    for (const [t, n] of tf) {
      let p = postings.get(t);
      if (!p) postings.set(t, (p = []));
      p.push(i, n);
      len += n;
    }
    lens.push(len);
    const head = headTokens(s);
    heads.push(head);
    for (const t of head.parents) {
      let p = parentTerms.get(t);
      if (!p) parentTerms.set(t, (p = []));
      p.push(i);
    }
    nonLatin.push(nonLatinRatio(body));
  });
  const avg = Math.max(1, lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length));
  return { N: sections.length, lens, avg, postings, parentTerms, vocab: [...postings.keys()], heads, nonLatin };
}

// el:modal → "modal", "dialog", "alert dialog", "confirm dialog", "lightbox", "popup": the tag is
// what the taxonomy knows, the words are what a heading says. Sections never carry `el:`/`va:`/`cat:`
// terms, so they are always expanded — and each alias is kept as a token *group*: "side sheet" means
// side **and** sheet, or the generic "side" would match every Sidebar on the page. A tag then scores
// as its best matching group, like a concept scores as its best alt.
const ELEMENTS = new Map(TAXONOMY.elements.map((e) => [e.id, e]));
const CATEGORIES = new Map(TAXONOMY.categories.map((c) => [c.id, c]));
const TAG_CACHE = new Map();
const LABEL_SPLIT = /[/|·,&]+/; // "Drawer / sheet" lists two alternatives, it is not a phrase

export function expandTag(term) {
  if (TAG_CACHE.has(term)) return TAG_CACHE.get(term);
  const groups = [];
  const seen = new Set();
  const push = (s) => {
    const toks = tokens(s);
    if (!toks.length) return;
    const key = toks.join(" ");
    if (seen.has(key)) return;
    seen.add(key);
    groups.push(toks);
  };
  let source = null;
  if (term.startsWith("el:")) source = ELEMENTS.get(term.slice(3));
  else if (term.startsWith("va:")) {
    const [el, id] = term.slice(3).split("/");
    source = ELEMENTS.get(el)?.variants?.find((x) => x.id === id);
  } else if (term.startsWith("cat:")) source = CATEGORIES.get(term.slice(4));
  if (source) {
    push(source.id);
    for (const part of String(source.label || "").split(LABEL_SPLIT)) push(part);
    for (const a of source.aliases || []) push(a);
  }
  TAG_CACHE.set(term, groups);
  return groups;
}

/** Every token the tag's aliases can match (the union of its groups). */
export function tagTokens(term) {
  const out = [];
  for (const g of expandTag(term)) for (const t of g) if (!out.includes(t)) out.push(t);
  return out;
}

/** Every word a concept can match, tag expansions included — the set the window scorer looks for. */
function conceptWords(concepts) {
  const words = new Map();
  for (const c of concepts)
    for (const alt of c.alts || [])
      for (const t of alt.terms) {
        const list = t.includes(":") ? tagTokens(t) : [t];
        for (const w of list) if (!words.has(w)) words.set(w, alt.weight ?? 1);
      }
  return words;
}

/**
 * BM25 over the sections, on top of three corrections that plain BM25 gets wrong on real docs:
 *
 *  - the headings are scored separately, not folded into tf (where more words just saturate): a
 *    concept the section's own heading carries adds idf × 2, one only a heading above it adds idf × 1;
 *  - a query word of 4+ characters also reaches its longer forms (deploy → deployment) at 0.8×;
 *  - a section that is mostly CJK/non-Latin is a translation of the page: × 0.5 for an ASCII query.
 *
 * Each concept scores as its best alternative × weight — and a word the alternative's tag already
 * covers is dropped (el:drawer + drawer is one concept: drawer, sheet, slide over …), so a "Sheet"
 * section and a "Drawer" section score the same on it. The concepts add up, a section that matched
 * every one of them gets ×1.25 (same idea as tools/search.mjs), ties go to the earlier section, and
 * sections that score 0 are not returned.
 */
export function rankSections(text, sections, concepts, { limit = 4, offset = 0, stats } = {}) {
  const st = stats || sectionStats(text, sections);
  const idf = (t) => {
    const df = (st.postings.get(t)?.length ?? 0) / 2;
    return df ? Math.log(1 + (st.N - df + 0.5) / (df + 0.5)) : 0;
  };
  const termDocs = new Map();
  const docsOf = (t) => {
    let m = termDocs.get(t);
    if (m) return m;
    termDocs.set(t, (m = new Map()));
    const p = st.postings.get(t);
    if (!p) return m;
    const w = idf(t);
    for (let k = 0; k < p.length; k += 2) {
      const tf = p[k + 1];
      const norm = 1 - B + B * (st.lens[p[k]] / st.avg);
      m.set(p[k], (w * tf * (K1 + 1)) / (tf + K1 * norm));
    }
    return m;
  };

  // A word's longer forms ("deployment" for "deploy"), cached per query term: section → [score, token].
  const forms = new Map();
  const formsOf = (t) => {
    let list = forms.get(t);
    if (list) return list;
    list = [];
    if (t.length >= PREFIX_MIN) for (const v of st.vocab) if (v.length > t.length && v.startsWith(t)) list.push(v);
    forms.set(t, list);
    return list;
  };
  const wordDocs = new Map();
  const wordOf = (t) => {
    let m = wordDocs.get(t);
    if (m) return m;
    wordDocs.set(t, (m = new Map()));
    for (const [i, score] of docsOf(t)) m.set(i, [score, t]);
    for (const v of formsOf(t))
      for (const [i, score] of docsOf(v)) {
        const cur = m.get(i);
        if (!cur || score * PREFIX_W > cur[0]) m.set(i, [score * PREFIX_W, v]);
      }
    return m;
  };
  const headBonus = (via, i) => {
    const { own, parents } = st.heads[i];
    let bonus = 0;
    let parent = 0;
    for (const t of via) {
      if (own.has(t)) bonus = Math.max(bonus, idf(t) * OWN_HEAD_W);
      else if (parents.has(t)) parent = Math.max(parent, idf(t) * PARENT_HEAD_W);
    }
    return bonus || parent;
  };
  const asciiQuery = concepts.every((c) => (c.alts || []).every((a) => a.terms.every((t) => !NON_ASCII_RE.test(t))));

  const scores = new Map();
  const matched = new Map();
  for (const c of concepts) {
    const best = new Map();
    for (const alt of c.alts || []) {
      const tags = [...new Set(alt.terms.filter((t) => t.includes(":")))];
      const covered = new Set(tags.flatMap(tagTokens));
      const words = [...new Set(alt.terms.filter((t) => !t.includes(":")))].filter((t) => !covered.has(t));
      const parts = words.map((t) => [t, wordOf(t)]);
      const tagParts = tags.map((t) => expandTag(t).map((group) => group.map((x) => [x, docsOf(x)]))).filter((x) => x.length);
      const candidates = new Set([...parts.flatMap(([, m]) => [...m.keys()]), ...tagParts.flatMap((set) => set.flatMap((group) => group.flatMap(([, m]) => [...m.keys()])))]);
      for (const i of candidates) {
        let s = 0;
        const via = new Set();
        if (parts.every(([, m]) => m.has(i)))
          for (const [, m] of parts) {
            const [score, token] = m.get(i);
            s += score;
            via.add(token);
          }
        for (const set of tagParts) {
          let hit = 0;
          let group = null;
          for (const g of set) {
            let sum = 0;
            let top = 0;
            let token = null;
            for (const [x, m] of g) {
              const score = m.get(i) || 0;
              if (!score) {
                sum = 0; // every word of an alias group has to be there ("side sheet", not "side")
                break;
              }
              sum += score;
              if (score > top) {
                top = score;
                token = x;
              }
            }
            if (sum > hit) {
              hit = sum;
              group = { g, token };
            }
          }
          if (hit) {
            s += hit;
            via.add(group.token);
            for (const [x] of group.g) via.add(x);
          }
        }
        if (s <= 0) continue;
        s = (s + headBonus(via, i)) * (alt.weight ?? 1);
        const cur = best.get(i);
        if (cur === undefined || s > cur) best.set(i, s);
      }
      // A concept the heading trail above carries, but the section's own text never repeats, still
      // names the section — that is the whole point of "Drawer › Props": score it idf × 1.
      const trail = new Map();
      for (const t of [...words, ...tags.flatMap(tagTokens)]) {
        const score = idf(t) * PARENT_HEAD_W;
        for (const i of st.parentTerms.get(t) || []) {
          if (best.has(i) || score <= (trail.get(i) || 0)) continue;
          trail.set(i, score);
        }
      }
      for (const [i, s] of trail) {
        const cur = best.get(i);
        if (cur === undefined || s > cur) best.set(i, s);
      }
    }
    for (const [i, s] of best) {
      scores.set(i, (scores.get(i) || 0) + s);
      matched.set(i, (matched.get(i) || 0) + 1);
    }
  }
  const n = concepts.length;
  const ranked = [];
  for (const [i, s] of scores) {
    let score = s * (matched.get(i) === n && n > 1 ? ALL_MATCH_BONUS : 1);
    if (asciiQuery && st.nonLatin[i] > NON_LATIN_MAX) score *= NON_LATIN_PENALTY;
    ranked.push({ i, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.i - b.i);
  const from = Math.max(0, Number(offset) || 0);
  return { hits: ranked.slice(from, from + Math.max(0, Number(limit) || 0)).map((r) => ({ n: sections[r.i].n, score: r.score })), total: ranked.length };
}

/**
 * The best ~size-char window of one section for these concepts: the stretch holding the most query
 * weight, snapped back to a line start. Returns absolute offsets into `text`.
 */
export function bestWindow(text, section, concepts, { size = 2_500 } = {}) {
  const words = conceptWords(concepts);
  const hits = []; // { at, weight }
  const re = /[\p{L}\p{N}]+/gu;
  const body = text.slice(section.start, section.end);
  for (let m; (m = re.exec(body)); ) {
    const raw = m[0].toLocaleLowerCase("en");
    const stem = stemWord(raw);
    let w = words.get(raw) ?? words.get(stem);
    // a window should also open on "deployment" when the query said "deploy"
    if (w === undefined)
      for (const [t, weight] of words)
        if (t.length >= PREFIX_MIN && stem.length > t.length && stem.startsWith(t)) {
          w = weight * PREFIX_W;
          break;
        }
    if (w !== undefined) hits.push({ at: section.start + m.index, weight: w });
  }
  if (!hits.length) return { from: section.start, to: Math.min(section.end, section.start + size) };
  let best = null;
  for (let i = 0, j = 0, sum = 0; i < hits.length; i++) {
    sum -= i > 0 ? hits[i - 1].weight : 0;
    if (j < i) {
      j = i;
      sum = 0;
    }
    while (j < hits.length && hits[j].at - hits[i].at < size) sum += hits[j++].weight;
    if (!best || sum > best.sum) best = { sum, at: hits[i].at };
  }
  const back = Math.min(Math.floor(size / 8), best.at - section.start); // a little context before the first hit
  const at = Math.max(section.start, best.at - back);
  const nl = text.lastIndexOf("\n", at);
  const from = nl >= 0 && at - nl <= back && nl + 1 > section.start ? nl + 1 : at;
  return { from, to: Math.min(section.end, from + size) };
}

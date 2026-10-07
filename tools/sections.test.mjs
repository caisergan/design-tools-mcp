#!/usr/bin/env bun
// tools/sections.mjs: boundaries, heading trails, sources, chunking, and BM25 section ranking.
// Pure functions, inline fixtures, no network — only the taxonomy comes from the catalog.
import { test, expect } from "bun:test";
import { splitSections, sectionStats, rankSections, bestWindow, expandTag } from "./sections.mjs";
import { tokens } from "./search.mjs";

const line = (tag, i) => `${tag} line ${i}: enough words to keep this paragraph a section of its own.`;
const para = (tag, n = 6) => Array.from({ length: n }, (_, i) => line(tag, i)).join("\n");
/** One heading-delimited section of ~500 chars. */
const page = (heading, tag, n = 6) => `${heading}\n\n${para(tag, n)}\n`;
const body = (text, s) => text.slice(s.start, s.end);
/** The shape tools/search.mjs analyse() returns: tags stay, the typed words are already stemmed. */
const concept = (terms, kind = "word", extra = {}) => ({
  word: terms.join(" "),
  kind,
  alts: [{ terms: terms.flatMap((t) => (t.includes(":") ? [t] : tokens(t))), weight: 1 }],
  ...extra,
});

// ------------------------------------------------------------------ boundaries

test("headings become sections with a heading trail", () => {
  const text = `# Components\n\n${para("intro")}\n\n## Drawer\n\n${para("drawer")}\n\n### Props\n\n${para("props")}\n\n## Modal\n\n${para("modal")}\n`;
  const secs = splitSections(text);
  expect(secs.map((s) => s.path)).toEqual(["Components", "Components › Drawer", "Components › Drawer › Props", "Components › Modal"]);
  expect(secs.map((s) => s.title)).toEqual(["Components", "Drawer", "Props", "Modal"]);
  expect(secs.map((s) => s.n)).toEqual([1, 2, 3, 4]);
  expect(secs.map((s) => s.depth)).toEqual([1, 2, 3, 2]);
  expect(secs[0].start).toBe(0);
  for (const s of secs) {
    expect(s.chars).toBe(s.end - s.start);
    expect(s.chars).toBeGreaterThan(200);
  }
  expect(body(text, secs[1])).toContain("drawer line 0");
  expect(body(text, secs[1])).not.toContain("props line 0");
  expect(splitSections(text).map((s) => [s.n, s.path, s.chars])).toEqual(secs.map((s) => [s.n, s.path, s.chars]));
});

test("# and --- lines inside a fenced code block are not headings or page separators", () => {
  const text = `# Real\n\n${para("real")}\n\n\`\`\`sh\n# not a heading\n## nor this\n---\nSource: https://example.com/fake\n\`\`\`\n\n${para("after")}\n\n~~~\n### also not\n~~~\n\n## Second\n\n${para("second")}\n`;
  const secs = splitSections(text);
  expect(secs.map((s) => s.path)).toEqual(["Real", "Real › Second"]);
  expect(secs.map((s) => s.source)).toEqual([null, null]);
  expect(body(text, secs[0])).toContain("# not a heading");
  expect(body(text, secs[0])).toContain("### also not");
  // a four-backtick fence holds three-backtick lines without closing early
  const four = `# Real\n\n${para("real")}\n\n\`\`\`\`md\n\`\`\`\n## hidden\n\`\`\`\`\n\n## Second\n\n${para("second")}\n`;
  expect(splitSections(four).map((s) => s.path)).toEqual(["Real", "Real › Second"]);
});

test("--- page separators and metadata lines carry a source", () => {
  const text =
    `# Doc\n\n${para("head")}\n\n` +
    `---\n\n## Page One\n\nSource: https://example.com/one\n\n${para("one")}\n\n### Deep\n\n${para("deep")}\n\n` +
    `---\n\n## Page Two\n\nURL: https://example.com/two\n\n${para("two")}\n\n` +
    `# Loose\n\nURL: https://example.com/loose\n\n${para("loose")}\n`;
  const secs = splitSections(text);
  expect(secs.map((s) => s.path)).toEqual(["Doc", "Page One", "Page One › Deep", "Page Two", "Loose"]);
  expect(secs.map((s) => s.source)).toEqual([null, "https://example.com/one", null, "https://example.com/two", "https://example.com/loose"]);
  // a `---` with neither a heading nor a URL line after it is body text, not a page break
  const flat = `# A\n\n${para("a")}\n\n---\n\n${para("b")}\n\n---\n\n${para("c")}\n`;
  expect(splitSections(flat).map((s) => s.path)).toEqual(["A"]);
  expect(splitSections(flat)[0].source).toBe(null);
});

test("a text with no headings is chunked at ~3 KB, cut at blank lines, titled by its first line", () => {
  const text = Array.from({ length: 16 }, (_, i) => para(`topic${i}`)).join("\n\n");
  expect(text.length).toBeGreaterThan(7_000);
  const secs = splitSections(text);
  expect(secs.length).toBeGreaterThan(1);
  expect(secs[0].n).toBe(1);
  expect(secs[0].title).toBe(line("topic0", 0));
  expect(secs[0].source).toBe(null);
  for (const s of secs) {
    expect(s.chars).toBeLessThanOrEqual(3_000);
    expect(s.chars).toBeGreaterThan(1_000);
    expect(s.title.length).toBeLessThanOrEqual(80);
  }
  // every chunk but the last ends where a blank line begins
  for (const s of secs.slice(0, -1)) expect(text.slice(s.end, s.end + 2)).toBe("\n\n");
  // chunk n starts inside a paragraph, so its title is the text of that line, not a heading
  expect(secs[1].title).toContain("line");
});

test("a flat page dump under a title block is chunked too, keeping each page's URL", () => {
  const flat = (tag) => para(tag, 1_400);
  const text = `# Dump\n\n---\nURL: https://example.com/one\n\n${flat("one")}\n\n---\nURL: https://example.com/two\n\n${flat("two")}\n`;
  expect(text.length).toBeGreaterThan(200_000);
  const secs = splitSections(text);
  expect(secs.length).toBeGreaterThan(60);
  expect(secs[0].source).toBe(null); // the title block sits above the first URL line
  const rest = secs.slice(1).map((s) => s.source);
  expect(new Set(rest)).toEqual(new Set(["https://example.com/one", "https://example.com/two"]));
  expect(rest.indexOf("https://example.com/two")).toBeGreaterThan(rest.indexOf("https://example.com/one"));
  expect(secs.every((s) => s.chars <= 3_000)).toBe(true);
});

test("tiny sections merge into the next one, huge ones split at blank lines", () => {
  const tiny = `# A\n\ntiny intro\n\n## B\n\n${para("b")}\n`;
  const merged = splitSections(tiny);
  expect(merged.length).toBe(1);
  expect(merged[0].path).toBe("A › B");
  expect(body(tiny, merged[0])).toContain("tiny intro");
  expect(merged[0].start).toBe(0);

  const huge = `# Big\n\n${Array.from({ length: 40 }, (_, i) => para(`part${i}`, 8)).join("\n\n")}\n\n# Next\n\n${para("next")}\n`;
  expect(huge.length).toBeGreaterThan(12_000);
  const secs = splitSections(huge);
  expect(secs.length).toBeGreaterThan(2);
  expect(secs[secs.length - 1].path).toBe("Next");
  for (const s of secs.slice(0, -1)) {
    expect(s.path).toBe("Big");
    expect(s.chars).toBeLessThanOrEqual(12_000);
  }
  expect(secs.map((s) => s.n)).toEqual(secs.map((_, i) => i + 1));
});

// ------------------------------------------------------------------ ranking

const DRAWER_DOC = [
  page("# Components", "intro"),
  page("## Drawer", "drawer"),
  page("### Props", "props"),
  page("## Modal", "modal"),
  page("# Footer", "footer"),
].join("\n");
const DRAWER_CONCEPT = concept(["el:drawer", "drawer"], "element");

test("rankSections puts the Drawer section first for a drawer concept", () => {
  const secs = splitSections(DRAWER_DOC);
  const { hits, total } = rankSections(DRAWER_DOC, secs, [DRAWER_CONCEPT], {});
  expect(total).toBeGreaterThan(0);
  expect(secs[hits[0].n - 1].path).toBe("Components › Drawer");
  expect(hits.map((h) => secs[h.n - 1].path)).not.toContain("Footer");
  expect(hits[0].score).toBeGreaterThan(hits[hits.length - 1].score);
  expect(hits.every((h) => h.score > 0)).toBe(true);
});

test("an element tag finds a section through taxonomy aliases (dialog → Modal)", () => {
  const secs = splitSections(DRAWER_DOC);
  expect(expandTag("el:modal")).toContain("dialog");
  const { hits, total } = rankSections(DRAWER_DOC, secs, [concept(["el:modal", "dialog"], "element")], {});
  expect(total).toBe(1);
  expect(secs[hits[0].n - 1].path).toBe("Components › Modal");
  // va: and cat: tags expand through the variant / category, not just the id
  expect(expandTag("va:navbar/mega-menu")).toContain("mega");
  expect(expandTag("va:navbar/mega-menu")).toContain("menu");
  expect(expandTag("cat:icons").length).toBeGreaterThan(2);
});

test("sections that score 0 are never returned", () => {
  const secs = splitSections(DRAWER_DOC);
  expect(rankSections(DRAWER_DOC, secs, [concept(["zzzqxjv"])], {}).total).toBe(0);
  expect(rankSections(DRAWER_DOC, secs, [concept(["zzzqxjv"])], {}).hits).toEqual([]);
  expect(rankSections(DRAWER_DOC, secs, [], {}).hits).toEqual([]);
  const { hits, total } = rankSections(DRAWER_DOC, secs, [concept(["footer"])], {});
  expect(total).toBe(1);
  expect(hits.map((h) => secs[h.n - 1].path)).toEqual(["Footer"]);
});

test("limit and offset page through the ranked sections", () => {
  const secs = splitSections(DRAWER_DOC);
  const concepts = [concept(["line"])]; // every paragraph carries it: every section matches
  const all = rankSections(DRAWER_DOC, secs, concepts, { limit: 100 });
  expect(all.total).toBe(secs.length);
  const pages = [0, 2, 4].flatMap((offset) => rankSections(DRAWER_DOC, secs, concepts, { limit: 2, offset }).hits.map((h) => h.n));
  expect(pages).toEqual(all.hits.map((h) => h.n));
  expect(new Set(pages).size).toBe(secs.length);
  expect(rankSections(DRAWER_DOC, secs, concepts, { limit: 2, offset: 99 }).hits).toEqual([]);
});

test("cached stats give the same ranking as stats built on the spot", () => {
  const secs = splitSections(DRAWER_DOC);
  const concepts = [concept(["el:drawer", "drawer"], "element"), concept(["props"])];
  const fresh = rankSections(DRAWER_DOC, secs, concepts, {});
  const cached = rankSections(DRAWER_DOC, secs, concepts, { stats: sectionStats(DRAWER_DOC, secs) });
  expect(cached).toEqual(fresh);
  expect(fresh.total).toBeGreaterThan(1);
});

test("a concept matches only when every one of its words is in the section", () => {
  const secs = splitSections(DRAWER_DOC);
  const both = rankSections(DRAWER_DOC, secs, [concept(["props", "line"])], {});
  expect(both.hits.map((h) => secs[h.n - 1].path)).toEqual(["Components › Drawer › Props"]);
  expect(rankSections(DRAWER_DOC, secs, [concept(["props", "footer"])], {}).total).toBe(0);
});

test("bestWindow finds the stretch of a long section that holds the query", () => {
  const pad = para("filler", 30);
  const text = `# Big\n\n${pad}\n\nthe drawer closes on Escape\n\n${pad}\n`;
  const secs = splitSections(text);
  expect(secs.length).toBe(1);
  const w = bestWindow(text, secs[0], [DRAWER_CONCEPT], { size: 300 });
  expect(text.slice(w.from, w.to)).toContain("drawer closes on Escape");
  expect(w.to - w.from).toBeLessThanOrEqual(300);
  expect(w.from).toBeGreaterThanOrEqual(secs[0].start);
  expect(w.to).toBeLessThanOrEqual(secs[0].end);
  // no match anywhere: the window is the section's start
  const none = bestWindow(text, secs[0], [concept(["zzzqxjv"])], { size: 300 });
  expect(none.from).toBe(secs[0].start);
});

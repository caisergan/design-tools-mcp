#!/usr/bin/env bun
// loadIndex: the prebuilt index is used only when it was built from the same catalog entries; Phase 2B record fields.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, packIndex, loadIndex, catalogFingerprint, createSearch } from "./search.mjs";

const entries = [{ id: "a", name: "Navbar Gallery", url: "https://navbar.gallery", domain: "navbar.gallery", categories: ["section-gallery"], desc: "navbars" }];
const items = [{ id: "a/x", parent: "a", name: "Mega menu", url: "https://navbar.gallery/x", elements: ["navbar"], variants: {}, access: "page", granularity: "example", from: "sitemap" }];

function files(index) {
  const dir = mkdtempSync(join(tmpdir(), "search-index-test-"));
  const file = join(dir, "search-index.json");
  const catalogFile = join(dir, "catalog.json");
  writeFileSync(catalogFile, JSON.stringify({ items: entries }));
  writeFileSync(file, JSON.stringify(packIndex(index)));
  return { file, catalogFile };
}

test("an index built from the same entries loads even when catalog.json is newer on disk", () => {
  const { file, catalogFile } = files(buildIndex(entries, items));
  const later = new Date(Date.now() + 60_000);
  utimesSync(catalogFile, later, later); // a git checkout / clone touches catalog.json after the build
  const idx = loadIndex(entries, { file, catalogFile });
  expect(idx).not.toBeNull();
  expect(idx.catalog).toBe(catalogFingerprint(entries));
});

test("an index built from other entries is not used", () => {
  const { file, catalogFile } = files(buildIndex(entries, items));
  expect(loadIndex([{ ...entries[0], desc: "changed" }], { file, catalogFile })).toBeNull();
});

test("an index without a fingerprint falls back to the file times", () => {
  const { catalog, ...old } = buildIndex(entries, items);
  const { file, catalogFile } = files(old);
  const earlier = new Date(Date.now() - 60_000);
  utimesSync(catalogFile, earlier, earlier);
  expect(loadIndex(entries, { file, catalogFile })).not.toBeNull();
  const later = new Date(Date.now() + 60_000);
  utimesSync(catalogFile, later, later);
  expect(loadIndex(entries, { file, catalogFile })).toBeNull();
});

// ---------------------------------------------------------------- Phase 2B: record fields, hint elements

const site = (id, over = {}) => ({ id, name: id, url: `https://${id}.test`, domain: `${id}.test`, kind: "site", categories: ["components"], desc: "", ...over });
const rank = (entries, q, f = {}) => {
  const S = createSearch(entries, buildIndex(entries, []));
  return S.rank(q, f).ranked.map((r) => ({ id: S.entryOf(r.d).id, fields: r.matched.map(([, field]) => field) }));
};

test("a record's keywords are a field of their own; its X labels are no longer indexed", () => {
  const entries = [
    site("rec", { metadata: "ok", keywords: ["frosted glass navbar"], labels: ["zebra"], contains: ["ninety widgets"], type: "gallery" }),
    site("plain", { labels: ["zebra"], keywords: ["frosted"] }), // no record: keywords are not read, labels are
  ];
  expect(rank(entries, "frosted")).toEqual([{ id: "rec", fields: ["keywords"] }]);
  expect(rank(entries, "zebra").map((r) => r.id)).toEqual(["plain"]);
  expect(rank(entries, "ninety")).toEqual([{ id: "rec", fields: ["contains"] }]);
  expect(rank(entries, "gallery", {}).map((r) => r.id)).toEqual(["rec"]); // the record's type label
});

test("weak hint elements filter but do not rank; strong ones do both", () => {
  const entries = [site("strong", { elements: ["navbar"], elements_from: "hints" }), site("weak", { elements: ["navbar"], elements_weak: ["navbar"], elements_from: "hints" })];
  expect(rank(entries, "", { element: "navbar" }).map((r) => r.id).sort()).toEqual(["strong", "weak"]);
  expect(rank(entries, "navbar").map((r) => r.id)).toEqual(["strong"]);
});

test("an entry without a record indexes exactly its source fields", () => {
  const plain = site("plain", { desc: "Navbar kit", about: "Long about", labels: ["navs"], elements: ["navbar"] });
  const a = buildIndex([plain], []);
  const b = buildIndex([{ ...plain, metadata: "missing", keywords: ["x"], contains: ["y"], type: "gallery", variants: { navbar: ["dock"] } }], []);
  expect(b.postings).toEqual(a.postings);
});

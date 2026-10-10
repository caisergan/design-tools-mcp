#!/usr/bin/env bun
// loadIndex: the prebuilt index is used only when it was built from the same catalog entries.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, packIndex, loadIndex, catalogFingerprint } from "./search.mjs";

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

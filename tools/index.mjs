#!/usr/bin/env bun
// catalog.json + corpus → catalog/items/ + catalog/search-index.json (MCP-PLAN 3.5). tools/build.mjs runs it last.
// The MCP server loads the index at startup and builds one in memory when it is missing or was built from another
// catalog (search.mjs catalogFingerprint).
//   bun tools/index.mjs
import { writeFileSync, statSync } from "node:fs";
import { FILE, loadJSON } from "./lib.mjs";
import { buildItems, writeItems, ITEMS_DIR } from "./items.mjs";
import { buildIndex, packIndex, INDEX_FILE } from "./search.mjs";

export function writeIndex(entries = loadJSON(FILE.catalog)?.items) {
  if (!entries) throw new Error("catalog.json missing — run: bun tools/build.mjs");
  let t = performance.now();
  const byEntry = buildItems(entries);
  writeItems(byEntry);
  const items = [...byEntry.values()].flat();
  console.log(`items ${items.length} in ${byEntry.size} entries -> ${ITEMS_DIR} (${((performance.now() - t) / 1000).toFixed(1)}s)`);
  t = performance.now();
  const index = buildIndex(entries, items);
  writeFileSync(INDEX_FILE, JSON.stringify(packIndex(index)));
  const mb = (statSync(INDEX_FILE).size / 1e6).toFixed(1);
  console.log(`search-index.json ${mb} MB · ${index.docs} docs · ${Object.keys(index.postings).length} terms (${((performance.now() - t) / 1000).toFixed(1)}s)`);
}

if (import.meta.main) writeIndex();

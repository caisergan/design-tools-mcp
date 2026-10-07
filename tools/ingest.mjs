#!/usr/bin/env bun
// Source producer: an awesome-list style markdown (file or URL) -> catalog/sources/awesome-lists.json,
// which build.mjs merges into the main catalog. Each run replaces the file with that one list.
// Usage: bun tools/ingest.mjs <markdown-url-or-path> [--category="shadcn ecosystem"] [--section="Libs and Components"]
import { readFileSync, existsSync } from "node:fs";
import { writeSource } from "./lib.mjs";

const SRC = process.argv[2];
if (!SRC) {
  console.error('usage: bun tools/ingest.mjs <markdown-url-or-path> [--category="…"] [--section="…"]');
  process.exit(1);
}
const flagVal = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || "").split("=")[1];
const CATEGORY = flagVal("category") || "shadcn ecosystem";
const SECTION = flagVal("section");

const markdown = /^https?:/.test(SRC)
  ? await (await fetch(SRC, { headers: { "user-agent": "Mozilla/5.0 (compatible; design-tools/1.0)" } })).text()
  : readFileSync(SRC.replace(/^~/, process.env.HOME), "utf8");

const items = [];
let section = CATEGORY;
for (const line of markdown.split("\n")) {
  const h2 = /^##\s+(.+?)\s*$/.exec(line);
  if (h2) {
    section = h2[1].replace(/[^\p{L}\p{N} &/-]+/gu, "").trim() || section;
    continue;
  }
  if (SECTION && section !== SECTION) continue;
  if (!line.startsWith("|")) continue;
  const cells = line.split("|").slice(1, -1).map((c) => c.trim());
  if (cells.length < 3) continue;
  const name = cells[0].replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*/g, "").trim();
  const url = (/\((https?:\/\/[^)\s]+)\)/.exec(cells.slice(1).join(" ")) || [])[1];
  if (!url || !name || /^-+$/.test(name)) continue;
  const desc = (cells[1] || "").replace(/\s+/g, " ").slice(0, 300);
  items.push({ url: url.replace(/\/$/, ""), name, desc, categories: [`${CATEGORY} · ${section}`] });
}

writeSource(
  "awesome-lists",
  { title: "Awesome lists", description: "Community awesome lists (awesome-shadcn-ui).", generator: "tools/ingest.mjs", origin_file: SRC, section: SECTION || "*" },
  items,
);
console.log(`${items.length} kayıt -> catalog/sources/awesome-lists.json`);
const hosts = new Set(items.map((i) => new URL(i.url).hostname));
console.log(`${hosts.size} benzersiz host · örnek: ${[...hosts].slice(0, 5).join(", ")}`);
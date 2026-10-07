#!/usr/bin/env bun
// Source producer: ui-design-kaynak-linkleri.md (the hand-curated list) -> catalog/sources/curated.json
import { readFileSync } from "node:fs";
import { SRC, writeSource } from "./lib.mjs";

const STOP = "# 📮"; // raw post dumps start here; everything above is structured

const stripLead = (s) => s.replace(/^[^\p{L}\p{N}]+/u, "").trim();

/** Markdown tables under `## <category> · <n>` headings -> one item per url (categories merged). */
export function parse(md) {
  const byUrl = new Map();
  let category = "uncategorized";
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith(STOP)) break;
    if (line.startsWith("## ")) {
      const title = line.slice(3).trim();
      const m = /^(.*?)\s+·\s+(\d+)\s*$/.exec(title);
      category = stripLead(m ? m[1] : title);
      continue;
    }
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    const nm = /\*{0,2}\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\*{0,2}/.exec(cells[0]);
    if (!nm) continue; // header / separator rows have no link
    const url = nm[2].replace(/\/$/, "");
    const descRaw = cells.length > 3 ? cells.slice(1, -1).join(" | ") : cells[1];
    const desc = /^—$/.test(descRaw) ? "" : descRaw;
    const last = cells[cells.length - 1];
    // the last column links the X posts that shared it: only their count is kept (no post data in the catalog)
    const posts = [...last.matchAll(/\]\((https:\/\/x\.com\/[^)]+)\)/g)].map((m) => m[1]);
    const count = /^\d+$/.test(last) ? Number(last) : 0;

    const prev = byUrl.get(url);
    if (prev) {
      if (!prev.categories.includes(category)) prev.categories.push(category);
      for (const p of posts) prev.posts.add(p);
      prev.mentions = Math.max(prev.mentions, count, prev.posts.size);
      if (!prev.desc && desc) prev.desc = desc;
      if (!prev.name || prev.name.length < nm[1].length) prev.name = nm[1];
      continue;
    }
    byUrl.set(url, { url, name: nm[1], desc, categories: [category], mentions: Math.max(count, new Set(posts).size), posts: new Set(posts) });
  }
  return [...byUrl.values()].map(({ posts, ...item }) => item);
}

if (import.meta.main) {
  const items = parse(readFileSync(SRC, "utf8"));
  writeSource(
    "curated",
    {
      title: "Curated list",
      description: "Hand-picked UI/design resources (ui-design-kaynak-linkleri.md).",
      generator: "tools/source-curated.mjs",
      origin_file: "ui-design-kaynak-linkleri.md",
    },
    items,
  );
  console.log(`${items.length} items -> catalog/sources/curated.json`);
}

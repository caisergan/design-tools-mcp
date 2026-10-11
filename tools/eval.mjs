#!/usr/bin/env bun
// Phase 0 eval: recall@5 and MRR of search_resources over tools/eval/queries.json.
// A query counts as a hit when one of the top 5 results maps back (by url) to an `expect_any` id.
// MRR is averaged over all queries — a miss scores 0. Always exits 0.
// Queries flagged `"descriptive": true` (Phase 2B: a site described by what it is, never by its name) are scored as a
// separate block; the headline metrics stay on the other queries, so the 2B run has a before/after of its own.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FILE, ROOT, loadJSON } from "./lib.mjs";

const TOP = 5;
const QUERIES = JSON.parse(readFileSync(join(ROOT, "tools", "eval", "queries.json"), "utf8"));
const ITEMS = loadJSON(FILE.catalog).items;

const normUrl = (u) => String(u).toLowerCase().replace(/\/+$/, "");
const idByUrl = new Map(ITEMS.map((it) => [normUrl(it.url), it.id]));
// A page is a sub-entry of its site: count either its own id or the parent's as a hit.
const siteByDomain = new Map();
for (const it of ITEMS) if (it.kind === "site" && it.domain && !siteByDomain.has(it.domain)) siteByDomain.set(it.domain, it.id);
const parentOf = new Map(ITEMS.map((it) => [it.id, it.kind === "page" ? siteByDomain.get(it.domain) || it.id : it.id]));

function startServer() {
  const proc = spawn(process.execPath, [join(ROOT, "tools", "mcp.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = createInterface({ input: proc.stdout });
  const pending = new Map();
  let id = 0;
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60_000);
      pending.set(n, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  return { proc, rpc };
}

// Result lines look like: `- <name> — <desc> · <url> · id:<id> \`flags\``; a component id is `<entry id>/<slug>`.
function hitsOf(text) {
  const hits = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const name = line.slice(2).split(" — ")[0];
    const id = /· id:(\S+)/.exec(line)?.[1];
    const url = (line.match(/https?:\/\/[^\s`]+/g) || []).map(normUrl).find((u) => idByUrl.has(u));
    hits.push({ name, id: id || (url ? idByUrl.get(url) : null) });
    if (hits.length >= TOP) break;
  }
  return hits;
}

// A hit counts when its id, its entry (for a component id) or that entry's root site is expected.
const accepts = (expect, id) => {
  const entry = id.includes("/") ? id.split("/")[0] : id;
  return expect.includes(id) || expect.includes(entry) || expect.includes(parentOf.get(entry));
};

async function main() {
  const { proc, rpc } = startServer();
  const headline = QUERIES.filter((x) => !x.descriptive);
  const sites = QUERIES.filter((x) => x.descriptive);
  const score = async (queries) => {
    const out = { found: 0, reciprocal: 0, failures: [], subset: { named: [0, 0], descriptive: [0, 0] } }; // [found, total] — the plan's targets are per subset
    for (const { q, expect_any, note = "" } of queries) {
      const sub = out.subset[note.startsWith("descriptive") ? "descriptive" : "named"];
      sub[1]++;
      const { result } = await rpc("tools/call", { name: "search_resources", arguments: { query: q, limit: TOP } });
      const hits = hitsOf((result?.content || []).map((c) => c.text || "").join("\n"));
      const rank = hits.findIndex((h) => h.id && accepts(expect_any, h.id));
      if (rank < 0) out.failures.push({ q, hits });
      else {
        out.found++;
        sub[0]++;
        out.reciprocal += 1 / (rank + 1);
      }
    }
    return out;
  };
  let main;
  let desc;
  try {
    main = await score(headline);
    desc = await score(sites);
  } finally {
    proc.kill();
  }
  const failed = (failures) => {
    for (const { q, hits } of failures) {
      const top3 = hits.slice(0, 3).map((h) => h.name || "?").join(" | ") || "(no results)";
      console.log(`- "${q}"\n    ${top3}`);
    }
  };

  console.log(`search_resources eval — ${headline.length} queries, top ${TOP}, ${ITEMS.length} catalog entries\n`);
  console.log(`recall@${TOP}: ${(main.found / headline.length).toFixed(3)} (${main.found}/${headline.length})`);
  console.log(`MRR: ${(main.reciprocal / headline.length).toFixed(3)}`);
  for (const [k, [f, n]] of Object.entries(main.subset)) console.log(`  ${k}: ${(f / n).toFixed(3)} (${f}/${n})`);
  if (main.failures.length) {
    console.log(`\nfailures (${main.failures.length}):`);
    failed(main.failures);
  }
  if (sites.length) {
    console.log(`\nsite descriptions (Phase 2B, "descriptive": true) — ${sites.length} queries, not in the headline`);
    console.log(`recall@${TOP}: ${(desc.found / sites.length).toFixed(3)} (${desc.found}/${sites.length}) · MRR: ${(desc.reciprocal / sites.length).toFixed(3)}`);
    if (desc.failures.length) failed(desc.failures);
  }
}

try {
  await main();
} catch (e) {
  console.error(`eval failed: ${e.message}`);
}
process.exit(0);

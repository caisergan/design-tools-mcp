#!/usr/bin/env bun
// Phase 2B run kit: one Markdown file per extractor session (MCP-PLAN 2B pipeline step 3; the run itself is the owner's).
//
//   bun tools/metadata-batch.mjs --from-queue [--size 20] [--limit n]   every queued entry that has a digest, in queue order
//   bun tools/metadata-batch.mjs --ids a,b,c [--size 20]                 these entries
//   bun tools/metadata-batch.mjs --prompt                                print the assembled prompt (prompt + taxonomy view)
//   bun tools/metadata-batch.mjs --stats                                 print its size
//
// → catalog/metadata/_batches/<n>.md + <n>.ids (gitignored), n = 1, 2, … — the old batch files are replaced, so regenerate only
// while no session is running. Each file holds the full prompt (tools/prompts/metadata-v1.md with the live
// `bun tools/taxonomy-prompt.mjs` view in place of {{TAXONOMY}}), the batch's ids and the exact steps; it ends with a
// marker line for the watcher. One file = one omp session: paste it, or point omp at it.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadJSON, saveText } from "./lib.mjs";
import { promptView } from "./taxonomy-prompt.mjs";
import { METADATA_DIR, PROMPT_ID, digestFile } from "./metadata.mjs";
import { estimateTokens } from "./crawl.mjs";

export const PROMPT_FILE = join(ROOT, "tools", "prompts", `${PROMPT_ID}.md`);
export const BATCH_DIR = join(METADATA_DIR, "_batches");
export const QUEUE_FILE = join(METADATA_DIR, "_queue.json");
export const marker = (n) => `METADATA-BATCH-${n}-DONE`;

/** The prompt the extractor sees: the prompt file with the taxonomy view in place of {{TAXONOMY}} (never a stale copy). */
export function assemblePrompt({ prompt = readFileSync(PROMPT_FILE, "utf8"), view = promptView() } = {}) {
  if (!prompt.includes("{{TAXONOMY}}")) throw new Error(`${PROMPT_FILE}: no {{TAXONOMY}} placeholder`);
  return prompt.replace("{{TAXONOMY}}", view.trim());
}

/** One session's instructions. `ids` in order; `n` the batch number (its marker). */
export function batchText(n, ids, { prompt = assemblePrompt(), total = null } = {}) {
  const list = ids.map((id, i) => `${i + 1}. \`${id}\``).join("\n");
  return `# Metadata batch ${n}${total ? ` of ${total}` : ""} — ${ids.length} entries (prompt ${PROMPT_ID})

You are the extraction agent of the design-tools catalog. Work in the repository root (the folder that holds
\`tools/\` and \`catalog/\`). Read this whole file first: the prompt below says how to write one record; the steps at
the end say what to do in this session.

---

${prompt}

---

## Your batch: ${ids.length} entries

${list}

## Steps, for each id above, in order

1. Read \`catalog/crawl/<id>.json\` (the digest). Read nothing else about the entry: no other file, no web page.
2. Write \`catalog/metadata/<id>.json\` by the prompt above: one JSON object, nothing else in the file.
3. Run \`bun tools/metadata-check.mjs --id <id>\`. It prints \`ok <id>\` or the errors; fix the record and run it
   again until it prints \`ok\`. (It also normalizes the keywords in place — that is expected.)

When every id is done, run \`bun tools/metadata-check.mjs --id ${ids.join(",")}\` once more. Then end your reply with
this line, alone:

${marker(n)}

Rules: do not edit any other file, do not run any other command, do not fetch anything from the network, and do not
commit. If a digest is missing, skip that id and say so before the marker line.
`;
}

/** Split `ids` into batches of `size`. */
export const chunk = (ids, size) => Array.from({ length: Math.ceil(ids.length / size) }, (_, i) => ids.slice(i * size, (i + 1) * size));

function main(argv) {
  const arg = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes("--prompt")) return console.log(assemblePrompt());
  if (argv.includes("--stats")) {
    const p = assemblePrompt();
    const view = promptView();
    console.log(`prompt + taxonomy view: ${p.length} chars ≈ ${estimateTokens(p)} tokens (taxonomy view ${view.length} chars ≈ ${estimateTokens(view)} tokens)`);
    return;
  }
  const size = Number(arg("--size") || 20);
  if (!Number.isInteger(size) || size < 1) throw new Error("--size must be a positive integer");
  let ids;
  if (arg("--ids")) ids = arg("--ids").split(",").map((s) => s.trim()).filter(Boolean);
  else if (argv.includes("--from-queue")) {
    const q = loadJSON(QUEUE_FILE);
    if (!q) throw new Error("catalog/metadata/_queue.json missing — run: bun tools/metadata-queue.mjs");
    ids = q.items.map((i) => i.id);
  } else {
    console.error("usage: bun tools/metadata-batch.mjs --from-queue | --ids a,b,c   [--size 20] [--limit n]  ·  --prompt  ·  --stats");
    process.exit(2);
  }
  const noDigest = ids.filter((id) => !existsSync(digestFile(id)));
  ids = ids.filter((id) => existsSync(digestFile(id)));
  if (arg("--limit")) ids = ids.slice(0, Number(arg("--limit")));
  if (existsSync(BATCH_DIR)) for (const f of readdirSync(BATCH_DIR)) if (/^\d+\.(md|ids)$/.test(f)) rmSync(join(BATCH_DIR, f));
  const prompt = assemblePrompt();
  const batches = chunk(ids, size);
  batches.forEach((b, i) => {
    saveText(join(BATCH_DIR, `${i + 1}.md`), batchText(i + 1, b, { prompt, total: batches.length }));
    saveText(join(BATCH_DIR, `${i + 1}.ids`), b.join(",") + "\n"); // for a watcher: bun tools/metadata-check.mjs --id "$(cat <n>.ids)"
  });
  const tokens = ids.reduce((n, id) => n + (loadJSON(digestFile(id))?.tokens || 0), 0);
  console.log(`${batches.length} batch files (${size} entries each, ${ids.length} entries) -> ${BATCH_DIR.replace(ROOT + "/", "")}/1..${batches.length}.md`);
  console.log(`  digests ≈ ${tokens} tokens · prompt ≈ ${estimateTokens(prompt)} tokens per session`);
  if (noDigest.length) console.log(`  ${noDigest.length} queued entries have no digest yet (crawl them first: bun tools/crawl.mjs --queue): ${noDigest.slice(0, 10).join(", ")}${noDigest.length > 10 ? " …" : ""}`);
}

if (import.meta.main) main(process.argv.slice(2));

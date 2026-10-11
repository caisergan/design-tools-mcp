#!/usr/bin/env bun
// Phase 2B record check (MCP-PLAN 2B pipeline step 4), no LLM.
//
//   bun tools/metadata-check.mjs                  every record in catalog/metadata/, then writes catalog/metadata/_review.md
//   bun tools/metadata-check.mjs --id a[,b,…]     these records only (what an extractor session runs; no _review.md, so
//                                                 parallel sessions never write the same file)
//
// Validates each record against catalog/metadata/schema.json (tools/json-schema.mjs) and catalog/taxonomy.json —
// an unknown category / type / element / variant id is an error — and against its catalog entry (id, kind, url,
// related.parent). Normalizes keywords (lowercase, singular, deduped, spelling variants mapped through the taxonomy;
// keywords_manual untouched), stack and elements, and writes them back. Review (not errors): confidence < 0.6, or a
// primary category that disagrees with every source hint. Exit code 1 on any error.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadJSON, saveText } from "./lib.mjs";
import { METADATA_DIR, digestFile, normalizeRecord, recordFile, recordIds, recordProblems, reviewReasons } from "./metadata.mjs";

export const REVIEW_FILE = join(METADATA_DIR, "_review.md");

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Check one parsed record. → { record (normalized), changed, errors, review }. Pure: `entry` is the catalog entry with
 * its source values (loadItems metadata: false), `ids` the catalog ids. The digest's hints_hash fills a missing one.
 */
export function checkRecord(raw, { fileId, entry = null, ids = null, digest = null } = {}) {
  let record = normalizeRecord(raw);
  if (!record.hints_hash && digest?.hints_hash) record = { ...record, hints_hash: digest.hints_hash };
  const errors = recordProblems(record, { fileId, entry, ids });
  return { record, changed: !same(raw, record), errors, review: errors.length ? [] : reviewReasons(record, entry) };
}

/** The _review.md text: one block per record a person should look at. */
export function reviewText(rows) {
  const lines = ["# Metadata records to review", "", "Written by `bun tools/metadata-check.mjs`: records with confidence < 0.6 or a primary category no source hint supports. Fix the record (or add a hand fix to `catalog/overrides.json`) and run the check again.", ""];
  if (!rows.length) lines.push("No records need review.");
  for (const { id, record, reasons } of rows) {
    lines.push(`## ${id}`, "");
    lines.push(`- ${reasons.join(" · ")}`);
    lines.push(`- ${record.name || id} — ${record.summary || "(no summary)"} · type ${record.type || "?"} · categories ${(record.categories || []).join(", ") || "?"} · confidence ${record.confidence}`);
    lines.push(`- ${record.url}`, "");
  }
  return lines.join("\n") + "\n";
}

async function main(argv) {
  const at = argv.indexOf("--id");
  const only = at >= 0 ? (argv[at + 1] || "").split(",").map((s) => s.trim()).filter(Boolean) : null;
  const { loadItems } = await import("./build.mjs");
  const entries = loadItems({ metadata: false });
  const byId = new Map(entries.map((e) => [e.id, e]));
  const ids = new Set(byId.keys());
  const targets = only || recordIds();
  let failed = 0;
  const review = [];
  for (const id of targets) {
    const f = recordFile(id);
    if (!existsSync(f)) {
      console.log(`✗ ${id}: catalog/metadata/${id}.json does not exist`);
      failed++;
      continue;
    }
    let raw;
    try {
      raw = loadJSON(f);
    } catch (e) {
      console.log(`✗ ${id}: not valid JSON (${e.message})`);
      failed++;
      continue;
    }
    const digest = existsSync(digestFile(id)) ? loadJSON(digestFile(id)) : null;
    const { record, changed, errors, review: why } = checkRecord(raw, { fileId: id, entry: byId.get(id), ids, digest });
    if (changed) saveText(f, JSON.stringify(record, null, 2) + "\n");
    if (errors.length) {
      failed++;
      console.log(`✗ ${id}\n${errors.map((e) => `    ${e}`).join("\n")}`);
      continue;
    }
    console.log(`ok ${id}${changed ? " (normalized)" : ""}${why.length ? ` — review: ${why.join(" · ")}` : ""}`);
    if (why.length) review.push({ id, record, reasons: why });
  }
  if (!only) {
    saveText(REVIEW_FILE, reviewText(review));
    console.log(`${targets.length} records · ${failed} with errors · ${review.length} to review -> catalog/metadata/_review.md`);
  } else if (targets.length > 1) console.log(`${targets.length} records · ${failed} with errors · ${review.length} to review`);
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.main) await main(process.argv.slice(2));

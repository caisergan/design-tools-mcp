#!/usr/bin/env bun
// The compact view of catalog/taxonomy.json that the Phase 2B extraction prompt embeds: ids and
// definitions only. Aliases, excludes and matching rules are for the deterministic tagger (tools/tag.mjs),
// not for the agent, so the full file stays the one hand-edited source.
//
//   bun tools/taxonomy-prompt.mjs            print the view
//   bun tools/taxonomy-prompt.mjs --stats    print its size
import { FILE, loadJSON } from "./lib.mjs";

export function promptView(t = loadJSON(FILE.taxonomy)) {
  const list = (xs) => xs.map((e) => `- ${e.id}: ${e.definition}`).join("\n");
  const groups = {};
  for (const e of t.elements) (groups[e.group] ||= []).push(e);
  const elements = Object.entries(groups)
    .map(([g, xs]) => `### ${g}\n` + xs.map((e) => `- ${e.id}: ${e.definition}` + (e.variants ? ` Kinds: ${e.variants.map((v) => v.id).join(", ")}.` : "")).join("\n"))
    .join("\n");
  return [
    "## categories (pick 1–2)", list(t.categories),
    "## types (pick 1)", list(t.types),
    "## elements (every UI element the resource shows or contains; kinds only when the site names them)", elements,
  ].join("\n\n");
}

if (import.meta.main) {
  const v = promptView();
  if (process.argv.includes("--stats")) console.log(`${v.length} chars ≈ ${Math.round(v.length / 4)} tokens`);
  else console.log(v);
}

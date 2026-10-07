// Catalog entry → 1–2 category ids from catalog/taxonomy.json (MCP-PLAN 2.3). Pure; the rules are the
// taxonomy's `categorize` block and each category's `from_labels`.
import { TAXONOMY, tok, findSpans } from "./tag.mjs";

export const CATEGORY_IDS = TAXONOMY.categories.map((c) => c.id);
export const MAX_CATEGORIES = 2;

const has = (toks, phrases) => phrases.some((p) => findSpans(toks, p).length);

/**
 * entry = { name, desc, about, title, labels, categories: [source labels] }
 * → { categories: [ids], via: "labels" | "text" | "default", unknown: [labels no category claims] }
 */
export function categorize(entry, t = TAXONOMY) {
  const rules = t.categorize;
  const byLabel = new Map(t.categories.flatMap((c) => (c.from_labels || []).map((l) => [l, c.id])));
  const ids = [];
  const unknown = [];
  for (const label of entry.categories || []) {
    const id = byLabel.get(label);
    if (id) { if (!ids.includes(id)) ids.push(id); }
    else if (label !== rules.repo_label && !rules.drop_labels.includes(label)) unknown.push(label);
  }
  if (ids.length) return { categories: ids.slice(0, MAX_CATEGORIES), via: "labels", unknown };

  const toks = tok([entry.name, entry.title, entry.desc, entry.about, ...(entry.labels || [])].filter(Boolean).join(" | "));
  const found = [];
  if (has(toks, rules.design_rules_words) && has(toks, rules.design_words)) found.push("design-rules");
  // design-rules only through the design-word pair above: "agent skill" alone is any skill
  const ignore = new Set(rules.text_ignore_aliases);
  for (const c of t.categories)
    if (found.length < MAX_CATEGORIES && !found.includes(c.id) && c.id !== rules.default && c.id !== "design-rules" && has(toks, c.aliases.filter((a) => !ignore.has(a))))
      found.push(c.id);
  if (found.length) return { categories: found, via: "text", unknown };
  return { categories: [rules.default], via: "default", unknown };
}

#!/usr/bin/env bun
// Element and variant tagging of registry items (MCP-PLAN 3.4, no LLM). Implements the `matching`
// block of catalog/taxonomy.json; pure functions plus a read-only dry run over catalog/corpus/sites.
//
//   bun tools/tag.mjs [summary|samples|variants|accept|untagged|assets]
//   bun tools/tag.mjs grep:<element>:<regex>    items of an element whose name matches
//   bun tools/tag.mjs var:<element>:<variant>   items carrying one variant
//   bun tools/tag.mjs alias:<element>           hits per variant alias (for pruning loose aliases)
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FILE, loadJSON } from "./lib.mjs";

export const TAXONOMY = loadJSON(FILE.taxonomy);

export const tok = (s) =>
  (s || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

export const stem = (w) => {
  if (w.length < 4 || /(ss|us|is)$/.test(w)) return w;
  if (/(ches|shes|xes|zes|sses|oes)$/.test(w)) return w.slice(0, -2);
  if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + "y";
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
};

export const SKIP_TYPE = /^registry:(hook|lib|style|theme|font|file)$/;
const ASSET_TYPES = new Set(["icon-set", "asset-library"]);

// An alias token matches a text token or its singular; the alias itself is not stemmed, so plural aliases match only plurals.
const eqTok = (a, raw) => a === raw || a === stem(raw);
export function findSpans(toks, phrase) {
  const p = tok(phrase);
  const out = [];
  for (let i = 0; i + p.length <= toks.length; i++) {
    let ok = true;
    for (let j = 0; j < p.length && ok; j++) ok = eqTok(p[j], toks[i + j]);
    if (ok) out.push([i, i + p.length]);
  }
  return out;
}
const inside = (a, b) => a[0] >= b[0] && a[1] <= b[1];
const strictlyInside = (a, b) => inside(a, b) && a[1] - a[0] < b[1] - b[0];

/** Element hits in one text field: [{ el, span, alias, viaVariant, weak }]. */
export function elementsIn(text, { field = "name", vetoText = "", taxonomy = TAXONOMY } = {}) {
  const toks = tok(text);
  if (!toks.length) return [];
  const vtoks = tok(vetoText);
  const withIdx = toks.indexOf("with");
  const cand = [];
  for (const e of taxonomy.elements) {
    const ex = (e.exclude || []).flatMap((p) => findSpans(toks, p));
    const weak = new Set(e.weak_aliases || []);
    const vetoed = (a) =>
      (e.exclude || []).some((p) => tok(p).includes(tok(a)[0]) && (findSpans(toks, p).length || findSpans(vtoks, p).length));
    const add = (alias, viaVariant) => {
      const w = weak.has(alias);
      if (w && (field !== "name" || vetoed(alias))) return;
      for (const s of findSpans(toks, alias)) if (!ex.some((x) => inside(s, x))) cand.push({ el: e.id, span: s, alias, viaVariant, weak: w });
    };
    for (const a of e.aliases) add(a, null);
    for (const v of e.variants || []) for (const a of v.standalone ? v.aliases : v.standalone_aliases || []) add(a, v.id);
  }
  let kept = cand.filter((c) => !cand.some((o) => o.el !== c.el && strictlyInside(c.span, o.span)));
  kept = kept.filter((c) => !c.weak || !kept.some((o) => !o.weak && o.el !== c.el));
  return kept.filter((c) => withIdx < 0 || c.span[0] < withIdx);
}

/** Variant ids of one element found in `text`; tokens that name the element itself don't count. */
export function variantsIn(text, elId, taxonomy = TAXONOMY) {
  const e = taxonomy.elements.find((x) => x.id === elId);
  if (!e?.variants) return [];
  const toks = tok(text);
  const elSpans = e.aliases.flatMap((a) => findSpans(toks, a));
  const out = new Set();
  for (const v of e.variants)
    for (const a of v.aliases) if (findSpans(toks, a).some((s) => !elSpans.some((x) => inside(s, x)))) out.add(v.id);
  return [...out];
}

/**
 * Hand fixes from catalog/overrides.json:
 *   items.<entry id>.type = "icon-set" | "asset-library"  → the entry's registry gets no elements (until Phase 2B records exist)
 *   components["<domain>/<item name>"] = { elements, variants }  → replaces the computed tags of that item
 */
export function loadTagOverrides() {
  const o = loadJSON(FILE.overrides, {});
  const assetIds = new Set(Object.entries(o.items || {}).filter(([, p]) => ASSET_TYPES.has(p.type)).map(([id]) => id));
  const assetDomains = new Set();
  if (assetIds.size) for (const e of loadJSON(FILE.catalog, { items: [] }).items) if (assetIds.has(e.id)) assetDomains.add(e.domain);
  return { assetDomains, components: o.components || {} };
}

const NO_TAGS = { elements: [], variants: {}, hits: [] };
export const isAssetItem = (it, ov) => ov.assetDomains.has(it.reg) || /^icons?[-_/]/i.test(it.name) || /^components-animate-icons/i.test(it.name);

/** it = { reg, name, title, description, type } → { elements, variants: { el: [ids] }, hits } */
export function tagItem(it, { useDesc = false, assetGate = true, overrides = { assetDomains: new Set(), components: {} }, taxonomy = TAXONOMY } = {}) {
  const fix = overrides.components[`${it.reg}/${it.name}`];
  if (fix) return { elements: fix.elements || [], variants: fix.variants || {}, hits: [], override: true };
  if (SKIP_TYPE.test(it.type) || (assetGate && isAssetItem(it, overrides))) return NO_TAGS;
  const vetoText = [it.name, it.title].join(" | ");
  const fields = [["name", it.name], ["title", it.title]];
  if (useDesc) fields.push(["description", it.description]);
  const hits = fields.flatMap(([field, txt]) => elementsIn(txt, { field, vetoText, taxonomy }));
  const elements = [...new Set(hits.map((h) => h.el))];
  const vtext = [it.name, it.title, useDesc ? it.description : ""].join(" | ");
  const variants = {};
  for (const el of elements) {
    const vs = new Set(variantsIn(vtext, el, taxonomy));
    for (const h of hits) if (h.el === el && h.viaVariant) vs.add(h.viaVariant);
    if (vs.size) variants[el] = [...vs];
  }
  return { elements, variants, hits };
}

/** Every saved registry item, flattened: { reg (= corpus domain), name, title, description, type }. */
export function loadRegistryItems() {
  const root = join(FILE.corpus, "sites");
  const out = [];
  for (const d of readdirSync(root)) {
    const f = join(root, d, "registry.json");
    if (!existsSync(f)) continue;
    let j;
    try { j = loadJSON(f); } catch { continue; }
    for (const it of Array.isArray(j) ? j : j.items || [])
      out.push({ reg: d, name: it.name || "", title: it.title || "", description: it.description || "", type: it.type || "" });
  }
  return out;
}

// ---------------------------------------------------------------- dry run

const mergeKey = (i) => i.reg + "/" + i.name.replace(/[-_](ts|js)[-_](tw|css)$/i, "").toLowerCase();
const isDemo = (i) => i.type === "registry:example" || /(^|[-_])demos?([-_]|$)/i.test(i.name);
const short = (d) => d.replace(/\.(com|dev|io|app|site|design|vercel\.app|tools|fun)$/, "");

function dryRun(mode) {
  const ov = loadTagOverrides();
  const all = loadRegistryItems();
  const gated = all.filter((i) => SKIP_TYPE.test(i.type)).length;
  const A = all.map((i) => ({ i, t: tagItem(i, { overrides: ov }) }));
  const tagged = A.filter((x) => x.t.elements.length).length;
  console.log(`items ${all.length} · registries ${new Set(all.map((i) => i.reg)).size} · type-gated ${gated}`);
  console.log(`tagged with ≥1 element (name+title): ${tagged} (${((100 * tagged) / (all.length - gated)).toFixed(1)}% of eligible)`);
  const rows = TAXONOMY.elements.map((e) => {
    const m = A.filter((x) => x.t.elements.includes(e.id));
    const items = m.filter((x) => !isDemo(x.i));
    return { e, m, items, merged: new Set(items.map((x) => mergeKey(x.i))), regs: new Set(m.map((x) => x.i.reg)) };
  });
  const [cmd, a1, a2] = mode.split(":");
  if (cmd === "summary") {
    const D = all.map((i) => tagItem(i, { overrides: ov, useDesc: true }));
    console.log("\nelement | raw | demos/examples | items after stack merge | registries | raw with description");
    for (const r of rows) console.log(`${r.e.id} | ${r.m.length} | ${r.m.length - r.items.length} | ${r.merged.size} | ${r.regs.size} | ${D.filter((t) => t.elements.includes(r.e.id)).length}`);
  }
  if (cmd === "samples")
    for (const r of rows) {
      const byReg = {}, seen = new Set();
      for (const x of r.items) { const k = mergeKey(x.i); if (seen.has(k)) continue; seen.add(k); (byReg[x.i.reg] ||= []).push(x.i.name); }
      const regs = Object.keys(byReg).sort((a, b) => byReg[b].length - byReg[a].length), out = [];
      for (let k = 0; out.length < 10 && k < 20; k++) for (const g of regs) if (out.length < 10 && byReg[g][k]) out.push(`${short(g)}:${byReg[g][k]}`);
      console.log(`\n## ${r.e.id} (${r.merged.size})  ${out.join("  ")}`);
    }
  if (cmd === "variants")
    for (const r of rows.filter((r) => r.e.variants)) {
      const cnt = {};
      for (const x of r.items) for (const v of x.t.variants[r.e.id] || []) cnt[v] = (cnt[v] || 0) + 1;
      const none = r.items.filter((x) => !(x.t.variants[r.e.id] || []).length).length;
      console.log(`\n## ${r.e.id}: ${r.items.length} items, ${none} without a variant`);
      console.log(r.e.variants.map((v) => `${v.id} ${cnt[v.id] || 0}`).join(" · "));
    }
  if (cmd === "grep" || cmd === "var") {
    const r = rows.find((r) => r.e.id === a1), R = new RegExp(a2 || ".", "i");
    const pick = cmd === "grep" ? (x) => R.test(x.i.name) : (x) => (x.t.variants[a1] || []).includes(a2);
    const names = [...new Set(r.items.filter(pick).map((x) => x.i.name.replace(/\d+/g, "#")))];
    console.log(`${a1} ${a2} ${names.length}\n${names.slice(0, 80).join("  ")}`);
  }
  if (cmd === "alias") {
    const r = rows.find((r) => r.e.id === a1);
    for (const v of r.e.variants || [])
      for (const a of v.aliases) {
        const hit = r.items.filter((x) => (x.t.variants[a1] || []).includes(v.id) && findSpans(tok(`${x.i.name} | ${x.i.title}`), a).length);
        const names = [...new Set(hit.map((x) => x.i.name.replace(/\d+/g, "#")))];
        console.log(`${v.id} ← "${a}" ${hit.length}: ${names.slice(0, 8).join("  ")}`);
      }
  }
  if (cmd === "accept") {
    const elig = all.filter((i) => !SKIP_TYPE.test(i.type));
    const ref = /(navbar|header|navigation-menu|menubar|mega-menu|dock|sidebar-nav)/i;
    const refRegs = [...new Set(elig.filter((i) => ref.test(i.name)).map((i) => i.reg))];
    const nav = A.filter((x) => x.t.elements.includes("navbar"));
    const navRegs = new Set(nav.map((x) => x.i.reg));
    console.log(`navbar: ${nav.length} items in ${navRegs.size} registries; covers ${refRegs.filter((r) => navRegs.has(r)).length}/${refRegs.length} registries of the 3.0 word list`);
    for (const r of refRegs.filter((r) => !navRegs.has(r))) console.log(`  not navbar: ${r}`);
    console.log(`  outside the word list: ${[...navRegs].filter((r) => !refRegs.includes(r)).join(" ")}`);
  }
  if (cmd === "untagged") {
    const stop = new Set("pro marketing application ecommerce portfolio sections section with and the demo ts js tw css modern saas blueprint open store components community base radix animate ui".split(" "));
    const un = A.filter((x) => !x.t.elements.length && !SKIP_TYPE.test(x.i.type) && !isAssetItem(x.i, ov));
    const c = {};
    for (const x of un) for (const t of new Set(tok(x.i.name))) if (!stop.has(t) && !/^\d+$/.test(t) && t.length > 2) c[t] = (c[t] || 0) + 1;
    console.log(`untagged ${un.length}\n` + Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 70).map(([k, v]) => `${k}:${v}`).join(" "));
  }
  if (cmd === "assets") {
    const a = all.filter((i) => !SKIP_TYPE.test(i.type) && isAssetItem(i, ov));
    console.log(`asset-gated items: ${a.length} (registries: ${[...ov.assetDomains].join(", ") || "none in overrides.json"})`);
  }
}

if (import.meta.main) dryRun(process.argv[2] || "summary");

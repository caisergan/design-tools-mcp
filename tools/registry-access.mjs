#!/usr/bin/env bun
// Registries the probe saw gated (its first item answered 401/403) are often mixed: free items next to pro ones
// (2026-10-10 samples of 20: reui.io 14 free, shadcn-ui-blocks 6). This checks every item's registry JSON once and
// records which ones install freely, so the build can mark them `access: code` with an install url.
//
//   bun tools/registry-access.mjs --verify <domain>[,<domain>…] [--force]   check each item, write the cache
//   bun tools/registry-access.mjs --all [--force]                           every gated registry with a registry.json
//
// Cache: catalog/corpus/sites/<domain>/registry-access.json { checked_at, base, results: { <registry name>: "code" |
// "gated" }, stats }. A re-run checks only names missing from `results` (transient answers are never recorded).
// Pacing, robots.txt and blocked-host handling come from tools/registry-urls.mjs (createFetcher): a registry whose
// robots.txt disallows its /r/ path (shadcnblocks.com) is not checked and stays gated.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FILE, loadJSON, pool, saveJSON } from "./lib.mjs";
import { parentsByDomain, registryAccessFile } from "./items.mjs";
import { createFetcher } from "./registry-urls.mjs";

const SITES = join(FILE.corpus, "sites");
const registryOf = (e) => e.probe?.registry || e.probe?.registry_index || e.probe?.registry_root || null;
export const isGatedStatus = (s) => s === 401 || s === 402 || s === 403;

/** "code" for a 200 registry-item JSON, "gated" for 401/402/403, null for anything to retry or not understood. */
export function accessVerdict(res) {
  if (isGatedStatus(res?.status)) return "gated";
  if (res?.status !== 200) return null;
  try {
    const j = JSON.parse(res.text || "");
    return j && typeof j === "object" && typeof j.name === "string" ? "code" : null;
  } catch {
    return null;
  }
}

/** Gated registries with a corpus registry.json → [{ domain, base, names }]. */
export function gatedRegistries(entries) {
  const out = [];
  for (const [domain, parent] of parentsByDomain(entries)) {
    const reg = registryOf(parent);
    if (!reg?.url || !isGatedStatus(reg.item_status)) continue;
    const file = join(SITES, domain, "registry.json");
    if (!existsSync(file)) continue;
    const data = loadJSON(file);
    const names = (Array.isArray(data) ? data : data?.items || []).map((r) => r?.name).filter((n) => typeof n === "string");
    out.push({ domain, base: reg.url.replace(/\/[^/]+\.json$/, ""), names: [...new Set(names)] });
  }
  return out;
}

async function verifyDomain({ domain, base, names }, fetcher, { force = false } = {}) {
  const file = registryAccessFile(domain);
  const cache = !force && existsSync(file) ? loadJSON(file) : null;
  const results = cache?.base === base && cache.results ? { ...cache.results } : {};
  const todo = names.filter((n) => !Object.hasOwn(results, n));
  const scope = fetcher.scope();
  const t = performance.now();
  const robots = todo.length ? await scope.allowed(`${base}/${encodeURIComponent(todo[0])}.json`) : true;
  let unfinished = 0;
  if (robots === true) {
    let done = 0;
    await Promise.all(
      todo.map(async (n) => {
        const v = accessVerdict(await scope.request(`${base}/${encodeURIComponent(n)}.json`));
        if (v) results[n] = v;
        else unfinished++;
        if (++done % 250 === 0) console.error(`  ${domain}: ${done}/${todo.length}`);
      }),
    );
  } else unfinished = todo.length;
  const vals = Object.values(results);
  const stats = { names: names.length, code: vals.filter((v) => v === "code").length, gated: vals.filter((v) => v === "gated").length, unfinished, requests: scope.requests() };
  if (robots === true) saveJSON(file, { checked_at: new Date().toISOString(), base, results, stats });
  const why = robots === false ? " · robots.txt disallows the registry path — not checked, stays gated" : robots === "retry" ? " · robots.txt unreadable — retry later" : "";
  console.log(`${domain}: ${names.length} names · checked ${todo.length} · free ${stats.code} · gated ${stats.gated} · unfinished ${unfinished} · requests ${stats.requests} · ${((performance.now() - t) / 1000).toFixed(0)}s${why}`);
  return stats;
}

if (import.meta.main) {
  const arg = (k) => {
    const eq = process.argv.find((a) => a.startsWith(`--${k}=`));
    if (eq) return eq.slice(k.length + 3);
    const i = process.argv.indexOf(`--${k}`);
    return i >= 0 ? process.argv[i + 1] || "" : "";
  };
  const force = process.argv.includes("--force");
  const entries = loadJSON(FILE.catalog)?.items || [];
  let regs = gatedRegistries(entries);
  if (!process.argv.includes("--all")) {
    const want = new Set(String(arg("verify") || "").split(",").filter(Boolean));
    if (!want.size) {
      console.error("usage: bun tools/registry-access.mjs --verify <domain>[,…] | --all [--force]");
      console.error(`gated registries with a registry.json: ${regs.map((r) => `${r.domain} (${r.names.length})`).join(", ")}`);
      process.exit(1);
    }
    regs = regs.filter((r) => want.has(r.domain));
  }
  const fetcher = createFetcher();
  await pool(regs, 4, (r) => verifyDomain(r, fetcher, { force }));
}

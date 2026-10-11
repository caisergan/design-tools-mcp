#!/usr/bin/env bun
// Phase 2B queue (MCP-PLAN 2B pipeline step 1): which entries need a metadata record (re)written.
//
//   bun tools/metadata-queue.mjs     → catalog/metadata/_queue.json (gitignored) + counts and a token estimate
//
// Queued: no record · a record older than 90 days · a record whose hints_hash differs from the entry's current source
// hints. Order: curated → readable (reach.ok) → rest, catalog order inside each. Dead entries (reach.reason dead /
// repo-gone) are skipped and listed.
import { existsSync } from "node:fs";
import { loadJSON, saveJSON } from "./lib.mjs";
import { STALE_DAYS, digestFile, hintsHash, isDead, isStale, loadRecord, recordFile } from "./metadata.mjs";
import { QUEUE_FILE, assemblePrompt, batchText } from "./metadata-batch.mjs";
import { estimateTokens } from "./crawl.mjs";

// MCP-PLAN 2B "Cost" before a digest exists: ≈ 7.5k digest tokens a site / repo, ≈ 1.4k a page (the plan's 10k / 4k
// totals minus its ~2k prompt and ~0.6k output).
export const PLAN_DIGEST = { site: 7_500, repo: 7_500, page: 1_400 };
export const OUTPUT_TOKENS = 600;

/** Why one entry is queued, or null when its record is current. */
export function queueReason(entry, record, { now = Date.now(), days = STALE_DAYS } = {}) {
  if (!record) return "new";
  if (isStale(record, now, days)) return "stale";
  if (record.hints_hash !== hintsHash(entry)) return "hints-changed";
  return null;
}

const rank = (e) => (e.origins?.includes("curated") ? 0 : e.reach?.ok ? 1 : 2);

/**
 * entries: source entries (loadItems with metadata: false), in catalog order. readRecord(id) → record or null.
 * → { items: [{ id, kind, reason, curated, readable }], dead: [ids], current: n }
 */
export function buildQueue(entries, { readRecord = (id) => (existsSync(recordFile(id)) ? loadRecord(id) : null), now = Date.now() } = {}) {
  const items = [];
  const dead = [];
  let current = 0;
  entries.forEach((e, order) => {
    if (isDead(e)) return dead.push(e.id);
    const reason = queueReason(e, readRecord(e.id), { now });
    if (!reason) return current++;
    items.push({ id: e.id, kind: e.kind, reason, curated: Boolean(e.origins?.includes("curated")), readable: Boolean(e.reach?.ok), _rank: rank(e), _order: order });
  });
  items.sort((a, b) => a._rank - b._rank || a._order - b._order);
  return { items: items.map(({ _rank, _order, ...x }) => x), dead, current };
}

/**
 * Tokens the run reads and writes for the queue, by kind: the measured digest where one exists (else the plan's
 * average), the prompt once per batch of `size`, the output per record. A session's context grows as it works through
 * its batch, so the billed input is higher than this unless the model caches the prefix (see RUN.md).
 */
export function estimate(items, { digestTokens = () => null, promptTokens = 3_800, size = 20 } = {}) {
  const by = {};
  for (const it of items) {
    const k = (by[it.kind] ||= { n: 0, measured: 0, digest: 0 });
    const t = digestTokens(it.id);
    k.n++;
    if (t != null) k.measured++;
    k.digest += t ?? PLAN_DIGEST[it.kind] ?? PLAN_DIGEST.site;
  }
  const n = items.length;
  const prompt = Math.ceil(n / size) * promptTokens;
  const digest = Object.values(by).reduce((a, k) => a + k.digest, 0);
  return { by, prompt, digest, output: n * OUTPUT_TOKENS, total: prompt + digest + n * OUTPUT_TOKENS };
}

async function main() {
  const { loadItems } = await import("./build.mjs");
  const entries = loadItems({ metadata: false });
  const q = buildQueue(entries);
  const prompt = estimateTokens(batchText(1, ["x"], { prompt: assemblePrompt() }));
  const est = estimate(q.items, { digestTokens: (id) => (existsSync(digestFile(id)) ? loadJSON(digestFile(id))?.tokens ?? null : null), promptTokens: prompt });
  saveJSON(QUEUE_FILE, { generated_at: new Date().toISOString(), stale_days: STALE_DAYS, counts: { queued: q.items.length, current: q.current, dead: q.dead.length }, estimate: est, dead: q.dead, items: q.items });
  const byReason = q.items.reduce((m, i) => ((m[i.reason] = (m[i.reason] || 0) + 1), m), {});
  console.log(`_queue.json  ${q.items.length} queued (${Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join(" · ")}) · ${q.current} current · ${q.dead.length} dead skipped`);
  for (const [kind, k] of Object.entries(est.by)) console.log(`  ${kind.padEnd(5)} ${String(k.n).padStart(5)} entries · digests ≈ ${(k.digest / 1e6).toFixed(2)}M tokens (${k.measured} measured, the rest at the plan's ${PLAN_DIGEST[kind]})`);
  console.log(`  run ≈ ${(est.total / 1e6).toFixed(1)}M tokens: digests ${(est.digest / 1e6).toFixed(1)}M + prompt ${(est.prompt / 1e6).toFixed(1)}M (one per 20-entry batch) + output ${(est.output / 1e6).toFixed(1)}M`);
  console.log(`  order: ${q.items.filter((i) => i.curated).length} curated → ${q.items.filter((i) => !i.curated && i.readable).length} readable → ${q.items.filter((i) => !i.curated && !i.readable).length} rest`);
}

if (import.meta.main) await main();

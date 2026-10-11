#!/usr/bin/env bun
// Phase 2B run driver: runs the batch files of tools/metadata-batch.mjs as headless omp sessions, several at once.
// One session = one batch = one `omp -p` process; its JSON event stream goes to _batches/<n>.log (gitignored).
//
//   bun tools/metadata-run.mjs [--batches 1-6 | 3,7] [--parallel 6] [--model deepseek/deepseek-v4.1-flash]
//                              [--thinking max] [--max-time 60m] [--redo]
//   bun tools/metadata-run.mjs --usage                      token / cost totals of the logs that exist, run nothing
//
// A batch counts as done when `metadata-check --id <its ids>` passes; done batches are skipped unless --redo, so a
// stopped run resumes where it was. Records are written by the sessions themselves (catalog/metadata/<id>.json).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { ROOT, pool, saveJSON } from "./lib.mjs";
import { BATCH_DIR, marker } from "./metadata-batch.mjs";

const TOOLS = "read,write,edit,bash,grep,glob,web_search";
const batchNumbers = () =>
  readdirSync(BATCH_DIR)
    .map((f) => /^(\d+)\.md$/.exec(f)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);

export function parseBatches(spec, all) {
  if (!spec) return all;
  const want = new Set();
  for (const part of spec.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`bad --batches part: ${part}`);
    for (let n = +m[1]; n <= +(m[2] ?? m[1]); n++) want.add(n);
  }
  return all.filter((n) => want.has(n));
}

/** Sum the usage of one omp --mode json log, each model response once (omp repeats a message's usage in later events). */
export function logUsage(text) {
  const seen = new Map();
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const walk = (o) => {
      if (!o || typeof o !== "object") return;
      if (o.usage && typeof o.usage === "object" && "input" in o.usage) {
        const key = o.responseId || `${o.timestamp}:${o.usage.totalTokens}`;
        seen.set(key, o.usage);
      }
      for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
    };
    walk(ev);
  }
  const t = { responses: 0, input: 0, cacheRead: 0, output: 0, reasoning: 0, cost: 0 };
  for (const u of seen.values()) {
    t.responses++;
    t.input += u.input || 0;
    t.cacheRead += u.cacheRead || 0;
    t.output += u.output || 0;
    t.reasoning += u.reasoningTokens || 0;
    t.cost += u.cost?.total || 0;
  }
  return t;
}

const idsOf = (n) => readFileSync(join(BATCH_DIR, `${n}.ids`), "utf8").trim();
const checkBatch = (n) => spawnSync("bun", ["tools/metadata-check.mjs", "--id", idsOf(n)], { cwd: ROOT, encoding: "utf8" });

function runBatch(n, { model, thinking, maxTime }) {
  return new Promise((resolve) => {
    const log = createWriteStream(join(BATCH_DIR, `${n}.log`));
    const args = ["-p", "--mode", "json", "--no-session", "--model", model, "--thinking", thinking, "--tools", TOOLS,
      "--approval-mode", "yolo", "--max-time", maxTime, `Read catalog/metadata/_batches/${n}.md and do exactly what it says.`];
    const p = spawn("omp", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.pipe(log, { end: false });
    p.stderr.pipe(log, { end: false });
    p.on("close", (code) => {
      log.end();
      resolve(code);
    });
  });
}

function usageReport(nums) {
  const all = { batches: 0, responses: 0, input: 0, cacheRead: 0, output: 0, reasoning: 0, cost: 0 };
  for (const n of nums) {
    const f = join(BATCH_DIR, `${n}.log`);
    if (!existsSync(f)) continue;
    const u = logUsage(readFileSync(f, "utf8"));
    all.batches++;
    for (const k of Object.keys(u)) all[k] += u[k];
  }
  return all;
}

const fmt = (u) =>
  `${u.batches} batch logs · ${u.responses} model calls · input ${(u.input / 1e6).toFixed(2)}M (cache read ${(u.cacheRead / 1e6).toFixed(2)}M) · output ${(u.output / 1e6).toFixed(2)}M (reasoning ${(u.reasoning / 1e6).toFixed(2)}M) · $${u.cost.toFixed(2)}`;

async function main(argv) {
  const arg = (k, d) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : d;
  };
  const all = batchNumbers();
  const nums = parseBatches(arg("--batches"), all);
  if (argv.includes("--usage")) return console.log(fmt(usageReport(nums)));
  const opts = { model: arg("--model", "deepseek/deepseek-v4.1-flash"), thinking: arg("--thinking", "max"), maxTime: arg("--max-time", "60m") };
  const todo = argv.includes("--redo") ? nums : nums.filter((n) => checkBatch(n).status !== 0);
  console.log(`${nums.length} batches selected · ${nums.length - todo.length} already pass the check · running ${todo.length} with ${arg("--parallel", 6)} at once (${opts.model}, thinking ${opts.thinking})`);
  const results = {};
  await pool(todo, Number(arg("--parallel", 6)), async (n) => {
    const t = Date.now();
    const code = await runBatch(n, opts);
    const log = readFileSync(join(BATCH_DIR, `${n}.log`), "utf8");
    const check = checkBatch(n);
    const u = logUsage(log);
    results[n] = { exit: code, marker: log.includes(marker(n)), check: check.status === 0, minutes: +((Date.now() - t) / 60000).toFixed(1), ...u };
    const bad = check.status === 0 ? "" : ` — check: ${(check.stdout + check.stderr).trim().split("\n").filter((l) => !/^ok /.test(l)).slice(0, 3).join(" | ")}`;
    console.log(`batch ${n}: exit ${code} · ${results[n].check ? "check ok" : "CHECK FAILED"} · ${results[n].minutes} min · ${u.responses} calls · in ${(u.input / 1000).toFixed(0)}k out ${(u.output / 1000).toFixed(0)}k · $${u.cost.toFixed(3)}${bad}`);
  });
  saveJSON(join(BATCH_DIR, `_run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), results);
  console.log(fmt(usageReport(nums)));
}

if (import.meta.main) await main(process.argv.slice(2));

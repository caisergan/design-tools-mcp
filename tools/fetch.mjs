#!/usr/bin/env bun
// Bulk-download every machine-readable payload found by probe.mjs into catalog/corpus/.
// Usage: bun tools/fetch.mjs [--llms] [--repos] [--registries] [--items=40] [--max-mb=3]
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { FILE, saveText, loadJSON, pool, slug, repoParts, resolveItemBase } from "./lib.mjs";
import { loadItems } from "./build.mjs";

const CONCURRENCY = Number(process.env.FETCH_CONCURRENCY || 12);
const MAX_MB = Number((process.argv.find((a) => a.startsWith("--max-mb=")) || "").split("=")[1] || 3);
const MAX_ITEMS = Number((process.argv.find((a) => a.startsWith("--items=")) || "").split("=")[1] || 40);
const UA = "Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)";
const flag = (name) => process.argv.includes(`--${name}`);
const flagVal = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").split("=")[1];
const only = flagVal("only")?.split(",").map((s) => s.trim()).filter(Boolean);
const anyMode = flag("llms") || flag("repos") || flag("registries");
const want = (m) => !anyMode || flag(m);

async function download(url, dest, { maxBytes = MAX_MB * 1e6 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ctrl.signal, headers: { "user-agent": UA } });
    if (!res.ok) return { ok: false, status: res.status };
    if (Number(res.headers.get("content-length") || 0) > maxBytes) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, reason: "too-large" };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return { ok: false, reason: "too-large" };
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    return { ok: true, bytes: buf.length, text: buf.toString("utf8") };
  } catch (e) {
    return { ok: false, reason: e?.name === "TimeoutError" ? "timeout" : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

const META = join(FILE.corpus, ".meta.json");
let manifest = [];
const meta = loadJSON(META, {}); // corpus-relative path -> { name, kind, note }
const added = new Set();
const rel = (p) => p.slice(FILE.corpus.length + 1);

function record(item, kind, path, bytes, note = "") {
  const r = rel(path);
  added.add(r);
  meta[r] = { name: item.name, kind, note: note || meta[r]?.note || "" };
}

function inferKind(r) {
  if (r.startsWith("repos/")) return /SKILL\.md$/.test(r) ? "skill" : "repo";
  if (/llms-full\.txt$/.test(r)) return "llms-full";
  if (/llms\.txt$/.test(r)) return "llms";
  if (/registry\.json$/.test(r)) return "registry";
  if (r.includes("/items/")) return "registry-item";
  if (r.includes("/src/")) return "component-src";
  return "file";
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (!/\.meta\.json$|MANIFEST\.md$/.test(e.name)) out.push(p);
  }
  return out;
}

const heading = (p) => {
  try {
    return (/^#\s+(.+)$/m.exec(readFileSync(p, "utf8").slice(0, 4000)) || [])[1]?.trim() || "";
  } catch {
    return "";
  }
};

/** Rewrite MANIFEST.md from what is actually on disk, so partial runs stay accurate. */
function writeManifest() {
  const rows = walk(FILE.corpus).map((p) => {
    const r = rel(p);
    const m = meta[r] || {};
    return {
      name: m.name || r.split("/")[1] || r,
      kind: m.kind || inferKind(r),
      path: r,
      bytes: statSync(p).size,
      note: m.note || (/\.(md|txt)$/.test(r) ? heading(p) : ""),
      added: added.has(r),
    };
  });
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  const counts = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] || 0) + 1;
  const total = rows.reduce((n, r) => n + r.bytes, 0);
  saveText(META, JSON.stringify(meta, null, 2) + "\n");
  saveText(
    FILE.manifest,
    [
      "# Corpus manifest",
      "",
      `> ${rows.length} files · ${(total / 1e6).toFixed(1)} MB · updated ${new Date().toISOString().slice(0, 10)}`,
      `> ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(" · ")}`,
      "> Read this before browsing: pick the `kind` you need, then open the file directly.",
      "",
      "| Resource | kind | file | kB | note |",
      "| --- | --- | --- | --- | --- |",
      ...rows.map(
        (r) => `| ${r.name} | ${r.kind} | \`corpus/${r.path}\` | ${(r.bytes / 1000).toFixed(1)} | ${r.note} |`,
      ),
      "",
    ].join("\n"),
  );
  manifest = rows;
}

async function fetchLlms(item, dir) {
  const p = item.probe;
  const jobs = [];
  if (p.llms?.ok !== false && p.llms) jobs.push(["llms.txt", p.llms.url]);
  if (p.llms_full) jobs.push(["llms-full.txt", p.llms_full.url]);
  for (const [file, url] of jobs) {
    const dest = join(dir, file);
    const r = await download(url, dest);
    if (r.ok) record(item, "llms", dest, r.bytes, "");
  }
  return jobs.length > 0;
}

async function fetchRepo(item, dir) {
  const { owner, repo } = repoParts(item.url);
  const raw = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD`;
  let got = false;
  for (const f of ["README.md", "SKILL.md"]) {
    const r = await download(`${raw}/${f}`, join(dir, f));
    if (r.ok) {
      record(item, "repo", join(dir, f), r.bytes, (/^#\s+(.+)$/m.exec(r.text) || [])[1] || "");
      got = true;
      if (f === "SKILL.md") break; // skill file is the authoritative one
    }
  }
  return got;
}

async function fetchRegistry(item, dir) {
  const p = item.probe;
  const index = p.registry || p.registry_index || p.registry_root;
  // registry indexes are the enumeration source: allow far larger files than component payloads
  const r = await download(index.url, join(dir, "registry.json"), { maxBytes: 16e6 });
  if (!r.ok) return false;
  let data;
  try {
    data = JSON.parse(r.text);
  } catch {
    record(item, "registry", join(dir, "registry.json"), r.bytes, "unparsed");
    return true;
  }
  const items = Array.isArray(data) ? data : data.items || [];
  const firstName = items.find((i) => i?.name)?.name;
  const found = firstName ? await resolveItemBase(index.url, firstName) : null;
  const note = !found
    ? `${items.length} items listed, item JSON not served publicly`
    : found.gated
      ? `${items.length} items listed, some need a license key`
      : `${items.length} items listed`;
  record(item, "registry", join(dir, "registry.json"), r.bytes, note);
  if (!found || found.gated) return true;
  const base = found.base;
  for (const entry of items.slice(0, MAX_ITEMS)) {
    if (!entry?.name) continue;
    const dest = join(dir, "items", `${slug(entry.name)}.json`);
    const it = await download(`${base}/${entry.name}.json`, dest);
    if (!it.ok) continue;
    record(item, "registry-item", dest, it.bytes, entry.name);
    // registry items carry the actual component source inline — write it out so it is greppable
    let def;
    try {
      def = JSON.parse(it.text);
    } catch {
      continue;
    }
    for (const f of def.files || []) {
      const rel = f?.path || f?.target; // Svelte registries use `target` instead of `path`
      if (typeof f?.content !== "string" || typeof rel !== "string" || rel.includes("..")) continue;
      const out = join(dir, "src", slug(def.name || entry.name), rel);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, f.content);
      record(item, "component-src", out, f.content.length, `${def.name || entry.name}/${rel}`);
    }
  }
  return true;
}

if (import.meta.main) {
  const probe = loadJSON(FILE.probe);
  if (!probe) {
    console.error("probe.json missing — run: bun tools/probe.mjs");
    process.exit(1);
  }
  const items = loadItems();
  const targets = items.filter(
    (i) => i.probe && Object.keys(i.probe).length > 0 && (!only || only.includes(i.domain) || only.includes(i.url)),
  );
  console.log(
    `corpus: ${targets.length} entries with endpoints${only ? ` (filtered to ${only.join(", ")})` : ""} · max ${MAX_MB}MB/file · ${MAX_ITEMS} registry items`,
  );

  let done = 0;
  const stats = { llms: 0, repo: 0, registry: 0 };
  await pool(targets, CONCURRENCY, async (item) => {
    const dir =
      item.kind === "repo"
        ? join(FILE.corpus, "repos", `${repoParts(item.url).owner}__${repoParts(item.url).repo}`)
        : join(FILE.corpus, "sites", item.domain);
    if (want("llms") && (item.probe.llms || item.probe.llms_full)) if (await fetchLlms(item, dir)) stats.llms++;
    if (want("registries") && (item.probe.registry || item.probe.registry_index || item.probe.registry_root))
      if (await fetchRegistry(item, dir)) stats.registry++;
    if (want("repos") && item.kind === "repo") if (await fetchRepo(item, dir)) stats.repo++;
    if (++done % 20 === 0) console.error(`  ${done}/${targets.length}`);
  });

  writeManifest();
  const on = manifest.filter((m) => m.added).length;
  console.log(`fetched ${on} files this run — manifest now covers ${manifest.length} files`);
  console.log(`manifest -> ${FILE.manifest}`);
}

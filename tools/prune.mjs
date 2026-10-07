#!/usr/bin/env bun
// Sweep the catalog for entries the MCP cannot read, and mark them.
//
// Reachable, from the MCP's point of view, means at least one of:
//   · a local corpus copy the server can serve offline,
//   · for repos: README.md / SKILL.md on raw.githubusercontent.com,
//   · a shadcn registry whose item JSON (or inline item payload) answers without auth,
//   · llms.txt / llms-full.txt served as text (not the SPA's HTML catch-all).
// Everything else is marked `unreadable:<reason>` — reason ∈ no-endpoint, gated, bot-walled,
// dead, repo-gone — and shows up in catalog.json (`reach`), ROUTER.md and every MCP answer,
// so an agent can hand the URL to the user instead of spending a fetch on it.
//
//   bun tools/prune.mjs                                 report only, whole catalog
//   bun tools/prune.mjs --category components           report one category (taxonomy id)
//   bun tools/prune.mjs --apply                          write catalog/reachability.json + rebuild
//   bun tools/prune.mjs --delete [--reasons dead,gated]  also drop them from the catalog
//
// Marks are the default; --delete is the opt-in hammer. It writes catalog/blocklist.json,
// which build.mjs honours, and it removes a domain wholesale only when every one of its
// entries is unreadable.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FILE, loadJSON, saveJSON, pool, repoParts, resolveItemBase, isGatedResponse } from "./lib.mjs";
import { loadItems, render } from "./build.mjs";

const UA = "Mozilla/5.0 (compatible; design-tools-mcp/1.0)";
const TIMEOUT = 15_000;

const corpusDir = (it) => {
  if (it.kind === "repo") {
    const rp = repoParts(it.url);
    return rp ? join(FILE.corpus, "repos", `${rp.owner}__${rp.repo}`) : null;
  }
  return join(FILE.corpus, "sites", it.domain);
};

function corpusHit(it) {
  const dir = corpusDir(it);
  if (!dir || !existsSync(dir)) return null;
  // registry.json alone is only a list of names — the source still has to come over the wire.
  const names = it.kind === "repo" ? ["SKILL.md", "README.md"] : ["llms.txt", "llms-full.txt"];
  for (const f of names) {
    const p = join(dir, f);
    if (existsSync(p) && statSync(p).size > 0) return f;
  }
  const src = join(dir, "src");
  if (existsSync(src) && readdirSync(src).length) return "src/";
  return null;
}

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const challenge = /challenge/i.test(res.headers.get("cf-mitigated") || "");
    const body = await res.text().catch(() => "");
    if (!res.ok) return { status: res.status, ok: false, challenge, body };
    return { status: res.status, ok: true, body, contentType: res.headers.get("content-type") || "" };
  } catch (e) {
    return { status: 0, ok: false, error: e.name === "TimeoutError" ? "timeout" : "network" };
  }
}

const isHtml = (body, contentType = "") =>
  /text\/html/i.test(contentType) || /^\s*(?:<!doctype html|<html)/i.test(body);

/** A wall, not a 404 page that merely mentions the word "unauthorized" in its HTML shell. */
const looksGated = (r) => {
  if (r.status === 401) return true;
  const json = /json/i.test(r.contentType || "") || /^\s*[{[]/.test(r.body || "");
  return json && isGatedResponse(r.status, r.body);
};

/** Registries publish items either inline in the index or as one JSON per item, behind an auth wall or not. */
async function registryCheck(it) {
  const p = it.probe || {};
  const reg = p.registry || p.registry_index || p.registry_root;
  if (!reg) return null;
  const idx = await fetchText(reg.url);
  if (!idx.ok)
    return {
      state: idx.challenge || idx.status === 403 ? "challenge" : looksGated(idx) ? "gated" : "dead",
      detail: `${reg.url} -> ${idx.status || idx.error}`,
    };
  let items;
  try {
    const j = JSON.parse(idx.body);
    items = Array.isArray(j) ? j : j.items || [];
  } catch {
    return { state: "unreadable", detail: `${reg.url} -> not JSON` };
  }
  if (!items.length) return { state: "empty", detail: `${reg.url} -> 0 items` };
  const inline = items.some((c) => (c?.files || []).some((f) => typeof f?.content === "string") || c?.cssVars || c?.css);
  if (inline) return { state: "ok", how: "registry inline", detail: `${items.length} items inline` };
  const first = items.find((c) => c?.name)?.name;
  if (!first) return { state: "empty", detail: `${reg.url} -> items carry no name` };
  const found = await resolveItemBase(reg.url, first, { ua: UA, timeout: TIMEOUT });
  if (found?.data) return { state: "ok", how: "registry item", detail: `${items.length} items, ${first}.json served` };
  if (found?.gated) return { state: "gated", detail: `${first}.json -> HTTP ${found.gated}` };
  return { state: "no-items", detail: `${items.length} items, no public item JSON (${first}.json)` };
}

async function llmsCheck(it) {
  const p = it.probe || {};
  const urls = [];
  for (const f of ["llms.txt", "llms-full.txt"]) {
    const probed = f === "llms-full.txt" ? p.llms_full?.url : p.llms?.url;
    const guess = it.kind !== "repo" && it.domain !== "github.com" ? `https://${it.domain}/${f}` : null;
    for (const u of [probed, guess]) if (u && !urls.includes(u)) urls.push(u);
  }
  const detail = [];
  let gated = false;
  let challenge = false;
  for (const url of urls) {
    const r = await fetchText(url);
    if (r.ok && r.body.trim() && !isHtml(r.body, r.contentType))
      return { state: "ok", how: "llms.txt", detail: `${url} (${r.body.length} chars)` };
    const wall = !r.ok && looksGated(r);
    if (r.challenge || (!r.ok && r.status === 403 && !wall)) challenge = true;
    if (wall) gated = true;
    detail.push(
      `${url} -> ${r.ok ? (r.body.trim() ? "html" : "empty") : r.status || r.error}${wall ? " (login/licence)" : challenge && !r.ok ? " (bot challenge)" : ""}`,
    );
  }
  return { state: gated ? "gated" : challenge ? "challenge" : "no-llms", detail: detail.join("; ") };
}

async function verdict(it) {
  const local = corpusHit(it);
  if (local) return { reachable: true, how: `corpus:${local}` };

  const repo = it.kind === "repo" ? repoParts(it.url) : null;
  if (repo) {
    for (const f of ["SKILL.md", "README.md"]) {
      const url = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/${f}`;
      const r = await fetchText(url);
      if (r.ok && r.body.trim()) return { reachable: true, how: `repo:${f}` };
    }
  }

  const reg = await registryCheck(it);
  if (reg?.state === "ok") return { reachable: true, how: reg.how, detail: reg.detail };
  const llms = await llmsCheck(it);
  if (llms.state === "ok") return { reachable: true, how: llms.how, detail: llms.detail };

  const gated = reg?.state === "gated" || llms.state === "gated";
  const challenge = reg?.state === "challenge" || llms.state === "challenge";
  const home = await fetchText(it.kind === "repo" ? it.url : `https://${it.domain}/`);
  const gone = home.status === 0 || home.status >= 500;
  const reason = gone ? "dead" : gated ? "gated" : challenge ? "bot-walled" : repo ? "repo-gone" : "no-endpoint";
  const detail = [`home -> ${home.status || home.error}`, reg?.detail, llms?.detail].filter(Boolean).join(" | ");
  return { reachable: false, reason, detail };
}

const argv = process.argv.slice(2);
const DELETE = argv.includes("--delete");
const APPLY = DELETE || argv.includes("--apply");
const catIdx = argv.indexOf("--category");
const CATEGORY = catIdx >= 0 ? argv[catIdx + 1] : null;
const reasonsIdx = argv.indexOf("--reasons");
const REASONS = reasonsIdx >= 0 ? argv[reasonsIdx + 1].split(",") : null;

let items = loadItems();
if (CATEGORY) items = items.filter((it) => it.categories.includes(CATEGORY));
console.log(`sweeping ${items.length} entr${items.length === 1 ? "y" : "ies"}${CATEGORY ? ` in "${CATEGORY}"` : ""} …`);

const results = await pool(items, 16, async (it) => ({ it, ...(await verdict(it)) }));

const unreachable = results.filter((r) => !r.reachable);
const reasons = {};
for (const r of unreachable) (reasons[r.reason] ||= []).push(r);

console.log(`\nreachable: ${results.length - unreachable.length} · unreachable: ${unreachable.length}`);
const byCat = {};
for (const r of unreachable) for (const c of r.it.categories) byCat[c] = (byCat[c] || 0) + 1;
if (Object.keys(byCat).length) {
  console.log("\n## unreachable by category");
  for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}  ${c}`);
}
for (const [reason, list] of Object.entries(reasons).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n## ${reason} (${list.length})`);
  for (const r of list.slice(0, 400)) console.log(`   ${r.it.domain}\t${r.it.name}\t${(r.detail || "").slice(0, 150)}`);
  if (list.length > 400) console.log(`   … +${list.length - 400} more`);
}

if (!APPLY) {
  console.log("\ndry run — nothing written. --apply marks the entries, --delete also blocklists them");
} else {
  const checkedAt = new Date().toISOString();
  // 1. marks: every swept entry records what the MCP can (not) get from it.
  const prevMarks = loadJSON(FILE.reachability)?.items || {};
  const marks = { ...prevMarks };
  for (const r of results)
    marks[r.it.url] = r.reachable
      ? { ok: true, how: r.how, checked_at: checkedAt }
      : { ok: false, reason: r.reason, detail: (r.detail || "").slice(0, 300), checked_at: checkedAt };
  saveJSON(FILE.reachability, {
    generated_at: checkedAt,
    criteria:
      "MCP reachability: corpus copy, repo README/SKILL on raw.githubusercontent.com, shadcn registry item JSON (or inline payload), llms.txt / llms-full.txt as text",
    items: marks,
  });

  // 2. optional removal: --delete turns the marks into a blocklist build.mjs honours.
  let deleted = 0;
  if (DELETE) {
    const drop = unreachable.filter((r) => !REASONS || REASONS.includes(r.reason));
    const droppedUrls = new Map(drop.map((r) => [r.it.url, r]));
    // A domain only leaves wholesale when every one of its entries is unreachable; otherwise
    // the surviving pages keep it in the catalog and only the dead URL goes.
    const byDomain = new Map();
    for (const it of items) byDomain.set(it.domain, [...(byDomain.get(it.domain) || []), it]);
    const fresh = [];
    for (const [domain, list] of byDomain) {
      const hits = list.filter((it) => droppedUrls.has(it.url));
      if (!hits.length) continue;
      const whole = hits.length === list.length;
      for (const r of whole ? [hits[0]] : hits)
        fresh.push({
          url: r.it.url,
          domain,
          scope: whole ? "domain" : "url",
          name: r.it.name,
          reason: r.reason,
          detail: (r.detail || "").slice(0, 300),
          checked_at: checkedAt,
        });
    }
    const prev = loadJSON(FILE.blocklist)?.items || [];
    const merged = new Map(prev.map((b) => [`${b.scope || "domain"}:${b.url}`, b]));
    for (const f of fresh) merged.set(`${f.scope}:${f.url}`, f);
    deleted = fresh.length;
    saveJSON(FILE.blocklist, {
      generated_at: checkedAt,
      criteria: "same as reachability.json — entries listed here are removed by build.mjs",
      items: [...merged.values()].sort((a, b) => a.domain.localeCompare(b.domain)),
    });
  }

  const catalog = render(loadItems());
  console.log(
    `\nmarks: ${results.length} entries checked -> catalog/reachability.json (${unreachable.length} unreadable)\n` +
      (DELETE ? `blocklist: ${deleted} entries dropped -> catalog/blocklist.json\n` : "") +
      `catalog.json ${catalog.stats.items} items · unreadable ${catalog.stats.unreadable}${DELETE ? ` · pruned ${catalog.stats.pruned}` : ""} · ROUTER.md + llms.txt rebuilt`,
  );
}

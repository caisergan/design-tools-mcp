#!/usr/bin/env bun
// Bulk-probe every catalog entry for machine-readable endpoints an LLM can pull.
import { FILE, saveJSON, loadJSON, pool, repoParts } from "./lib.mjs";
import { loadItems, render } from "./build.mjs";

const TIMEOUT = Number(process.env.PROBE_TIMEOUT_MS || 6000);
const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY || 24);
const UA = "Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)";

async function get(url, limit = 4096) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ctrl.signal, headers: { "user-agent": UA } });
    const type = (res.headers.get("content-type") || "").split(";")[0].trim();
    const declared = Number(res.headers.get("content-length") || 0);
    let body = "";
    if (res.body && res.status < 400) {
      const reader = res.body.getReader();
      const parts = [];
      let size = 0;
      while (size < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        size += value.length;
      }
      await reader.cancel().catch(() => {});
      body = Buffer.concat(parts.map((p) => Buffer.from(p))).subarray(0, limit).toString("utf8");
    } else if (res.body) {
      await res.body.cancel().catch(() => {});
    }
    return { url, status: res.status, type, declared, head: body.slice(0, 300), body };
  } catch (e) {
    const reason = e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : String(e?.message || e);
    return { url, status: 0, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

const isText = (r) =>
  r.status === 200 && !/html/i.test(r.type || "") && !/^\s*<(!doctype|html)/i.test(r.head || "");
const isJson = (r) => r.status === 200 && /^\s*[{[]/.test(r.head || "");
const isXml = (r) => r.status === 200 && (/xml/i.test(r.type || "") || /^\s*<\?xml/.test(r.head || ""));

function jsonSummary(r) {
  try {
    const data = JSON.parse(r.body);
    const list = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : null;
    if (list) {
      const first = list.find((i) => i?.name)?.name;
      return { items: list.length, first };
    }
    if (data.$schema) return { schema: data.$schema };
    return { keys: Object.keys(data).slice(0, 8) };
  } catch {
    return { parse_error: true };
  }
}

export async function probeItem(item) {
  const out = { mcp: /\/mcp\b/.test(item.url) || undefined };
  const origin = new URL(item.url).origin;

  const targets = [];
  if (item.kind === "repo") {
    const { owner, repo } = repoParts(item.url);
    const raw = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD`;
    targets.push(["readme", `${raw}/README.md`, isText], ["skill", `${raw}/SKILL.md`, isText], ["registry", `${raw}/registry.json`, isJson]);
  } else {
    targets.push(
      ["llms", `${origin}/llms.txt`, isText],
      ["registry", `${origin}/r/registry.json`, isJson],
      ["registry_index", `${origin}/r/index.json`, isJson],
      ["registry_root", `${origin}/registry.json`, isJson],
      ["skill_index", `${origin}/.well-known/skills/index.json`, isJson],
      ["sitemap", `${origin}/sitemap.xml`, isXml],
    );
  }

  for (const [key, url, validate] of targets) {
    // registry indexes can be multi-MB; everything else only needs a head
    const r = await get(url, key.includes("registry") ? 4 * 1024 * 1024 : 8192);
    if (!validate(r)) continue;
    const rec = { url: r.url, status: r.status, bytes: r.declared || r.body.length };
    if (key === "llms") {
      rec.title = (/^#\s+(.+)$/m.exec(r.body) || [])[1]?.trim();
      rec.links = (r.body.match(/^\s*-\s*\[/gm) || []).length;
      const full = await get(`${origin}/llms-full.txt`, 4096);
      if (isText(full)) out.llms_full = { url: `${origin}/llms-full.txt`, bytes: full.declared || full.body.length };
    }
    if (key.startsWith("registry")) {
      Object.assign(rec, jsonSummary(r));
      // can an agent actually pull the source, or is the registry gated?
      if (rec.items && rec.first) {
        const base = r.url.replace(/\/[^/]+\.json$/, "");
        const one = await get(`${base}/${rec.first}.json`, 2048);
        rec.item_status = one.status;
        if (one.status === 200 && !isJson(one)) rec.item_status = "not-json";
      }
    }
    if (key === "skill_index") Object.assign(rec, jsonSummary(r));
    out[key] = rec;
  }
  return out;
}

if (import.meta.main) {
  const force = process.argv.includes("--force");
  const previous = loadJSON(FILE.probe, { items: {} });
  const all = loadItems();
  const items = force ? all : all.filter((i) => !previous.items?.[i.url]);
  console.log(`probing ${items.length}/${all.length} entries · concurrency ${CONCURRENCY} · timeout ${TIMEOUT}ms`);
  let done = 0;
  const results = await pool(items, CONCURRENCY, async (item) => {
    const probe = await probeItem(item);
    if (++done % 25 === 0) console.error(`  ${done}/${items.length}`);
    return [item, probe];
  });
  const map = { ...previous.items };
  for (const [item, probe] of results) {
    item.probe = probe;
    map[item.url] = probe;
  }
  saveJSON(FILE.probe, { generated_at: new Date().toISOString(), items: map });
  for (const item of all) if (map[item.url]) item.probe = map[item.url];

  const hits = (k) => all.filter((i) => i.probe?.[k]).length;
  console.log(
    `llms.txt:${hits("llms")} llms-full:${hits("llms_full")} registry:${hits("registry") + hits("registry_index") + hits("registry_root")} skill-index:${hits("skill_index")} readme:${hits("readme")} sitemap:${hits("sitemap")}`,
  );
  const catalog = render(all);
  console.log(`probe.json + re-rendered ROUTER.md (${catalog.stats.items} items)`);
}

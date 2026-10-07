#!/usr/bin/env bun
// Adapter 5 — 21st.dev component metadata (briefs/phase-6/03-21st-dev.md).
// 21st.dev server-renders every component page's metadata, so one GET per page yields the title
// and description we need. Only those two fields are kept — never the HTML, never component code,
// and /r/ + /api/ (Disallow in robots.txt) are never requested.
//
//   bun tools/api-21st.mjs --fetch [--limit=N] [--refresh]  component pages → corpus/sites/21st.dev/components.json
//   bun tools/api-21st.mjs --categories [--limit=N]          tag pages → corpus/sites/21st.dev/categories.json
//   bun tools/api-21st.mjs --stats                           read components.json and print the numbers
//   bun tools/api-21st.mjs --robots                          print the robots.txt verdict only
//
// Access is gated: installing a component needs the user's own 21st.dev key, which this adapter never uses.
import { join } from "node:path";
import { FILE, loadJSON, saveJSON, slug } from "./lib.mjs";
import { tagItem, loadTagOverrides } from "./tag.mjs";

export const DOMAIN = "21st.dev";
export const SITE = join(FILE.corpus, "sites", DOMAIN);
export const COMPONENTS_FILE = join(SITE, "components.json");
export const CATEGORIES_FILE = join(SITE, "categories.json");
export const SITEMAP_FILE = join(SITE, "sitemap.json"); // written by the sitemap producer; read when present
export const SITEMAP_URL = `https://${DOMAIN}/sitemap.xml`;
export const ROBOTS_URL = `https://${DOMAIN}/robots.txt`;
export const UA = "Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)";
const RATE_MS = 550; // ≤ 2 requests/s
const SAVE_EVERY = 200;
const TIMEOUT_MS = 30_000;
const NOT_FOUND = /^component not found\b/i;

const collapse = (s) => String(s).replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();

// ---------------------------------------------------------------- parsing (pure)

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };

/** HTML entities (named, decimal, hex) → text; unknown entities stay as written. */
export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** "Earth Blaze | Community Components | 21st" → "Earth Blaze"; a title with no suffix is kept as is. */
export function stripTitleSuffix(title) {
  const parts = collapse(title).split("|").map((s) => collapse(s));
  if (/^21st(\.dev)?$/i.test(parts[parts.length - 1] || "")) parts.pop();
  if (/^(community )?components$/i.test(parts[parts.length - 1] || "")) parts.pop();
  return parts.filter(Boolean).join(" | ");
}

// content="…" is the last attribute in 21st's markup; the tag ends with `/>` or `>`.
const metaRe = (name) =>
  new RegExp(`<meta[^>]*?(?:name|property)\\s*=\\s*["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*?content\\s*=\\s*["']([\\s\\S]*?)["']\\s*/?>|<meta[^>]*?content\\s*=\\s*["']([\\s\\S]*?)["'][^>]*?(?:name|property)\\s*=\\s*["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "i");

const metaOf = (html, names) => {
  for (const n of names) {
    const m = metaRe(n).exec(html);
    if (m) {
      const v = collapse(decodeEntities(m[1] ?? m[2] ?? ""));
      if (v) return v;
    }
  }
  return "";
};

/**
 * The only thing an adapter stores from a component page: its title and description.
 * `<title>`/`<meta name="description">` first, `og:` (then `twitter:`) as fallback; null when the
 * page carries neither.
 */
export function parsePage(html) {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = t ? stripTitleSuffix(decodeEntities(t[1])) : "";
  const description = metaOf(html, ["description", "og:description", "twitter:description"]);
  const ogTitle = title || stripTitleSuffix(metaOf(html, ["og:title", "twitter:title"]));
  if (!ogTitle && !description) return null;
  return { title: ogTitle, description };
}

// ---------------------------------------------------------------- robots.txt (pure matcher)

export function robotsGroups(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const i = line.indexOf(":");
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === "user-agent") {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      if (cur && value) cur.rules.push({ allow: field === "allow", path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

const ruleRe = (p) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));

/** Longest matching rule wins; Allow wins a tie. */
export function robotsCheck(text, path, ua = UA) {
  const u = ua.toLowerCase();
  const groups = robotsGroups(text);
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && u.includes(a)));
  const picked = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  let best = null;
  for (const g of picked)
    for (const r of g.rules) {
      const re = ruleRe(r.path);
      const target = r.path.endsWith("$") ? path.replace(/\/$/, "") : path;
      if (!re.test(target)) continue;
      const len = r.path.replace(/\$$/, "").length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow, rule: r.path };
    }
  return { allowed: best ? best.allow : true, rule: best?.rule ?? null, agents: picked.flatMap((g) => g.agents) };
}

// ---------------------------------------------------------------- sitemap → urls (pure)

const COMPONENT_PATH = /^(?:https?:\/\/(?:www\.)?21st\.dev)?\/@([^/?#]+)\/components\/([^/?#]+)\/?$/;
const TAG_PATH = /^(?:https?:\/\/(?:www\.)?21st\.dev)?\/community\/components\/s\/([^/?#]+)\/?$/;

/** Sitemap `<loc>` values (or objects with .loc) → the component pages, deduped, URL case preserved. */
export function componentUrls(locs) {
  const out = [];
  const seen = new Set();
  for (const x of locs) {
    const raw = typeof x === "string" ? x : x?.loc;
    const loc = typeof raw === "string" ? raw.trim().split(/[?#]/)[0] : null;
    const m = loc ? COMPONENT_PATH.exec(loc) : null;
    if (!m) continue;
    const key = `${m[1]}/${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ author: m[1], name: m[2], key, url: `https://${DOMAIN}/@${m[1]}/components/${m[2]}` });
  }
  return out;
}

export const tagSlugs = (locs) => {
  const out = new Set();
  for (const x of locs) {
    const raw = typeof x === "string" ? x : x?.loc;
    const loc = typeof raw === "string" ? raw.trim().split(/[?#]/)[0] : null;
    const m = loc ? TAG_PATH.exec(loc) : null;
    if (m) out.add(m[1]);
  }
  return [...out].sort();
};

/** `/@author/components/name` hrefs of a category page → ["author/name", …] in page order. */
export function tagPageKeys(html) {
  const out = [];
  const seen = new Set();
  for (const m of String(html).matchAll(/href="\/@([^/"?]+)\/components\/([^/"?#]+)/g)) {
    const key = `${decodeEntities(m[1])}/${decodeEntities(m[2])}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// ---------------------------------------------------------------- fetching

let lastReq = 0;
async function get(url) {
  const wait = RATE_MS - (Date.now() - lastReq);
  if (wait > 0) await sleep(wait);
  lastReq = Date.now();
  return fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Reads only as far as the metadata: the page is ~150–430 KB and the head sits ~144 KB in. */
async function readMetaHtml(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let html = "";
  try {
    while (html.length < 512 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      const t = html.indexOf("</title>");
      if (t < 0) continue;
      if (/<meta[^>]*(?:name|property)=["'](?:description|og:description|twitter:description)["']/i.test(html.slice(t))) break;
      if (html.length - t > 8192) break; // no description next to the title
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return html;
}

const retryAfterMs = (res) => {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
};

/** Timeouts and dropped connections come back as a short string; status 0 means "no HTTP answer". */
export const errName = (e) => (/timeout|abort/i.test(e?.name || "") ? "timeout" : String(e?.message || e || "error").slice(0, 120));

/** One component page → { status, title, description }. 200 + a "Component Not Found" page = 404. */
export async function fetchPage(url, { request = get } = {}) {
  try {
    const res = await request(url);
    if (res.status !== 200) {
      await res.body?.cancel?.().catch(() => {});
      return { status: res.status, title: "", description: "", retryAfterMs: retryAfterMs(res) };
    }
    const page = parsePage(await readMetaHtml(res));
    if (!page || NOT_FOUND.test(page.title)) return { status: 404, title: "", description: "" };
    return { status: 200, title: page.title, description: page.description };
  } catch (e) {
    // A timeout or a dropped connection while reading the body must not end the run.
    return { status: 0, title: "", description: "", error: errName(e) };
  }
}

export const RETRIABLE = (status) => status === 0 || status === 429 || status >= 500;

/** Same never-throw contract as fetchPage, for pages we need as text (category listings). */
export async function getText(url, { request = get } = {}) {
  try {
    const res = await request(url);
    if (res.status !== 200) {
      await res.body?.cancel?.().catch(() => {});
      return { status: res.status, text: "", retryAfterMs: retryAfterMs(res) };
    }
    return { status: 200, text: await res.text() };
  } catch (e) {
    return { status: 0, text: "", error: errName(e) };
  }
}

/** fetchPage with a bounded retry: 3 attempts, Retry-After or 2s/4s backoff, then the last result. */
export async function fetchComponent({ url }, { request = get, backoff = sleep } = {}) {
  let last = { status: 0, title: "", description: "", error: "no attempt" };
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await fetchPage(url, { request });
    if (!RETRIABLE(last.status)) return last;
    if (last.retryAfterMs != null && last.retryAfterMs > 60_000) return { ...last, abandon: true }; // server asked us to stay away for long
    if (attempt < 2) await backoff(last.retryAfterMs ?? Math.min(2000 * 2 ** attempt, 15_000));
  }
  return last;
}

const sitemapLocs = async () => {
  const cached = loadJSON(SITEMAP_FILE);
  const locs = (cached?.urls || []).map((u) => u?.loc).filter((l) => typeof l === "string");
  if (locs.length) return { locs, source: SITEMAP_FILE.replace(FILE.corpus + "/", "corpus/") };
  const res = await fetch(SITEMAP_URL, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`sitemap: HTTP ${res.status}`);
  const xml = await res.text();
  return { locs: [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]), source: SITEMAP_URL };
};

async function robotsGate(paths) {
  const res = await fetch(ROBOTS_URL, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return { ok: false, note: `robots.txt HTTP ${res.status} — refusing to crawl` };
  const text = await res.text();
  const checks = paths.map((p) => [p, robotsCheck(text, p)]);
  const bad = checks.filter(([, c]) => !c.allowed);
  return { ok: bad.length === 0, checks, note: bad.length ? `disallowed for our UA: ${bad.map(([p, c]) => `${p} (${c.rule})`).join(", ")}` : "component pages allowed" };
}

// ---------------------------------------------------------------- fetch runs

export async function fetchComponents({ limit = Infinity, refresh = false } = {}) {
  const t0 = Date.now();
  const gate = await robotsGate(["/@example/components/example"]);
  if (!gate.ok) {
    console.error(`robots.txt: ${gate.note}\nstopping without fetching.`);
    process.exitCode = 1;
    return null;
  }
  console.log(`robots.txt: ${gate.note}`);
  const { locs, source } = await sitemapLocs();
  const comps = componentUrls(locs);
  console.log(`sitemap (${source}): ${locs.length} urls → ${comps.length} component pages`);
  const data = refresh ? { items: {} } : (loadJSON(COMPONENTS_FILE) ?? { items: {} });
  data.items ??= {};
  const had = Object.keys(data.items).length;
  const byStatus = {};
  let fetched = 0;
  let skipped = 0;
  let sinceSave = 0;
  let consec = 0;
  let stop = null;
  for (const c of comps) {
    if (fetched >= limit) break;
    const prev = data.items[c.key];
    if (!refresh && prev && prev.status !== 0) { // status 0 = no HTTP answer (timeout/connection) → worth retrying
      skipped++;
      continue;
    }
    let rec;
    try {
      rec = await fetchComponent(c);
    } catch (e) {
      rec = { status: 0, title: "", description: "", error: errName(e) }; // one page never ends the run
    }
    if (rec.abandon) {
      stop = `server sent Retry-After > 60s at ${c.url}`;
      break;
    }
    const status = rec.status;
    byStatus[status] = (byStatus[status] || 0) + 1;
    data.items[c.key] = { title: rec.title, description: rec.description, status, ...(rec.error ? { error: rec.error } : {}), fetched_at: iso() };
    fetched++;
    consec = RETRIABLE(status) ? consec + 1 : 0;
    if (consec >= 10) {
      stop = `10 consecutive failures (last ${status} at ${c.url})`;
      break;
    }
    sinceSave++;
    if (sinceSave >= SAVE_EVERY) {
      sinceSave = 0;
      data.fetched_at = iso();
      saveJSON(COMPONENTS_FILE, data);
    }
    if (fetched % 50 === 0) {
      const mins = (Date.now() - t0) / 60000;
      console.log(`[${fetched}] ok ${byStatus[200] || 0} · failed ${Object.entries(byStatus).filter(([s]) => s !== "200").map(([s, n]) => `${s}=${n}`).join(" ") || "none"} · ${mins.toFixed(1)}m · ${(fetched / mins).toFixed(1)}/min`);
    }
  }
  data.fetched_at = iso();
  saveJSON(COMPONENTS_FILE, data);
  const failed = Object.entries(byStatus).filter(([s]) => s !== "200").sort((a, b) => b[1] - a[1]);
  const mins = (Date.now() - t0) / 60000;
  console.log(`components.json: ${Object.keys(data.items).length} keys (+${fetched} fetched, ${skipped} already present of ${had})`);
  console.log(`statuses this run: ${failed.length ? failed.map(([s, n]) => `${s}=${n}`).join(" ") : "all 200"} · ok ${byStatus[200] || 0}`);
  console.log(`elapsed ${mins.toFixed(1)}m · ${stop ? `STOPPED: ${stop}` : "finished"}`);
  return { fetched, skipped, byStatus, stop, minutes: mins };
}

/** Category pages are server-rendered for the first page only (pagination is client-side + /api/, off limits). */
export async function fetchCategories({ limit = Infinity, refresh = false } = {}) {
  const t0 = Date.now();
  const gate = await robotsGate(["/community/components/s/hero"]);
  if (!gate.ok) {
    console.error(`robots.txt: ${gate.note}\nstopping without fetching.`);
    process.exitCode = 1;
    return null;
  }
  const { locs, source } = await sitemapLocs();
  const all = tagSlugs(locs);
  const ov = loadTagOverrides();
  const tags = all.filter((t) => tagItem({ reg: DOMAIN, name: t, title: "", type: "" }, { overrides: ov }).elements.length);
  console.log(`tags: ${all.length} in the sitemap (${source}) · ${tags.length} map to a taxonomy element · ${all.length - tags.length} skipped (no element, nothing to tag)`);
  const out = refresh ? {} : (loadJSON(CATEGORIES_FILE) ?? {});
  let done = 0;
  let failed = 0;
  let sinceSave = 0;
  let consec = 0;
  let stop = null;
  for (const tag of tags) {
    if (done >= limit) break;
    if (!refresh && out[tag]) continue;
    const url = `https://${DOMAIN}/community/components/s/${tag}`;
    let got = await getText(url);
    if (RETRIABLE(got.status)) got = await getText(url); // one retry; a timeout must not end the run
    if (got.status !== 200) {
      failed++;
      consec = RETRIABLE(got.status) ? consec + 1 : 0;
      console.log(`[skip] ${tag}: ${got.status}${got.error ? ` ${got.error}` : ""}`);
      if (consec >= 10) {
        stop = `10 consecutive failures (last ${got.status} at ${tag})`;
        break;
      }
      continue;
    }
    consec = 0;
    out[tag] = tagPageKeys(got.text);
    done++;
    sinceSave++;
    console.log(`[${done}] ${tag}: ${out[tag].length} components · ${((Date.now() - t0) / 60000).toFixed(1)}m`);
    if (sinceSave >= 20) {
      sinceSave = 0;
      saveJSON(CATEGORIES_FILE, out);
    }
  }
  saveJSON(CATEGORIES_FILE, out);
  console.log(`categories.json: ${Object.keys(out).length} tags (+${done}, ${failed} failed) · elapsed ${((Date.now() - t0) / 60000).toFixed(1)}m · ${stop ? `STOPPED: ${stop}` : "finished"}`);
  return out;
}

// ---------------------------------------------------------------- adapter

const mergeTags = (into, from) => {
  for (const [el, vs] of Object.entries(from.variants || {})) into.variants[el] = [...new Set([...(into.variants[el] || []), ...vs])];
  for (const e of from.elements) if (!into.elements.includes(e)) into.elements.push(e);
};

/**
 * 21st.dev items: one per component page that answered 200 with a title. `data`/`categories` are
 * injection points for tests; in the pipeline both come from the corpus files.
 */
export function apiItems(domain, parent, { overrides, taken, data, categories } = {}) {
  if (domain !== DOMAIN) return [];
  const store = data ?? loadJSON(COMPONENTS_FILE);
  if (!store?.items) return [];
  const cats = categories ?? loadJSON(CATEGORIES_FILE, {});
  const ov = overrides ?? loadTagOverrides();
  const tagsOf = new Map();
  for (const [tag, keys] of Object.entries(cats || {}))
    for (const key of keys || []) {
      const list = tagsOf.get(key);
      if (list) list.push(tag);
      else tagsOf.set(key, [tag]);
    }
  const out = [];
  const seen = new Set();
  for (const [key, rec] of Object.entries(store.items)) {
    if (rec?.status !== 200 || !rec.title) continue;
    const slash = key.indexOf("/");
    const author = key.slice(0, slash);
    const name = key.slice(slash + 1);
    if (slash < 1 || !name) continue;
    const id = `${parent.id}/${slug(`${author}-${name}`)}`;
    if (seen.has(id) || taken?.has(id)) continue;
    seen.add(id);
    const tags = { elements: [], variants: {} };
    mergeTags(tags, tagItem({ reg: domain, name, title: rec.title, type: "" }, { overrides: ov }));
    for (const tag of tagsOf.get(key) || []) mergeTags(tags, tagItem({ reg: domain, name: tag, title: "", type: "" }, { overrides: ov }));
    const elements = tags.elements;
    const variants = {};
    for (const el of elements) {
      const vs = tags.variants[el];
      if (vs?.length) variants[el] = [...vs].sort();
    }
    out.push({
      id,
      parent: parent.id,
      name: rec.title,
      url: `https://${DOMAIN}/@${author}/components/${name}`,
      ...(rec.description ? { description: collapse(rec.description) } : {}),
      author,
      elements,
      variants,
      access: "gated",
      granularity: "variant",
      from: "api",
    });
  }
  return out;
}

// ---------------------------------------------------------------- stats

export function stats() {
  const data = loadJSON(COMPONENTS_FILE, { items: {} });
  const keys = Object.entries(data.items || {});
  const byStatus = {};
  for (const [, r] of keys) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const items = apiItems(DOMAIN, { id: "21st-dev" }, {});
  const counts = new Map();
  for (const i of items) for (const e of i.elements) counts.set(e, (counts.get(e) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`components.json fetched_at ${data.fetched_at} · ${keys.length} keys`);
  console.log(`status: ${Object.entries(byStatus).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}=${n}`).join(" ")}`);
  console.log(`items: ${items.length} · with ≥1 element ${items.filter((i) => i.elements.length).length} · navbar ${counts.get("navbar") || 0}`);
  console.log(`elements: ${top.slice(0, 15).map(([e, n]) => `${e}=${n}`).join(" ")}`);
  const cats = loadJSON(CATEGORIES_FILE, {});
  console.log(`categories.json: ${Object.keys(cats).length} tags · ${new Set(Object.values(cats).flat()).size} distinct components`);
  return { keys: keys.length, byStatus, items: items.length, top: Object.fromEntries(top) };
}

// ---------------------------------------------------------------- cli

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;
  const refresh = argv.includes("--refresh");
  if (argv.includes("--robots")) {
    const gate = await robotsGate(["/@example/components/example", "/community/components/s/hero"]);
    console.log(gate.checks.map(([p, c]) => `${c.allowed ? "allowed  " : "DISALLOWED"} ${p}${c.rule ? ` (rule ${c.rule})` : ""}`).join("\n"));
    console.log(gate.note);
  } else if (argv.includes("--fetch")) {
    await fetchComponents({ limit, refresh });
  } else if (argv.includes("--categories")) {
    await fetchCategories({ limit, refresh });
  } else if (argv.includes("--stats")) {
    stats();
  } else {
    console.log("usage: bun tools/api-21st.mjs --fetch [--limit=N] [--refresh] | --categories [--limit=N] | --stats | --robots");
  }
}

#!/usr/bin/env bun
// catalog/sources/*.json -> catalog.json + ROUTER.md + llms.txt (no network; probe/reach caches merge by url)
import { FILE, slug, loadJSON, saveJSON, saveText, isGitHubRepo, loadSources, normalizeUrl, urlKey, isAssetUrl } from "./lib.mjs";
import { categorize, CATEGORY_IDS, MAX_CATEGORIES } from "./categorize.mjs";
import { TAXONOMY } from "./tag.mjs";

// ---------------------------------------------------------------- rendering

/**
 * ROUTER.md / llms.txt are read whole by an agent, so they carry the curated and awesome-list
 * entries plus x-community entries vouched for by 2+ posts. The single-mention long tail stays in
 * catalog.json and stays reachable through the MCP search_resources tool.
 */
const MIN_COMMUNITY_MENTIONS = 2;
export const rendered = (items) =>
  items.filter((it) => it.origins.some((o) => o !== "x-community") || it.mentions >= MIN_COMMUNITY_MENTIONS);

const TAG = {
  registry: (url) => `\`npx shadcn@latest add ${url}\``,
  llms: (url) => `\`curl ${url.replace(/\/$/, "")}/llms.txt\``,
  repo: (url) => {
    const m = /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)/.exec(url);
    return m ? `\`git clone https://github.com/${m[1]}/${m[2]}.git\`` : url;
  },
  mcp: (url) => `MCP \`${url}\``,
};

/** Compact capability flags: what an agent can actually pull from this entry. */
export function flags(it) {
  const p = it.probe || {};
  const reg = p.registry || p.registry_index || p.registry_root;
  const f = [];
  if (reg) f.push(`registry:${reg.items ?? "?"}${reg.item_status === 401 || reg.item_status === 403 ? " (some gated)" : ""}`);
  if (p.llms_full) f.push("llms-full");
  else if (p.llms) f.push("llms.txt");
  if (p.skill || p.skill_index) f.push("skill");
  if (it.kind === "repo") f.push("repo");
  if (p.mcp || /\/mcp\b/.test(it.url)) f.push("mcp");
  // Swept by tools/prune.mjs: the MCP genuinely cannot read this one — say so instead of
  // letting an agent spend a fetch on it.
  if (it.reach && it.reach.ok === false) f.push(`unreadable:${it.reach.reason}`);
  return f.length ? ` \`${f.join(" ")}\`` : "";
}

/** Strip the boilerplate that repeated page titles add ("GitHub - o/r: ", "Name - ", "Name / "). */
export function shortDesc(it) {
  const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  let d = (it.desc || "").replace(/^GitHub - [^:]{1,60}:\s*/, "").trim();
  if (!d) return "";
  const name = key(it.name);
  const domain = key(it.domain);
  const stem = key(it.domain.split(".")[0]);
  for (const sep of [" — ", " – ", " - ", " / ", ": "]) {
    const at = d.indexOf(sep);
    if (at <= 0) continue;
    const first = key(d.slice(0, at));
    if (first && (name.startsWith(first) || first.startsWith(stem) || domain.startsWith(first) || first === name))
      d = d.slice(at + sep.length).trim();
    break;
  }
  return d.length > 100 ? d.slice(0, 97).trimEnd() + "…" : d;
}

// ROUTER.md / llms.txt sections are the taxonomy's categories, in its order; an entry sits under its first one.
const GROUPS = TAXONOMY.categories.map((c) => ({ id: c.id, title: c.label }));
const groupOf = (item) => item.categories[0];

function renderRouter(items, hidden = 0) {
  const buckets = new Map(GROUPS.map((g) => [g.id, []]));
  for (const it of items) buckets.get(groupOf(it)).push(it);
  for (const list of buckets.values()) list.sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name));

  const lines = [];
  lines.push("# Design resources — agent router");
  lines.push("");
  lines.push(
    "> Machine-first index of UI/design resources. Don't crawl these sites with a browser — use the flag on each entry. Flags: `registry:N` → `npx shadcn@latest add <site>/r/<name>.json` (N items, real source) · `llms.txt` / `llms-full` → `curl <site>/llms.txt` · `repo` → `git clone` (read `SKILL.md` then `README.md`) · `skill` → the repo ships an agent skill · `mcp` → connect the MCP server instead of scraping. Full URLs and probe details: `catalog.json`.",
  );
  lines.push("");
  lines.push("## Where to look first");
  lines.push("");
  lines.push("| Need | Go to |");
  lines.push("| --- | --- |");
  lines.push("| Drop-in React/Tailwind components with source | reactbits.dev, magicui.design, ui.aceternity.com, kokonutui.com, reui.io, beui.dev, canvasui.dev |");
  lines.push("| A navbar / hero / footer / CTA to copy | navbar.gallery, supahero.io, footer.design, cta.gallery, 404s.design |");
  lines.push("| Whole-page references for a SaaS/AI landing | saaspo.com, land-book.com, landing.love, saaslandingpage.com, a1.gallery |");
  lines.push("| Design rules that stop generic AI output | Nutlope/hallmark, obra/superpowers, styles.refero.design, pbakaus/impeccable, uirules.com, ui-skills.com |");
  lines.push("| Motion, transitions, micro-interactions | transitions.dev, 60fps.design, motion-primitives.com, kinetics.colorion.co, microkit.co, amicro.vercel.app |");
  lines.push("| Fonts / icons / color | fontshare.com, uncut.wtf, lucide-icons/lucide, hugeicons.com, ui.gradients.com |");
  lines.push("");
  lines.push("## Local prefetch");
  lines.push("");
  lines.push("`catalog/corpus/` holds what was already downloaded — check `catalog/corpus/MANIFEST.md` (one line per file) before pulling anything from the network. `corpus/sites/<domain>/` = llms.txt, registry items, extracted component source; `corpus/repos/<owner>__<repo>/` = README.md / SKILL.md.");
  lines.push("");
  if (hidden)
    lines.push(
      `> ${hidden} more entries came from X posts but were shared only once, so they are kept out of this file. They are in \`catalog.json\` and show up in the MCP \`search_resources\` tool.`,
      "",
    );

  for (const g of GROUPS) {
    const list = buckets.get(g.id);
    if (!list.length) continue;
    lines.push(`## ${g.title} · \`${g.id}\` (${list.length})`);
    lines.push("");
    for (const it of list) {
      const d = shortDesc(it);
      lines.push(`- **${it.name}**${d ? ` — ${d}` : ""} · ${it.url}${flags(it)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderLlmsTxt(items, hidden = 0) {
  const lines = [];
  lines.push("# UI / Design resources");
  lines.push("");
  lines.push(
    `> ${items.length} curated UI/design sources (components, galleries, design-instruction repos, fonts, icons) collected from X bookmarks. Each entry states what the resource is and the machine-readable way to pull it.`,
  );
  lines.push("");
  if (hidden) lines.push(`> ${hidden} further single-mention entries live in \`catalog.json\` (MCP \`search_resources\`).`, "");
  const buckets = new Map(GROUPS.map((g) => [g.id, []]));
  for (const it of items) buckets.get(groupOf(it)).push(it);
  for (const g of GROUPS) {
    const list = buckets.get(g.id);
    if (!list.length) continue;
    lines.push(`## ${g.title}`);
    lines.push("");
    for (const it of list) lines.push(`- [${it.name}](${it.url}): ${it.desc || it.domain}`);
    lines.push("");
  }
  lines.push("## Optional");
  lines.push("");
  lines.push(`- [Full catalog JSON](${FILE.catalog}): structured index with probe results`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------- main

// ---------------------------------------------------------------- names

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const GENERIC = /^(home|homepage|welcome|index|untitled|loading|official site|official website|website)$/i;
// error / placeholder titles are never names
const JUNK_SEG = /unavailable|not available|not found|^404\b|^error\b|^oops\b|access denied|just a moment/i;
const TITLE_SEP = /\s+[|·•–—\/-]\s+|\s*:\s+/;
/** A bare host / url is a placeholder, not a name. */
const isPlaceholder = (it) => {
  const n = it.name.toLowerCase().trim();
  return !n || n === it.domain || n === `www.${it.domain}` || /^https?:/.test(n) || /^[\w.-]+\.[a-z]{2,}(\/\S*)?$/.test(n);
};
/** The domain labels that can carry a brand (TLD dropped, short labels ignored): ui.shadcn.com → shadcn. */
const brandStems = (domain) => domain.split(".").slice(0, -1).filter((l) => l.length >= 3 && l !== "www").map(norm);
const matchesBrand = (seg, domain) => {
  const n = norm(seg);
  return n.length >= 3 && brandStems(domain).some((stem) => n.startsWith(stem) || stem.startsWith(n) || n.includes(stem));
};

/**
 * Real names where they are cheap and safe; everything else stays a host until a metadata record
 * (Phase 2B) names it. Precedence: source name (if not a bare host) → owner/repo → the page <title>
 * segment that is the site's own brand (sites) or the first real segment + (brand) (pages) → host.
 */
export function displayName(it) {
  if (!isPlaceholder(it)) return it.name;
  if (it.kind === "repo") {
    const m = /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)/.exec(it.url);
    if (m) return `${m[1]}/${m[2]}`;
  }
  const segs = (it.title || "")
    .split(TITLE_SEP)
    .map((x) => x.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, "").trim())
    .filter((x) => x.length >= 2 && !GENERIC.test(x) && !JUNK_SEG.test(x));
  const brand = segs.find((x) => matchesBrand(x, it.domain) && x.length <= 40);
  if (it.kind === "site") return brand || it.name;
  const first = segs.find((x) => x !== brand && x.length <= 60);
  if (it.kind === "page" && first) return `${first} (${brand || it.domain})`;
  return pathName(it, brand) || it.name;
}

/** "/p/claude-for-teams" → "Claude for teams (brand)"; null when the last path segment isn't words. */
function pathName(it, brand) {
  if (it.kind !== "page") return null;
  const last = decodeURIComponent(new URL(it.url).pathname.split("/").filter(Boolean).pop() || "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[-_+]+/g, " ")
    .trim();
  if (last.length < 3 || last.length > 60 || !/[a-z]{3}/i.test(last) || /^[\da-f]{8,}$/i.test(last.replace(/ /g, ""))) return null;
  return `${last[0].toUpperCase()}${last.slice(1)} (${brand || it.domain})`;
}

/** Name every entry; pages of one domain that end up with the same title-derived name use their path instead. */
function nameAll(items) {
  for (const it of items) it.name = displayName(it);
  const seen = new Map();
  for (const it of items) if (it.kind === "page") seen.set(`${it.domain}|${it.name}`, (seen.get(`${it.domain}|${it.name}`) || 0) + 1);
  for (const it of items) {
    if (it.kind !== "page" || seen.get(`${it.domain}|${it.name}`) < 2) continue;
    const brand = /\(([^)]+)\)$/.exec(it.name)?.[1];
    it.name = pathName(it, brand && brand !== it.domain ? brand : null) || it.name;
  }
}

/** Ids come from the url; if two entries still collide, later ones get -2, -3 … (source order is stable). */
function uniqueIds(items) {
  const used = new Map();
  for (const it of items) {
    const n = used.get(it.id) || 0;
    used.set(it.id, n + 1);
    if (n) it.id = `${it.id}-${n + 1}`;
  }
}

/**
 * catalog/overrides.json — hand fixes that survive every rebuild and metadata re-run:
 * { "schema_version": 1, "items": { "<id>": { "name": "…", "desc": "…", "categories": ["<category id>", …] } } }
 */
const OVERRIDABLE = ["name", "desc", "about", "categories"];
export const overrideStats = { applied: 0, unknown: [], badCategories: [] };
function applyOverrides(items) {
  const file = loadJSON(FILE.overrides);
  if (!file?.items) return;
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const [id, patch] of Object.entries(file.items)) {
    const it = byId.get(id);
    if (!it) {
      overrideStats.unknown.push(id);
      continue;
    }
    if (patch.categories) {
      const bad = patch.categories.filter((c) => !CATEGORY_IDS.includes(c));
      if (bad.length || !patch.categories.length || patch.categories.length > MAX_CATEGORIES) overrideStats.badCategories.push(id);
    }
    for (const k of OVERRIDABLE) if (patch[k] !== undefined) it[k] = patch[k];
    overrideStats.applied++;
  }
}

/** How the last loadItems() call categorised entries: from labels, from their text, or the default. */
export const categoryStats = { labels: 0, text: 0, default: 0, unknown: new Set() };

/** Source labels → 1–2 taxonomy category ids (tools/categorize.mjs); overrides.json is applied after. */
function categorizeAll(items) {
  for (const it of items) {
    const r = categorize(it);
    it.categories = r.categories;
    categoryStats[r.via]++;
    for (const u of r.unknown) categoryStats.unknown.add(u);
  }
}

/** Per-source counts from the last loadItems() call (printed by `bun tools/build.mjs`). */
export const loadStats = {};

export function loadItems({ clean = false } = {}) {
  const items = [];
  const byKey = new Map(); // host + path + query
  const byPage = new Map(); // host + path — only consulted by sources with merge_query_variants
  const rawUrl = new Map(); // normalized url -> url as the source wrote it (probe caches may be keyed by either)

  for (const src of loadSources()) {
    const id = src.source_id;
    const stats = (loadStats[id] = { items: src.items.length, added: 0, merged: 0, invalid: 0, asset: 0 });
    const loose = src.merge_query_variants === true;
    for (const e of src.items) {
      const url = normalizeUrl(e.url);
      if (!url) {
        stats.invalid++;
        continue;
      }
      if (isAssetUrl(url)) {
        stats.asset++;
        continue;
      }
      const cats = (e.categories || []).filter(Boolean);
      const prev = byKey.get(urlKey(url)) || (loose ? byPage.get(urlKey(url, { ignoreQuery: true })) : undefined);
      if (prev) {
        // earlier sources keep url/name/desc; later ones add what they know
        stats.merged++;
        for (const c of cats) if (!prev.categories.includes(c)) prev.categories.push(c);
        if (!prev.origins.includes(id)) prev.origins.push(id);
        if (e.mentions) prev.mentions = Math.max(prev.mentions, e.mentions);
        if (!prev.desc && e.desc) prev.desc = e.desc;
        if (!prev.about && e.about) prev.about = e.about;
        if (!prev.title && e.title) prev.title = e.title;
        if (e.labels?.length) prev.labels = [...new Set([...(prev.labels || []), ...e.labels])].slice(0, 5);
        if (!prev.note && e.note) prev.note = e.note;
        continue;
      }
      stats.added++;
      const u = new URL(url);
      const item = {
        id: slug(url),
        name: e.name || u.hostname.replace(/^www\./, ""),
        url,
        domain: u.hostname.replace(/^www\./, ""),
        kind: isGitHubRepo(url) ? "repo" : u.pathname === "/" ? "site" : "page",
        desc: e.desc || "",
        ...(e.title ? { title: e.title } : {}),
        ...(e.about ? { about: e.about } : {}),
        categories: cats,
        mentions: e.mentions ?? 1, // ranking signal only (search/ROUTER order); not shown to agents
        ...(e.labels?.length ? { labels: e.labels.slice(0, 5) } : {}),
        ...(e.note ? { note: e.note } : {}),
        ...(e.recovered_from ? { recovered_from: e.recovered_from } : {}),
        origin: id,
        origins: [id],
      };
      items.push(item);
      byKey.set(urlKey(url), item);
      if (!byPage.has(urlKey(url, { ignoreQuery: true }))) byPage.set(urlKey(url, { ignoreQuery: true }), item);
      rawUrl.set(url, String(e.url).trim().replace(/\/$/, ""));
    }
  }

  uniqueIds(items);
  nameAll(items);
  categorizeAll(items);
  applyOverrides(items);

  // Entries with no machine-readable endpoint are dropped for good — catalog/blocklist.json
  // is written by tools/prune.mjs, which tests every item the way the MCP would read it.
  // scope:"domain" drops the whole domain, scope:"url" only the dead page.
  const blocked = loadJSON(FILE.blocklist);
  const blockedUrls = new Set((blocked?.items || []).map((b) => b.url));
  const blockedDomains = new Set((blocked?.items || []).filter((b) => b.scope !== "url").map((b) => b.domain));
  if (blockedUrls.size)
    for (let i = items.length - 1; i >= 0; i--)
      if (blockedUrls.has(items[i].url) || blockedDomains.has(items[i].domain)) items.splice(i, 1);

  const prev = clean ? null : loadJSON(FILE.catalog);
  if (prev?.items) {
    const seen = new Map(prev.items.map((i) => [i.url, i]));
    for (const it of items) {
      const old = seen.get(it.url) || seen.get(rawUrl.get(it.url));
      if (old) it.probe = old.probe;
      it.corpus = old?.corpus;
    }
  }
  const probe = loadJSON(FILE.probe);
  const cached = (store, it) => store?.items?.[it.url] || store?.items?.[rawUrl.get(it.url)];
  if (probe) for (const it of items) if (cached(probe, it)) it.probe = cached(probe, it);
  const reach = loadJSON(FILE.reachability);
  if (reach) for (const it of items) if (cached(reach, it)) it.reach = cached(reach, it);
  return items;
}

export function render(items) {
  const byCategory = {};
  for (const it of items) for (const c of it.categories) byCategory[c] = (byCategory[c] || 0) + 1;
  const blocked = loadJSON(FILE.blocklist);
  const catalog = {
    generated_at: new Date().toISOString(),
    sources: loadSources().map((src) => ({ id: src.source_id, title: src.title, items: src.count ?? src.items.length, generated_at: src.generated_at })),
    stats: {
      items: items.length,
      pruned: blocked?.items?.length || 0,
      unreadable: items.filter((i) => i.reach && i.reach.ok === false).length,
      repos: items.filter((i) => i.kind === "repo").length,
      registries: items.filter((i) => i.probe?.registry || i.probe?.registry_index || i.probe?.registry_root).length,
      llms_txt: items.filter((i) => i.probe?.llms).length,
      skills: items.filter((i) => i.probe?.skill || i.probe?.skill_index).length,
      by_category: byCategory,
    },
    items,
  };
  // Same content as last time → keep its timestamp, so a rebuild leaves catalog.json byte-identical (no diff to revert).
  const previous = loadJSON(FILE.catalog);
  if (previous?.generated_at && JSON.stringify({ ...previous, generated_at: "" }) === JSON.stringify({ ...catalog, generated_at: "" }))
    catalog.generated_at = previous.generated_at;
  saveJSON(FILE.catalog, catalog);
  const shown = rendered(items);
  const hidden = items.length - shown.length;
  saveText(FILE.router, renderRouter(shown, hidden));
  saveText(FILE.llms, renderLlmsTxt(shown, hidden));
  return catalog;
}

if (import.meta.main) {
  const items = loadItems({ clean: process.argv.includes("--clean") });
  const catalog = render(items);
  console.log(
    `catalog.json  ${catalog.stats.items} items · ${catalog.stats.repos} repos · ${catalog.stats.registries} registries · ${catalog.stats.llms_txt} llms.txt`,
  );
  for (const [id, st] of Object.entries(loadStats))
    console.log(`  sources/${id}.json  ${st.items} items -> ${st.added} new · ${st.merged} merged · ${st.asset} asset · ${st.invalid} invalid`);
  console.log(`  categories  ${categoryStats.labels} from labels · ${categoryStats.text} from text · ${categoryStats.default} default (${TAXONOMY.categorize.default})`);
  if (categoryStats.unknown.size) console.log(`  ! labels no category claims (add them to from_labels in taxonomy.json): ${[...categoryStats.unknown].join(" | ")}`);
  if (overrideStats.applied || overrideStats.unknown.length)
    console.log(`  overrides.json  ${overrideStats.applied} applied${overrideStats.unknown.length ? ` · unknown ids: ${overrideStats.unknown.join(", ")}` : ""}`);
  if (overrideStats.badCategories.length)
    console.log(`  ! overrides.json categories must be 1–${MAX_CATEGORIES} ids from taxonomy.json: ${overrideStats.badCategories.join(", ")}`);
  console.log(`ROUTER.md llms.txt -> ${FILE.router.replace(/\/ROUTER\.md$/, "")}`);
  // items + search index follow the catalog, or the MCP server rebuilds them in memory on every start
  if (!process.argv.includes("--no-index")) (await import("./index.mjs")).writeIndex(catalog.items);
}

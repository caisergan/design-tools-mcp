#!/usr/bin/env bun
// Phase 2B digests (MCP-PLAN 2B pipeline step 2, no LLM): what the extraction agent reads about one catalog entry.
//
//   bun tools/crawl.mjs --id <id>[,<id>…] [--force]     these entries
//   bun tools/crawl.mjs --queue [--limit n] [--force]   the entries in catalog/metadata/_queue.json (tools/metadata-queue.mjs)
//   bun tools/crawl.mjs --pilot [--force]               the fixed list catalog/metadata/pilot.json
//   … [--report]                                        print the size / status table of the digests that exist, fetch nothing
//
// → catalog/crawl/<id>.json, one file per entry. catalog/crawl/ is gitignored: third-party text never reaches the repo.
// An entry with a digest is skipped unless --force (resume).
//
// Sources, cheapest first: the corpus (llms.txt, README.md / SKILL.md, sitemap.json, registry.json) and what the catalog
// already knows (items, probe flags) — then plain HTTP through tools/registry-urls.mjs createFetcher (≤ 2 req/s per
// host, robots.txt, a host stopped after 3× 403/429) and the Scrapling backend for hosts catalog/scrapling-hosts.json
// enables. Hosts it lists as disabled are never fetched. No headless browser: a JS-only, walled or login page ends
// `status: "blocked"` with its reason. Dead entries (reach.reason dead / repo-gone) are skipped and listed.
//
// Sites: llms.txt excerpt + homepage + up to 4 pages (docs, components, pricing, about, license) chosen from llms.txt
// links, the homepage nav / links and the corpus sitemap. Repos: README / SKILL.md (corpus, else raw.githubusercontent.com).
// Pages: the page itself. Token targets (MCP-PLAN 2B "Cost"): ≤ ~6k per site / repo digest, ≤ ~2k per page entry.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FILE, OUT, loadJSON, saveText, pool, repoParts, isAssetUrl } from "./lib.mjs";
import { createFetcher } from "./registry-urls.mjs";
import { loadHosts, scraplingClient } from "./scrapling-backend.mjs";
import { CRAWL_DIR, METADATA_DIR, digestFile, hintsOf, hintsHash, isDead } from "./metadata.mjs";

export const CRAWLER = "crawl-v1";
export const PILOT_FILE = join(METADATA_DIR, "pilot.json");
const ITEMS_DIR = join(OUT, "items");

export const LIMITS = {
  pageText: 12_000, // visible text of one page, hard cap (MCP-PLAN 2B)
  siteText: 14_000, // all visible text of one site digest (≈ 3.5k of its ~6k tokens; headings, links and hints are the rest)
  homeText: 5_500, // the homepage's share of it; extra pages share the rest
  extraText: 3_000, // one extra page at most
  llmsText: 4_000, // the llms.txt excerpt
  repoText: 16_000, // README + SKILL.md of one repo
  pageEntryText: 5_000, // a page entry (≈ 2k tokens with its headings)
  extraPages: 4,
  extraTries: 6, // candidate pages fetched at most, to find `extraPages` good ones
  linksHome: 25,
  linksOther: 8,
  headings: { h1: 3, h2: 15, h3: 12 },
  nav: 30,
  sampleItems: 15,
};

// ---------------------------------------------------------------- html → digest page (pure)

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", rarr: "→", larr: "←", times: "×", euro: "€",
  pound: "£", laquo: "«", raquo: "»", zwj: "", zwnj: "", shy: "",
};
export function decodeEntities(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, name) => {
    if (name[0] === "#") {
      const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[name.toLowerCase()] ?? m;
  });
}

const squash = (s) => decodeEntities(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const dedupe = (xs) => [...new Set(xs.filter(Boolean))];

/** Attributes of one tag's source (`<meta name="x" content="y">`) → { name: "x", content: "y" } (lowercase keys). */
export function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? "");
  return out;
}

/** <meta> name / property → content (first wins). */
export function metaOf(html) {
  const out = {};
  for (const m of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.name || a.property || a.itemprop || "").toLowerCase();
    if (key && a.content !== undefined && !(key in out)) out[key] = a.content.trim();
  }
  return out;
}

// Everything that is never page text: code (scripts and <pre> examples), styles, media, form controls, the head, comments.
const DROP_BLOCKS = /<(script|style|noscript|svg|template|head|iframe|canvas|select|textarea|button|pre)\b[\s\S]*?<\/\1\s*>/gi;
// Repeated chrome: navigation and footers (nav is kept separately), cookie / consent dialogs.
const CHROME_BLOCKS = /<(nav|footer)\b[\s\S]*?<\/\1\s*>/gi;
const CONSENT_OPEN = /<(div|section|aside|dialog)\b[^>]*(?:id|class)\s*=\s*["'][^"']*\b(cookie|consent|gdpr|cmp-)[^"']*["'][^>]*>/gi;

/** Visible text of a page, one block per line (headings, paragraphs, list items), chrome and consent banners removed. */
export function visibleText(html) {
  let h = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(DROP_BLOCKS, " ")
    .replace(CHROME_BLOCKS, " ");
  // a consent container without nested tags of its own kind is cut to its closing tag
  h = h.replace(CONSENT_OPEN, (m, tag) => `\u0000${tag}\u0000`).replace(/\u0000(div|section|aside|dialog)\u0000[\s\S]*?<\/\1\s*>/gi, " ");
  const text = h
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/?(p|div|section|article|main|aside|header|li|ul|ol|tr|td|th|table|h[1-6]|dt|dd|dl|blockquote|pre|figure|figcaption|label|summary|details)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return cleanLines(decodeEntities(text));
}

const COOKIE_LINE = /\b(cookies?)\b[^\n]{0,200}\b(use|uses|using|accept|consent|policy|preferences|settings|agree|personali[sz]e)\b|^(accept( all)?|reject( all)?|decline|manage (cookies|preferences|consent)|got it|i agree|allow all|necessary only)$/i;
const CHROME_LINE = /^(skip to (main )?content|toggle (navigation|menu|theme|sidebar)|open (main )?menu|close( menu| modal)?|menu|search|search…|search\.\.\.|loading|loading…|loading\.\.\.|back to top|scroll to top|copy|copied!?|share|open in|previous|next|previous next|⌘ ?k|ctrl ?k|sign in|log in|login|sign up|get started|thank you! your submission has been received!|oops! something went wrong while submitting the form\.?)$/i;

/** One line per block, trimmed; cookie / chrome lines out; a line that repeats in the page is kept once. */
export function cleanLines(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length < 2 || COOKIE_LINE.test(line) || CHROME_LINE.test(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.join("\n");
}

/** Same-site test that ignores `www.`. */
export const sameSite = (a, b) => {
  try {
    return new URL(a).hostname.replace(/^www\./, "").toLowerCase() === new URL(b).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return false;
  }
};

/** Internal links of a page: absolute, same site, no hash, no assets / mail / js; deduped, in page order. */
export function internalLinks(html, base) {
  const out = [];
  const seen = new Set();
  for (const m of String(html).matchAll(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const href = decodeEntities((m[2] ?? m[3] ?? m[4] ?? "").trim());
    if (!href || /^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let u;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol) || !sameSite(u.href, base)) continue;
    u.hash = "";
    const url = u.href.replace(/\/$/, "");
    if (isAssetUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, text: squash(m[5]).slice(0, 80) });
  }
  return out;
}

/** Link texts inside <nav> (else <header>), deduped. */
export function navTexts(html) {
  const blocks = [...String(html).matchAll(/<nav\b[\s\S]*?<\/nav\s*>/gi)].map((m) => m[0]);
  if (!blocks.length) blocks.push(...[...String(html).matchAll(/<header\b[\s\S]*?<\/header\s*>/gi)].map((m) => m[0]));
  const texts = blocks.flatMap((b) => [...b.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)].map((m) => squash(m[1])));
  return dedupe(texts.filter((t) => t.length >= 2 && t.length <= 40));
}

/** h1–h3 texts, deduped, capped. */
export function headingsOf(html, caps = LIMITS.headings) {
  const out = { h1: [], h2: [], h3: [] };
  for (const m of String(html).replace(DROP_BLOCKS, " ").matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) {
    const t = clip(squash(m[2]), 100);
    const list = out[`h${m[1]}`];
    if (t && !list.includes(t) && list.length < caps[`h${m[1]}`]) list.push(t);
  }
  return out;
}

/** One HTML page → the digest fields (text uncapped; the digest budget caps it). */
export function extractHtml(html, url) {
  const meta = metaOf(html);
  const title = squash(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] || "");
  return {
    title: clip(title, 200),
    description: clip(meta.description || meta["og:description"] || meta["twitter:description"] || "", 400),
    og_image: meta["og:image"] || meta["twitter:image"] || null,
    headings: headingsOf(html),
    nav: navTexts(html).slice(0, LIMITS.nav),
    text: visibleText(html),
    links: internalLinks(html, url),
  };
}

/** Markdown (llms.txt, README, a docs .md) → the same fields: # headings, text without images / badges / html. */
export function extractMarkdown(md, url) {
  const src = String(md || "").replace(/\r\n/g, "\n");
  const headings = { h1: [], h2: [], h3: [] };
  for (const m of src.matchAll(/^(#{1,3})\s+(.+?)\s*#*\s*$/gm)) {
    const list = headings[`h${m[1].length}`];
    const t = clip(m[2].replace(/[*_`]/g, "").trim(), 100);
    if (t && !list.includes(t) && list.length < LIMITS.headings[`h${m[1].length}`]) list.push(t);
  }
  const links = [];
  for (const m of src.matchAll(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g)) {
    let u;
    try {
      u = new URL(m[2], url);
    } catch {
      continue;
    }
    u.hash = "";
    if (/^https?:$/.test(u.protocol) && sameSite(u.href, url) && !isAssetUrl(u.href)) links.push({ url: u.href.replace(/\/$/, ""), text: squash(m[1]).slice(0, 80) });
  }
  const text = src
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ") // code blocks: install commands and examples are not what the resource is
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images and badges
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, " ")
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "- ")
    .replace(/[*_`]{1,3}/g, "");
  return {
    title: headings.h1[0] || "",
    description: "",
    og_image: null,
    headings,
    nav: [],
    text: cleanLines(decodeEntities(text)),
    links: links.filter((l, i) => links.findIndex((x) => x.url === l.url) === i),
  };
}

const isHtml = (type) => /\b(text\/html|application\/xhtml\+xml)\b/i.test(type || "");

/**
 * Why a fetched page is not readable without a browser, or null: an error / wall status, a challenge or
 * login page, or a JavaScript shell with (almost) no text of its own.
 */
export function blockReason(res, page, html = "") {
  if (res.error === "robots") return "robots.txt disallows it";
  if (/robots\.txt unreadable \(http (403|429)\)/.test(res.error || "")) return `bot-wall (${res.error})`;
  if (/^redirected to a disabled host/.test(res.error || "")) return res.error;
  if (res.error) return `network: ${res.error}`;
  if (res.status === 202 && (page?.text || "").length < 200) return "bot-wall (http 202 challenge)";
  if (res.status === 403 || res.status === 429 || res.status === 503) {
    return /cloudflare|cf-chl|just a moment|captcha|attention required/i.test(html) ? `bot-wall (http ${res.status})` : `http ${res.status}`;
  }
  if (res.status !== 200) return `http ${res.status}`;
  const title = page?.title || "";
  if (/just a moment|attention required|access denied|verify you are human|are you a robot|captcha|ddos protection/i.test(title)) return "bot-wall (challenge page)";
  let path = "";
  try {
    path = new URL(res.finalUrl || "").pathname;
  } catch {
    /* no final url */
  }
  if (/\/(login|log-in|signin|sign-in|auth|sso)(\/|$)/i.test(path)) return "login-required (redirects to a login page)";
  const words = (page?.text || "").split(/\s+/).filter(Boolean).length;
  if (words < 25 && !(page?.description || "").length && /id=["'](root|__next|app|__nuxt|svelte)["']|<noscript|enable javascript|requires javascript/i.test(html))
    return "js-only (the page renders its content with JavaScript)";
  if (words < 8 && !(page?.description || "") && !(page?.headings?.h1 || []).length) return "empty page";
  return null;
}

const JS_APP = /id=["'](root|__next|app|__nuxt|svelte)["']|self\.__next_f|__NEXT_DATA__|window\.__NUXT__|data-reactroot|<astro-island/i;
/** A readable page of a JavaScript app that shows little more than its title and meta description, or null. */
export function thinReason(page, html = "") {
  const words = (page?.text || "").split(/\s+/).filter(Boolean).length;
  const scripts = (String(html).match(/<script\b[^>]*\bsrc=/gi) || []).length;
  return words < 40 && (JS_APP.test(html) || scripts >= 3) ? `only title and meta description readable (${words} words of page text; JavaScript renders the rest)` : null;
}

// ---------------------------------------------------------------- choosing the extra pages (pure)

const BUCKETS = [
  ["docs", /^(docs?|documentation|guides?|getting-started|get-started|introduction|intro|quick-?start|installation|install|overview|reference)$/],
  ["components", /^(components?|blocks?|library|ui|elements|widgets|sections|templates?|examples?|showcase|gallery|browse|explore|collections?|categories|category|icons|fonts|typefaces|kits?|patterns|effects|animations|backgrounds|skills|presets|themes)$/],
  ["pricing", /^(pricing|plans|prices?|purchase|buy|pro|premium|all-access|lifetime)$/],
  ["about", /^(about|about-us|faq|faqs|features|why)$/],
  ["license", /^(license|licen[cs]ing|licen[cs]e-agreement|usage-rights)$/],
];
const SKIP_PATH = /^\/(blog|posts?|news|changelog|login|log-in|signin|sign-in|signup|sign-up|register|auth|account|cart|checkout|privacy|cookies?|terms|legal|careers|jobs|press|contact|tag|tags|author|search|feed|rss)(\/|$)|^\/[a-z]{2}(-[a-z]{2,4})?(\/|$)(?!.*(docs|components))/i;
const SOURCE_BONUS = { llms: 3, nav: 2, home: 1, sitemap: 0 };

/** Which bucket a url's first path segment names (/docs, /components, /pricing …), or null; deeper than 3 segments: null. */
export function bucketOf(url) {
  let segs;
  try {
    segs = new URL(url).pathname.split("/").filter(Boolean).map((s) => s.toLowerCase().replace(/\.(html?|md|mdx)$/, ""));
  } catch {
    return null;
  }
  if (!segs.length || segs.length > 3) return null;
  for (const [name, re] of BUCKETS) if (re.test(segs[0])) return name;
  return null;
}

/**
 * Up to `max` extra pages: one per bucket in order (docs, components, pricing, about, license), then the best of the
 * rest. candidates = [{ url, from: "llms" | "nav" | "home" | "sitemap" }]; shorter paths and better sources win.
 */
export function pickExtraPages(home, candidates, { max = LIMITS.extraPages } = {}) {
  const homeKey = String(home).replace(/\/$/, "");
  const best = new Map(); // url → candidate with its score
  for (const c of candidates) {
    const url = String(c.url).replace(/\/$/, "");
    if (url === homeKey || !sameSite(url, home)) continue;
    let u;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (u.search || SKIP_PATH.test(u.pathname) || isAssetUrl(url)) continue;
    const bucket = bucketOf(url);
    if (!bucket) continue;
    const depth = u.pathname.split("/").filter(Boolean).length;
    // an index page (/docs, /components) says more about a site than one component's page: depth costs more than a source earns
    const s = (SOURCE_BONUS[c.from] ?? 0) - 2 * depth - u.pathname.length / 100;
    const prev = best.get(url);
    if (!prev || s > prev.score) best.set(url, { url, bucket, score: s });
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  const out = [];
  for (const [name] of BUCKETS) {
    const c = ranked.find((x) => x.bucket === name && !out.includes(x));
    if (c && out.length < max) out.push(c);
  }
  // then more docs / components pages, shallow ones only (an index page says more than one component's page)
  for (const c of ranked) if (out.length < max && !out.includes(c) && (c.bucket === "docs" || c.bucket === "components") && new URL(c.url).pathname.split("/").filter(Boolean).length <= 2) out.push(c);
  return out.map((c) => ({ url: c.url, bucket: c.bucket }));
}

// ---------------------------------------------------------------- budget + boilerplate across pages (pure)

/**
 * Lines a later page repeats from an earlier one (shared headers, sidebars, footers, CTAs) are dropped, nav texts are kept where
 * they first appear, then each page's text is cut to its share of `budget`: the first pages get at most `heads[i]`
 * (llms.txt excerpt, homepage), the others share what is left evenly (≤ `restCap` each), a short page passing its
 * unused share on; no page keeps more than `cap`. Mutates and returns `pages`.
 */
export function trimPages(pages, { budget = LIMITS.siteText, heads = [LIMITS.homeText], cap = LIMITS.pageText, restCap = LIMITS.extraText } = {}) {
  const seen = new Set();
  const navSeen = new Set();
  for (const p of pages) {
    const lines = (p.text || "").split("\n").filter(Boolean);
    p.text = lines.filter((l) => !seen.has(l.toLowerCase())).join("\n");
    for (const l of lines) seen.add(l.toLowerCase());
    if (p.nav) {
      p.nav = p.nav.filter((t) => !navSeen.has(t.toLowerCase()));
      for (const t of p.nav) navSeen.add(t.toLowerCase());
      if (!p.nav.length) delete p.nav;
    }
  }
  const want = pages.map((p, i) => Math.min(cap, i < heads.length ? Infinity : restCap, (p.text || "").length));
  const shares = pages.map(() => 0);
  let left = budget;
  pages.forEach((_, i) => {
    if (i < heads.length) {
      shares[i] = Math.min(want[i], heads[i], Math.max(0, left));
      left -= shares[i];
    }
  });
  let rest = pages.map((_, i) => i).filter((i) => i >= heads.length && want[i] > 0);
  while (rest.length && left > 0) {
    const even = Math.max(1, Math.floor(left / rest.length));
    const next = [];
    for (const i of rest) {
      const give = Math.min(want[i] - shares[i], even, left);
      shares[i] += give;
      left -= give;
      if (want[i] > shares[i]) next.push(i);
    }
    if (next.length === rest.length && left <= 0) break;
    rest = next;
  }
  pages.forEach((p, i) => {
    if ((p.text || "").length > shares[i]) p.text = cutText(p.text, shares[i]);
  });
  return pages;
}

/** Cut at a line end when one is near, mark the cut. */
export function cutText(text, n) {
  if (text.length <= n) return text;
  if (n <= 0) return "";
  const at = text.lastIndexOf("\n", n);
  const end = at > n * 0.7 ? at : n;
  return text.slice(0, end).trimEnd() + "\n[…cut]";
}

/** Rough token count of what the extractor reads (≈ 4 chars a token for English text and JSON). */
export const estimateTokens = (s) => Math.ceil(String(s).length / 4);

/** The digest as written (1-space JSON: the extractor reads the file whole). */
export const serialize = (d) => JSON.stringify(d, null, 1) + "\n";

// ---------------------------------------------------------------- what the catalog already knows

/** Item counts, the most common item elements and a few item names (ours, not third-party claims). */
export function knownOf(entry, { itemsDir = ITEMS_DIR, corpusDir = FILE.corpus, siteOf = () => null } = {}) {
  const k = {};
  const f = join(itemsDir, `${entry.id}.json`);
  if (existsSync(f)) {
    const items = loadJSON(f)?.items || [];
    const n = { code: 0, gated: 0, gallery_examples: 0, docs_pages: 0 };
    const els = new Map();
    for (const i of items) {
      if (i.granularity === "example" && i.access === "page") n.gallery_examples++;
      else if (i.access === "page") n.docs_pages++;
      else if (i.access === "gated") n.gated++;
      else n.code++;
      for (const el of i.elements || []) els.set(el, (els.get(el) || 0) + 1);
    }
    k.items = Object.fromEntries(Object.entries(n).filter(([, v]) => v));
    k.item_elements = [...els].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([el, c]) => `${el} ${c}`);
    const pickNames = [];
    const step = Math.max(1, Math.floor(items.length / LIMITS.sampleItems));
    for (let i = 0; i < items.length && pickNames.length < LIMITS.sampleItems; i += step) pickNames.push(clip(items[i].name, 60));
    if (pickNames.length) k.sample_items = pickNames;
  }
  const p = entry.probe || {};
  const reg = p.registry || p.registry_index || p.registry_root;
  if (reg) k.shadcn_registry = { items: reg.items ?? null };
  if (p.llms) k.llms_txt = true;
  if (p.llms_full) k.llms_full = true;
  if (p.skill || p.skill_index) k.agent_skill = true;
  if (p.mcp) k.mcp_server = true;
  const sm = entry.kind !== "repo" ? join(corpusDir, "sites", entry.domain, "sitemap.json") : null;
  if (sm && existsSync(sm)) {
    try {
      k.sitemap_urls = loadJSON(sm)?.urls?.length || 0;
    } catch {
      /* unreadable sitemap: say nothing */
    }
  }
  const parent = entry.kind === "page" ? siteOf(entry.domain) : null;
  if (parent) k.parent = { id: parent.id, name: parent.name, url: parent.url };
  return k;
}

// ---------------------------------------------------------------- network

/** Corpus text file (llms.txt, README.md …) or null. */
function corpusText(...parts) {
  const f = join(FILE.corpus, ...parts);
  if (!existsSync(f)) return null;
  try {
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
}

/**
 * A host catalog/scrapling-hosts.json lists with `enabled: false` (an open owner decision: never fetched), or one of
 * its subdomains (shop.ui8.net is ui8.net) → its note, else null.
 */
export function disabledHost(url, hosts) {
  let h;
  try {
    h = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  for (const [host, e] of hosts) if (!e.enabled && (h === host || h.endsWith(`.${host}`))) return e.note || "disabled";
  return null;
}

/**
 * Fetch one url through the paced, robots-respecting fetcher → { res, page, html } (page null when unreadable).
 * A redirect that ends on a disabled host is dropped unread (the redirect is followed by fetch itself).
 */
async function fetchPage(url, fetcher, hosts = new Map()) {
  const ok = await fetcher.allowed(url);
  if (ok === "retry") {
    const host = new URL(url).host;
    const why = fetcher.stopped().find((x) => x.startsWith(`${host}: `))?.slice(host.length + 2) || "robots.txt unreadable";
    return { res: { status: 0, error: why, finalUrl: url }, page: null, html: "" };
  }
  if (!ok) return { res: { status: 0, error: "robots", finalUrl: url }, page: null, html: "" };
  const res = await fetcher.request(url);
  const off = res.finalUrl ? disabledHost(res.finalUrl, hosts) : null;
  if (off) return { res: { status: 0, error: `redirected to a disabled host (${new URL(res.finalUrl).hostname}: ${off})`, finalUrl: res.finalUrl }, page: null, html: "" };
  const body = res.text || "";
  let page = null;
  if (res.status === 200 && body) page = isHtml(res.type) || /^\s*<(!doctype|html)/i.test(body) ? extractHtml(body, res.finalUrl || url) : extractMarkdown(body, res.finalUrl || url);
  return { res, page, html: isHtml(res.type) ? body : "" };
}

const digestPage = (url, source, page, res) => {
  const out = { url, source };
  if (res) {
    out.status = res.status ?? null;
    if (res.finalUrl && res.finalUrl.replace(/\/$/, "") !== url.replace(/\/$/, "")) out.final_url = res.finalUrl;
  }
  if (page.title) out.title = page.title;
  if (page.description) out.description = page.description;
  if (page.og_image) out.og_image = page.og_image;
  const h = Object.fromEntries(Object.entries(page.headings || {}).filter(([, v]) => v.length));
  if (Object.keys(h).length) out.headings = h;
  if (page.nav?.length) out.nav = page.nav;
  out.text = page.text || "";
  out.links = page.links || [];
  return out;
};

/** Internal links as paths (shorter to read), capped. */
const linkPaths = (links, cap) =>
  dedupe(
    links.map((l) => {
      try {
        const u = new URL(l.url);
        return u.pathname + u.search;
      } catch {
        return null;
      }
    }),
  )
    .filter((p) => p !== "/")
    .slice(0, cap);

async function crawlSite(entry, ctx) {
  const pages = [];
  const skipped = [];
  const origin = new URL(entry.url).origin;
  const llms = entry.kind === "site" ? corpusText("sites", entry.domain, "llms.txt") : null;
  const candidates = [];
  if (llms) {
    const p = extractMarkdown(llms, `${origin}/`);
    p.text = cutText(p.text, LIMITS.llmsText);
    pages.push(digestPage(`${origin}/llms.txt`, "corpus:llms.txt", p, null));
    for (const l of p.links) candidates.push({ url: l.url, from: "llms" });
  }
  const home = await fetchPage(entry.url, ctx.fetcher, ctx.hosts);
  const homeBlocked = home.page ? blockReason(home.res, home.page, home.html) : blockReason(home.res, null, home.html) || "unreadable";
  let redirected = null;
  if (home.res.finalUrl && !sameSite(home.res.finalUrl, entry.url)) redirected = home.res.finalUrl;
  const thin = !homeBlocked ? thinReason(home.page, home.html) : null;
  if (!homeBlocked) {
    pages.push(digestPage(entry.url, "fetch", home.page, home.res));
    for (const l of home.page.links) candidates.push({ url: l.url, from: home.page.nav.includes(l.text) ? "nav" : "home" });
  } else skipped.push({ url: entry.url, why: homeBlocked });
  if (entry.kind === "site") {
    const sm = join(FILE.corpus, "sites", entry.domain, "sitemap.json");
    if (existsSync(sm))
      try {
        for (const u of (loadJSON(sm)?.urls || []).slice(0, 5000)) candidates.push({ url: typeof u === "string" ? u : u.loc, from: "sitemap" });
      } catch {
        /* no sitemap candidates */
      }
    // pages of a site whose homepage is walled are walled too: do not knock on more doors
    const base = redirected && !homeBlocked ? home.res.finalUrl : entry.url;
    const extras = homeBlocked && !llms ? [] : pickExtraPages(base, candidates, { max: LIMITS.extraTries });
    let good = 0;
    for (const x of extras) {
      if (good >= LIMITS.extraPages) break;
      const r = await fetchPage(x.url, ctx.fetcher, ctx.hosts);
      const why = r.page ? blockReason(r.res, r.page, r.html) : blockReason(r.res, null, r.html) || "unreadable";
      if (why) {
        skipped.push({ url: x.url, why });
        continue;
      }
      pages.push({ ...digestPage(x.url, "fetch", r.page, r.res), picked_as: x.bucket });
      good++;
    }
  }
  return { pages, skipped, homeBlocked, redirected, llms: Boolean(llms), thin: thin && pages.filter((p) => p.text?.split(/\s+/).length >= 40).length === 0 ? `homepage: ${thin}` : null };
}

async function crawlRepo(entry, ctx) {
  const { owner, repo } = repoParts(entry.url);
  const dir = `${owner}__${repo}`;
  const pages = [];
  const skipped = [];
  for (const name of ["README.md", "SKILL.md"]) {
    const local = corpusText("repos", dir, name);
    if (local) {
      pages.push(digestPage(`${entry.url}/blob/HEAD/${name}`, `corpus:${name}`, extractMarkdown(local, `${entry.url}/blob/HEAD/`), null));
      continue;
    }
    const tries = name === "README.md" ? ["README.md", "readme.md", "Readme.md"] : [name];
    for (const t of tries) {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${t}`;
      const r = await fetchPage(url, ctx.fetcher, ctx.hosts);
      if (r.res.status === 200 && r.res.text) {
        pages.push(digestPage(`${entry.url}/blob/HEAD/${t}`, "github-raw", extractMarkdown(r.res.text, `${entry.url}/blob/HEAD/`), r.res));
        break;
      }
      if (r.res.status !== 404) {
        skipped.push({ url, why: r.res.error || `http ${r.res.status}` });
        break;
      }
    }
  }
  return { pages, skipped, homeBlocked: pages.length ? null : skipped[0]?.why || "no README.md or SKILL.md", redirected: null };
}

async function crawlPageEntry(entry, ctx) {
  const r = await fetchPage(entry.url, ctx.fetcher, ctx.hosts);
  const why = r.page ? blockReason(r.res, r.page, r.html) : blockReason(r.res, null, r.html) || "unreadable";
  const pages = why ? [] : [digestPage(entry.url, "fetch", r.page, r.res)];
  const thin = why ? null : thinReason(r.page, r.html);
  return { pages, skipped: why ? [{ url: entry.url, why }] : [], homeBlocked: why, thin, redirected: r.res.finalUrl && !sameSite(r.res.finalUrl, entry.url) ? r.res.finalUrl : null };
}

/** One entry → its digest object (not written). ctx = { fetcher, hosts, siteOf, now }. */
export async function crawlEntry(entry, ctx) {
  const base = {
    id: entry.id,
    url: entry.url,
    kind: entry.kind,
    crawler: CRAWLER,
    crawled_at: new Date(ctx.now ?? Date.now()).toISOString(),
    hints_hash: hintsHash(entry),
    hints: hintsOf(entry),
    known: knownOf(entry, { siteOf: ctx.siteOf }),
  };
  const off = entry.kind === "repo" ? null : disabledHost(entry.url, ctx.hosts);
  let got;
  if (off) got = { pages: [], skipped: [{ url: entry.url, why: `host disabled in catalog/scrapling-hosts.json: ${off}` }], homeBlocked: "host disabled (owner decision)", redirected: null };
  else if (entry.kind === "repo") got = await crawlRepo(entry, ctx);
  else if (entry.kind === "page") got = await crawlPageEntry(entry, ctx);
  else got = await crawlSite(entry, ctx);

  // ok: the entry's own page reads · partial: it is walled or JavaScript-only, but the corpus or other pages say something
  const status = got.homeBlocked && !got.pages.length ? "blocked" : got.homeBlocked || got.thin ? "partial" : "ok";
  const homeAt = got.pages.findIndex((p) => p.source !== "corpus:llms.txt" && !p.picked_as); // the entry's own page (or README)
  const homeFetched = got.llms && homeAt === 1;
  const budget =
    entry.kind === "page" ? { budget: LIMITS.pageEntryText, heads: [LIMITS.pageEntryText] }
    : entry.kind === "repo" ? { budget: LIMITS.repoText, heads: [LIMITS.pageText], restCap: LIMITS.repoText }
    : got.llms ? { budget: LIMITS.siteText, heads: homeFetched ? [LIMITS.llmsText, LIMITS.homeText] : [LIMITS.llmsText] }
    : { budget: LIMITS.siteText, heads: [LIMITS.homeText] };
  trimPages(got.pages, budget);
  // the homepage keeps the most links (the extractor sees the site's structure there); llms.txt names its own in its text
  got.pages.forEach((p, i) => (p.links = linkPaths(p.links, i === homeAt ? LIMITS.linksHome : LIMITS.linksOther)));
  if (entry.kind === "page") got.pages.forEach((p) => (p.links = p.links.slice(0, LIMITS.linksOther)));
  const d = { ...base, status };
  if (got.homeBlocked || got.thin) d.reason = got.homeBlocked || got.thin;
  if (got.redirected) d.redirected_to = got.redirected;
  d.pages = got.pages;
  if (got.skipped.length) d.skipped = got.skipped;
  d.tokens = 0;
  d.tokens = estimateTokens(serialize(d));
  return d;
}

// ---------------------------------------------------------------- main

export function loadPilot(file = PILOT_FILE) {
  const p = loadJSON(file);
  return (p?.entries || []).map((e) => (typeof e === "string" ? e : e.id));
}

const pct = (xs, q) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
};

/** Size / status table over digests (for the pilot report and the run estimate). */
export function digestReport(ids, { dir = CRAWL_DIR } = {}) {
  const rows = [];
  for (const id of ids) {
    const d = loadJSON(digestFile(id, dir));
    if (d) rows.push({ id, kind: d.kind, status: d.status, reason: d.reason || "", tokens: d.tokens, pages: d.pages.length });
  }
  const by = (k) => rows.reduce((m, r) => ((m[r[k]] = (m[r[k]] || 0) + 1), m), {});
  const tok = (filter) => rows.filter(filter).map((r) => r.tokens);
  const stats = (xs) => ({ n: xs.length, median: pct(xs, 0.5), p90: pct(xs, 0.9), max: Math.max(0, ...xs), total: xs.reduce((a, b) => a + b, 0) });
  return {
    rows,
    status: by("status"),
    kinds: by("kind"),
    all: stats(tok(() => true)),
    siteRepo: stats(tok((r) => r.kind !== "page")),
    page: stats(tok((r) => r.kind === "page")),
  };
}

function printReport(rep) {
  const line = (n, s) => `${n.padEnd(12)} n=${s.n} median ${s.median} · p90 ${s.p90} · max ${s.max} · total ${s.total}`;
  console.log(`status: ${Object.entries(rep.status).map(([k, v]) => `${k} ${v}`).join(" · ")}  kinds: ${Object.entries(rep.kinds).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  console.log(line("all", rep.all));
  console.log(line("site+repo", rep.siteRepo));
  console.log(line("page", rep.page));
  for (const r of rep.rows.filter((r) => r.status !== "ok")) console.log(`  ${r.status.padEnd(8)} ${r.id} — ${r.reason}`);
}

async function main(argv) {
  const arg = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const force = argv.includes("--force");
  const { loadItems } = await import("./build.mjs");
  const entries = loadItems({ metadata: false });
  const byId = new Map(entries.map((e) => [e.id, e]));
  const sites = new Map();
  for (const e of entries) if (e.kind === "site" && !sites.has(e.domain)) sites.set(e.domain, e);
  let ids;
  if (arg("--id")) ids = arg("--id").split(",").map((s) => s.trim()).filter(Boolean);
  else if (argv.includes("--pilot")) ids = loadPilot();
  else if (argv.includes("--queue")) {
    const q = loadJSON(join(METADATA_DIR, "_queue.json"));
    if (!q) throw new Error("catalog/metadata/_queue.json missing — run: bun tools/metadata-queue.mjs");
    ids = q.items.map((i) => i.id);
    if (arg("--limit")) ids = ids.slice(0, Number(arg("--limit")));
  } else {
    console.error("usage: bun tools/crawl.mjs --id <id>[,…] | --queue [--limit n] | --pilot   [--force] [--report]");
    process.exit(2);
  }
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) console.error(`! not catalog ids: ${unknown.join(", ")}`);
  ids = ids.filter((id) => byId.has(id));
  if (argv.includes("--report")) return printReport(digestReport(ids));

  const dead = ids.filter((id) => isDead(byId.get(id)));
  const todo = ids.filter((id) => !isDead(byId.get(id)) && (force || !existsSync(digestFile(id))));
  const kept = ids.length - dead.length - todo.length;
  console.log(`crawl: ${todo.length} to crawl · ${kept} have a digest (--force redoes them) · ${dead.length} dead, skipped`);
  if (dead.length) console.log(`  dead: ${dead.join(", ")}`);
  const fetcher = createFetcher();
  const hosts = loadHosts();
  const ctx = { fetcher, hosts, siteOf: (domain) => sites.get(domain) || null };
  let done = 0;
  await pool(todo, 8, async (id) => {
    let d;
    try {
      d = await crawlEntry(byId.get(id), ctx);
    } catch (e) {
      console.error(`  ! ${id}: ${e?.stack || e}`);
      return;
    }
    saveText(digestFile(id), serialize(d)); // exactly what `tokens` measured
    done++;
    console.log(`  [${done}/${todo.length}] ${d.status.padEnd(7)} ${String(d.tokens).padStart(5)} tok  ${id}${d.reason ? ` — ${d.reason}` : ""}`);
  });
  await scraplingClient.close();
  console.log(`requests: ${fetcher.requests()}${fetcher.stopped().length ? ` · hosts stopped: ${fetcher.stopped().join("; ")}` : ""}`);
  printReport(digestReport(ids));
}

if (import.meta.main) await main(process.argv.slice(2));

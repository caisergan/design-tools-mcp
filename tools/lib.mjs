// Shared helpers for the design-tools catalog pipeline.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const OUT = join(ROOT, "catalog");
export const SRC = join(ROOT, "ui-design-kaynak-linkleri.md");
export const FILE = {
  catalog: join(OUT, "catalog.json"),
  probe: join(OUT, "probe.json"),
  blocklist: join(OUT, "blocklist.json"),
  reachability: join(OUT, "reachability.json"),
  router: join(OUT, "ROUTER.md"),
  llms: join(OUT, "llms.txt"),
  corpus: join(OUT, "corpus"),
  manifest: join(OUT, "corpus", "MANIFEST.md"),
  sources: join(OUT, "sources"),
  overrides: join(OUT, "overrides.json"),
  taxonomy: join(OUT, "taxonomy.json"),
  sitemapsReport: join(OUT, "sitemaps-report.json"),
};

// ---------------------------------------------------------------- sources

/**
 * The catalog is built only from catalog/sources/<source_id>.json. Each file is written by its own
 * producer and must carry { source_id (= file name), schema_version, items: [{ url, … }] }.
 * Merge order: earlier sources win for url/name/desc; later ones add categories, labels, popularity.
 */
export const SOURCE_SCHEMA_VERSION = 1;
export const SOURCE_ORDER = ["curated", "awesome-lists", "x-community"];

export function writeSource(id, meta, items) {
  saveJSON(join(FILE.sources, `${id}.json`), {
    source_id: id,
    schema_version: SOURCE_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    ...meta,
    count: items.length,
    items,
  });
}

export function loadSources() {
  if (!existsSync(FILE.sources))
    throw new Error(
      `${FILE.sources} missing — run the source producers first: bun tools/source-curated.mjs · bun tools/ingest.mjs <awesome-list> · python3 harvest/x-ui-harvest/build_central.py`,
    );
  const rank = (id) => (SOURCE_ORDER.includes(id) ? SOURCE_ORDER.indexOf(id) : SOURCE_ORDER.length);
  return readdirSync(FILE.sources)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const id = f.slice(0, -5);
      const src = JSON.parse(readFileSync(join(FILE.sources, f), "utf8"));
      if (src.source_id !== id) throw new Error(`sources/${f}: source_id is "${src.source_id}", expected "${id}"`);
      if (src.schema_version !== SOURCE_SCHEMA_VERSION)
        throw new Error(`sources/${f}: schema_version ${src.schema_version}, this build reads ${SOURCE_SCHEMA_VERSION}`);
      if (!Array.isArray(src.items)) throw new Error(`sources/${f}: items must be an array`);
      return src;
    })
    .sort((a, b) => rank(a.source_id) - rank(b.source_id) || a.source_id.localeCompare(b.source_id));
}

// ---------------------------------------------------------------- urls

const TRACKING = ["via", "ref", "source", "r", "sa", "aff", "medium", "v", "t", "s", "fbclid", "gclid", "igshid", "mc_cid", "mc_eid", "utm_source", "utm_medium", "utm_campaign"];

/** Tracking params (incl. every utm_*) and #hash dropped, host lowercased, no trailing slash. null if not a URL. */
export function normalizeUrl(url) {
  let u;
  try {
    // markdown leftovers like `…?view=x](https://…)` are cut before parsing
    u = new URL(String(url).trim().split(/\]\(|%5D%28/i)[0].replace(/[)\]>]+$/, ""));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  for (const k of [...u.searchParams.keys()])
    if (TRACKING.includes(k.toLowerCase()) || k.toLowerCase().startsWith("utm_")) u.searchParams.delete(k);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  return u.toString().replace(/\/$/, "");
}

/**
 * Dedupe key: www-less host + path, plus the query unless `ignoreQuery` (the query tells
 * `/items?itemName=a` from `?itemName=b`; a source whose query strings are noise sets merge_query_variants).
 */
export const urlKey = (url, { ignoreQuery = false } = {}) => {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  // GitHub owner/repo are case-insensitive: CapSoftware/Cap and CapSoftware/cap are one repo
  return `${host}${host === "github.com" ? path.toLowerCase() : path}${ignoreQuery ? "" : u.search}`;
};

// Asset (image/font/css/js) and junk URLs are never catalog entries: an agent can't use them as a resource.
const ASSET_HOSTS = [
  /^images\.unsplash\.com$/,
  /^fonts\.googleapis\.com$/,
  /^fonts\.gstatic\.com$/,
  /^raw\.githubusercontent\.com$/,
  /^stream\.mux\.com$/,
  /^s3[.-][a-z0-9-]+\.amazonaws\.com$/,
  /^pscp\.tv$/,
  /^drive\.google\.com$/,
  /^fb\.me$/,
  /^bit\.ly$/,
  /^(www\.)?(youtu\.be|youtube\.com|m\.youtube\.com)$/, // video
  /^amzn\.to$/, // affiliate
];
const JUNK = [/^app\.getsupers\.com\/sites\//, /^gumroad\.com\/a\//]; // affiliate, user-generated sitemaps
const ASSET_PATHS = [/\.(png|jpe?g|gif|webp|svg|mp4|mov|m3u8|pdf|zip|css|js)$/i, /^\/css2?\?/];

export function isAssetUrl(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, "");
  return ASSET_HOSTS.some((re) => re.test(u.hostname)) || ASSET_PATHS.some((re) => re.test(u.pathname)) || JUNK.some((re) => re.test(host + u.pathname));
}

export const slug = (s) =>
  s
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);

/** A caller-supplied relative path is only a file name / sub-path: no `..`, no absolute path, no NUL. */
export const SAFE_REL_PATH = /^[\w.\-]+(\/[\w.\-]+)*$/;
export const isSafeRelPath = (rel) =>
  typeof rel === "string" && SAFE_REL_PATH.test(rel) && !rel.split("/").some((part) => part === ".." || part === ".");

/** Join `rel` under `dir`, or null when the result would land outside `dir`. */
export function safeJoin(dir, rel) {
  if (!isSafeRelPath(rel)) return null;
  const root = resolve(dir);
  const full = resolve(root, rel);
  return full.startsWith(root + sep) ? full : null;
}

export const loadJSON = (p, fallback = null) =>
  existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback;

export function saveJSON(p, value) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(value, null, 2) + "\n");
}

export function saveText(p, text) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

/** Run `fn` over `items` with at most `n` in flight. Results keep input order. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export const isGitHubRepo = (url) =>
  /^https?:\/\/github\.com\/[^/]+\/[^/?#]+$/.test(url);

export function repoParts(url) {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)/.exec(url);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * Registry index URLs don't imply where the individual items live: shadcn serves
 * `/r/styles/<style>/<name>.json`, aceternity `/registry/<name>.json`, themes like tweakcn
 * `/r/themes/<name>.json`, most others `<index-dir>/<name>.json`. Try the known layouts in
 * order and keep the first that answers.
 */
export function itemBaseCandidates(indexUrl) {
  const origin = new URL(indexUrl).origin;
  const dir = indexUrl.replace(/\/[^/]+\.json$/, "");
  return [
    ...new Set([
      dir,
      `${dir}/themes`,
      `${origin}/r`,
      `${origin}/r/themes`,
      `${origin}/registry`,
      `${origin}/r/registry`,
      `${origin}/r/styles/new-york-v4`,
      `${origin}/r/styles/new-york`,
      origin,
    ]),
  ];
}

/** 401, or any status whose body names a licence / API key / login wall. */
export const isGatedResponse = (status, body = "") =>
  status === 401 || /licen[cs]e|unauthoriz|unauthorized|authentication|\bapi key\b/i.test(body);

export async function resolveItemBase(indexUrl, firstName, { ua = "Mozilla/5.0 (compatible; design-tools/1.0)", timeout = 10_000 } = {}) {
  for (const base of itemBaseCandidates(indexUrl)) {
    try {
      const res = await fetch(`${base}/${encodeURIComponent(firstName)}.json`, {
        redirect: "follow",
        headers: { "user-agent": ua },
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 401 || res.status === 403) return { base, gated: res.status };
      if (!res.ok) {
        const contentType = res.headers.get("content-type") || "";
        const body = await res.text().catch(() => "");
        const isJson = /json/i.test(contentType) || /^\s*[{[]/.test(body);
        if (isJson && isGatedResponse(res.status, body)) return { base, gated: res.status };
        continue;
      }
      if (!/json/i.test(res.headers.get("content-type") || "")) continue;
      return { base, data: await res.json() };
    } catch {
      /* try the next layout */
    }
  }
  return null;
}

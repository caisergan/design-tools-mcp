// Shared helpers for the design-tools catalog pipeline.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { isIP } from "node:net";

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

// ---------------------------------------------------------------- fetching a url an agent names (SSRF guard)

const INTERNAL_SUFFIX = /(^|\.)(localhost|localdomain|local|internal|intranet|lan|home|corp|home\.arpa|arpa)$/;

/** A public DNS name: no IP literal, no localhost, no single-label or internal-only name. */
export function isPublicHostname(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h || isIP(h) || !h.includes(".")) return false;
  // numeric hosts some resolvers still read as an address (0x7f.1, 2130706433, 127.1)
  if (/^[\d.]+$/.test(h) || /^0x[0-9a-f]+(\.|$)/i.test(h)) return false;
  return !INTERNAL_SUFFIX.test(h);
}

/** Loopback, private, link-local, CGNAT, multicast or reserved: an address a fetch for an agent never goes to. */
export function isPrivateAddress(ip) {
  const a = String(ip || "").toLowerCase();
  if (isIP(a) === 4) {
    const [x, y] = a.split(".").map(Number);
    return (
      x === 0 || x === 10 || x === 127 || x >= 224 ||
      (x === 100 && y >= 64 && y <= 127) ||
      (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && (y === 168 || (y === 0 && a.startsWith("192.0.0.")))) ||
      (x === 198 && (y === 18 || y === 19))
    );
  }
  if (isIP(a) === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateAddress(mapped[1]);
    return a === "::" || a === "::1" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || a.startsWith("::ffff:");
  }
  return true; // not an address at all: refuse
}

/** The form a listed url is compared in: no hash, no trailing slash. */
export function listedKey(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** Every absolute url an llms.txt names, plus its root-relative markdown links resolved against `origin`. */
export function llmsUrls(text, origin) {
  const out = new Set();
  for (const m of String(text || "").matchAll(/https?:\/\/[^\s)<>\]"'`]+/g)) out.add(listedKey(m[0].replace(/[.,;:]+$/, "")));
  for (const m of String(text || "").matchAll(/\]\((\/[^\s)]*)\)/g)) out.add(listedKey(new URL(m[1], origin).href));
  out.delete(null);
  return out;
}

/**
 * May the server fetch `url` for an entry whose own url is `origin`? Only https on the default port, a public host
 * name, and either the entry's own site (with or without www.) or a url its llms.txt lists (`listed`, from
 * llmsUrls). Returns null when allowed, else why not. Redirect targets go through the same check.
 */
export function followProblem(url, { origin, listed = new Set() } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return `"${String(url).slice(0, 100)}" is not a url`;
  }
  if (u.protocol !== "https:") return `${u.protocol.replace(/:$/, "")} is not allowed, https only`;
  if (u.username || u.password) return "a url with credentials is not allowed";
  if (u.port && u.port !== "443") return `port ${u.port} is not allowed`;
  if (!isPublicHostname(u.hostname)) return `${u.hostname} is not a public host name`;
  const site = (h) => h.toLowerCase().replace(/^www\./, "");
  let own = null;
  try {
    own = new URL(origin);
  } catch {
    /* no own site: only listed urls */
  }
  if (own && site(u.hostname) === site(own.hostname)) return null;
  if (listed.has(listedKey(u.href))) return null;
  return `${u.host} is not the entry's site${own ? ` (${own.host})` : ""} and the url is not listed in its llms.txt`;
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

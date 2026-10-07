# Brief 01 — Download full sitemaps (level 1)

## Context
`/Users/egeayyildiz/Desktop/personal-projects/design-tools` is a catalog of ~2,700 UI/design websites served to AI
agents through an MCP server (`tools/mcp.mjs`). An earlier probe (`tools/probe.mjs`) stored only the first 8 KB of
each site's sitemap. Later steps turn sitemap URLs into searchable component records, so they need the **full**
sitemap of every site, saved locally. Your job is only the download; you do not interpret the URLs.

Runtime is `bun`, plain ESM `.mjs`, no npm dependencies. Shared helpers live in `tools/lib.mjs` (`FILE`, `loadJSON`,
`saveJSON`, `pool`, `slug`).

## Inputs
- Target domains: `briefs/phase-6/sites/all-sitemap-domains.txt` (860 domains, one per line).
- Known sitemap URL per entry: `catalog/probe.json` → `.items["<entry url>"].sitemap.url` (keys are entry URLs, not
  domains; several entries can share a domain). Query with `jq`, never read the file whole.

## What to build
1. **New `tools/sitemaps.mjs`**, runnable as `bun tools/sitemaps.mjs [--only=a.com,b.com] [--refresh]`.
   - For each domain, collect sitemap URLs from: the probe's `sitemap.url`, the `Sitemap:` lines of
     `https://<domain>/robots.txt`, and `https://<domain>/sitemap.xml` as a fallback. De-duplicate.
   - Follow `<sitemapindex>` into child sitemaps (depth ≤ 3). Handle `.xml.gz` (gunzip with `node:zlib`).
   - Parse with an exported pure function `parseSitemap(text) → { kind: "urlset" | "index" | "invalid", entries: [{ loc, lastmod? }] }`.
     Regex over `<url>…</url>` / `<sitemap>…</sitemap>` blocks is fine; decode `&amp;` etc. and `<![CDATA[…]]>`.
     HTML (a Cloudflare "Just a moment" page, a soft-404) → `invalid`.
   - Keep only URLs whose host is the domain or `www.` + domain. Count the dropped ones.
   - Cap at 50,000 URLs per domain; set `truncated: true` past that.
   - Write `catalog/corpus/sites/<domain>/sitemap.json`:
     ```json
     { "domain": "navbar.gallery", "fetched_at": "<ISO>", "truncated": false, "foreign_dropped": 0,
       "sources": [{ "url": "...", "status": 200, "kind": "urlset", "count": 642 }],
       "urls": [{ "loc": "https://navbar.gallery/navbar/stripe", "lastmod": "2026-09-01" }] }
     ```
     Omit `lastmod` when absent. Write nothing for a domain that yielded 0 URLs.
   - **Politeness:** ≤ 2 requests/s per host (a per-host queue), up to 12 hosts at once (`pool`), 20 s timeout,
     user agent `Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)`, no auth headers. After 3 responses of
     403 / 429 / 503 / challenge-HTML from one host, stop that host.
   - **Resumable:** skip a domain whose `sitemap.json` is younger than 7 days unless `--refresh`.
   - At the end write `catalog/sitemaps-report.json` (`{ ok: [...domain, count], empty: [...], blocked: [{ domain, reason }], failed: [...] }`)
     and print a summary: domains tried / ok / empty / blocked (by reason), total URLs, the 20 largest domains.
2. **`tools/fetch.mjs`:** add `--sitemaps`, which runs the same code (import from `sitemaps.mjs`), and teach
   `inferKind` that `sitemap.json` files are kind `sitemap` so `MANIFEST.md` labels them.
3. **New `tools/sitemaps.test.mjs`** (no network): urlset, sitemapindex, gzip, CDATA/entities, HTML challenge →
   invalid, foreign host dropped, cap/truncation.

## Run it
`bun tools/sitemaps.mjs` over all 860 domains. It takes a while — run it in the background with output to a log
file, and re-run to resume if it stops.

## Do not
- Edit `tools/items.mjs`, `tools/mcp.mjs`, `tools/search.mjs`, `catalog/catalog.json`, `catalog/probe.json`.
- Run `bun tools/build.mjs`.
- Read `catalog/catalog.json`, `catalog/search-index.json` or `catalog/corpus/` whole.

## Done when
- `bun test ./tools` passes (all existing tests plus yours).
- The full run finished; `navbar.gallery` has ≥ 600 URLs and `21st.dev` ≥ 12,000.
- Report: domains ok / empty / blocked (with reasons), total URLs, truncated domains, total size on disk of the
  sitemap files, run time.

# Brief 03 — 21st.dev component metadata (adapter 5)

## Context
`/Users/egeayyildiz/Desktop/personal-projects/design-tools` is a catalog of UI/design websites served to AI agents
by an MCP server. Components inside sites are stored as **items** (built by `tools/items.mjs` → 
`catalog/items/<entry-id>.json`). 21st.dev is the largest single component collection (7,401 component pages in its
sitemap on 2026-10-07) and has almost no items yet. Your job: collect each component's name, title and description,
and turn them into items marked `gated` (installing the code needs the user's own 21st.dev key, which you never use).

Runtime: `bun`, plain ESM, no npm dependencies. Helpers: `tools/lib.mjs` (`FILE`, `loadJSON`, `saveJSON`, `slug`),
`tools/tag.mjs` (`tagItem`, `loadTagOverrides`). Read `tools/items.mjs` first; your adapter follows its style.

## The endpoint (verified 2026-10-07)
- Sitemap: `https://21st.dev/sitemap.xml` (a single urlset, ~12,400 URLs). Component pages match
  `^/@([^/]+)/components/([^/]+)/?$`.
- `GET https://21st.dev/r/<author>/<name>` without auth returns **403** `application/json`:
  ```json
  {"error":"Authentication required","reason":"authentication_required",
   "component":{"name":"mac-book-neo-hero","title":"MacBook Neo Hero","description":"Scroll-driven image-sequence hero …",
                "author":"jean.duthil13","url":"/@jean.duthil13/components/mac-book-neo-hero"}}
  ```
  That `component` object is all you keep.

## What to build — new `tools/api-21st.mjs`
1. `bun tools/api-21st.mjs --fetch [--limit=N] [--refresh]`
   - First read `https://21st.dev/robots.txt`. If `/r/` is disallowed for `*`, **stop and report**; do not continue.
   - Component list: `catalog/corpus/sites/21st.dev/sitemap.json` if it exists (`.urls[].loc`), else download
     `sitemap.xml` yourself.
   - For each component, GET `/r/<author>/<name>`. Keep `name, title, description, author, url` from the 403 body
     (or from a 200 registry JSON, if one comes back — but **never store `files` / source code**).
   - Store in `catalog/corpus/sites/21st.dev/components.json`:
     `{ "fetched_at": "...", "items": { "<author>/<name>": { "title", "description", "status", "fetched_at" } } }`.
     Save every 200 components so a stopped run resumes; skip keys already present unless `--refresh`.
   - **Politeness:** one request at a time, ≤ 2 requests/s, UA
     `Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)`, **no auth headers, no API key**. Honour
     `Retry-After`; stop after 10 consecutive 429/5xx and report.
   - Full run ≈ 1 hour: run it in the background with output to a log file.
2. **Optional, check first:** 21st.dev has category pages (`/community/components/s/<tag>`, e.g. `s/hero`). Fetch one
   with `curl` and count `/@…/components/…` links in the raw HTML. If they're server-rendered, fetch each category page
   (and plain pagination, ≤ 20 pages each), store `catalog/corpus/sites/21st.dev/categories.json`
   (`{ "<tag>": ["author/name", …] }`), and use membership as an element tag (map the tag slug to an element with
   `tagItem`). If they're JS-rendered, skip this and say so in the report.
3. **Adapter:** export `apiItems(domain, parent, { overrides, taken })` from the same file. For `21st.dev` it reads
   `components.json` (+ `categories.json`) and returns items:
   ```jsonc
   { "id": "21st-dev/<slug(author + '-' + name)>", "parent": "21st-dev",
     "name": "<title or name>", "url": "https://21st.dev/@<author>/components/<name>",
     "description": "<description, whitespace collapsed>", "author": "<author>",
     "elements": [...], "variants": {...},          // tagItem on name + title (NOT description), ∪ category tags
     "access": "gated", "granularity": "variant", "from": "api" }
   ```
   Skip ids already in `taken`. Return `[]` for any other domain.
   **Do not wire it into `tools/items.mjs`** — the coordinator does that.
4. **New `tools/api-21st.test.mjs`** (no network): 403-body parsing, a 200 body with `files` stores no code, id/slug,
   tagging from title not description, category tagging, dedupe.

## Do not
- Edit `tools/items.mjs`, `tools/mcp.mjs`, `tools/search.mjs`, `catalog/catalog.json`.
- Use or ask for any 21st.dev API key or login.
- Store component source code.
- Run `bun tools/build.mjs`. Read `catalog/catalog.json` or `catalog/corpus/` whole.

## Done when
- `bun test ./tools` passes.
- `components.json` holds ≥ 7,000 components with a title.
- Report: fetched / failed (by status), robots.txt result, whether category pages were usable, how many items get an
  element (top 15 elements with counts), how many get `navbar`, run time.

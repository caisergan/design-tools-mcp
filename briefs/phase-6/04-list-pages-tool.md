# Brief 04 — `list_pages` tool and gallery examples in search answers

## Context
`/Users/egeayyildiz/Desktop/personal-projects/design-tools/tools/mcp.mjs` is a dependency-free MCP server (stdio
JSON-RPC) over a catalog of UI/design sites. Components inside sites are **items**
(`catalog/items/<entry-id>.json`), searched through `tools/search.mjs` (`S.rank(query, filters)`).
A new adapter now adds items from site sitemaps (`from: "sitemap"`), most of them gallery examples:
```jsonc
{ "id": "navbar-gallery/stripe", "parent": "navbar-gallery", "name": "Stripe — Navbar",
  "url": "https://navbar.gallery/navbar/stripe", "elements": ["navbar"], "variants": { "navbar": ["mega-menu"] },
  "access": "page", "granularity": "example", "from": "sitemap", "auto": true }   // auto: pattern machine-written
```
Raw sitemaps are saved at `catalog/corpus/sites/<domain>/sitemap.json` (`{ urls: [{ loc, lastmod? }] }`).

Agents pay tokens for every response, so every answer has a byte budget. Read `tools/mcp.mjs` in full first
(`toolSearch`, `toolSearchComponents`, `elementFacets`, `itemLine`, `resolveItem`, `TOOLS`, `HANDLERS`) and the
budget tests in `tools/mcp.test.mjs`.

## What to build
1. **New tool `list_pages(ref, query?, element?, variant?, limit=20, offset=0)`** (annotations: local, read-only).
   - `ref` resolves with `resolveItem` (id, url, domain …).
   - If the entry has items: rank them with `S.rank(query, { scope: "items", registry: <entry id>, element, variant })`
     (validate element/variant with `checkFilters`). Header:
     `# <domain> · <N> pages · kinds: mega-menu 40 · dropdown 31 …` (kinds only when an element is in play).
     One line per item: `- <name> · <url> · <kinds>` — no id unless `access` is `code`/`gated`.
   - If it has no items but has a `sitemap.json`: fall back to raw URLs whose path tokens match the query words or the
     element's aliases (from `catalog/taxonomy.json`, whole tokens). Header says
     `raw sitemap URLs — this site has no pattern yet`. Without a query/element, list the top path prefixes with
     counts instead of URLs.
   - Neither: a `ToolError` that says the site has no mapped pages and gives its URL.
   - `limit` ≤ 50; `more: offset=…` when there's more. Load each `sitemap.json` lazily, cache in memory.
   - Budget: ≤ 2,500 bytes at `limit=20`.
2. **Gallery examples in `search_resources`:** today `itemGroup` puts every `access: "page"` item under
   "Docs pages". Give `granularity: "example"` items their own group "Gallery examples" (with its own cap), count
   them in `elementFacets` and in the count line:
   `# navbar · 420 components (…) · 640 gallery examples · 54 docs pages · 7 sites & repos about it`.
   Update the existing count-line test regex. The navbar answer must stay ≤ 3,000 bytes.
3. **`search_components`:** example items show their url (like page items); nothing else changes.
4. **Readable flags:** an entry with ≥ 1 item must no longer print `unreadable:<reason>` in `entryLine`; print
   `pages:<N>` instead. `get_resource` on such an entry adds `mapped pages: N → list_pages("<id>")`.
5. **Ranking:** in `tools/search.mjs` `prior()`, multiply items with `auto: true` by `0.92` (a named constant).
6. **Server `instructions`** and the `search_resources` description: one short mention of `list_pages`. `tools/list`
   must stay < 8 KB (existing test).

## Tests — add to `tools/mcp.test.mjs` (no network)
- `list_pages("navbar-gallery", { variant: "mega-menu", element: "navbar" })` returns navbar.gallery deep links,
  ≤ 2,500 bytes.
- Fallback on a site with `sitemap.json` and no items: raw URLs, marked as such.
- Unknown variant → the error lists valid ids.
- `search_resources("navbar")`: a "Gallery examples" group, the new count line, ≤ 3,000 bytes.
- An entry with items and `reach.ok === false` shows `pages:N`, not `unreadable:`.
- Use real data in `catalog/` (the existing tests do); if navbar.gallery has no items yet, stop and report — the
  sitemap adapter must be merged first.

## Do not
- Edit `tools/items.mjs`, `tools/sitemap-items.mjs`, `catalog/patterns/`, `catalog/catalog.json`.
- Run `bun tools/build.mjs` (`bun tools/index.mjs` is fine). Read `catalog/catalog.json`, `catalog/search-index.json`
  or `catalog/corpus/` whole.

## Done when
- `bun test ./tools` passes.
- Report: the three example responses (navbar search, list_pages mega-menu, a fallback) with their byte sizes, and
  the `tools/list` size.

# Brief 02 — URL patterns, the sitemap adapter and the pattern guesser (level 2 engine)

## Context
`/Users/egeayyildiz/Desktop/personal-projects/design-tools` is a catalog of UI/design websites served to AI agents
by an MCP server (`tools/mcp.mjs`). Goal: when an agent asks for "navbar" it gets every navbar example and
component across all sites, each with a direct link.

Today `tools/items.mjs` builds **items** (one record per component or docs page) from files already on disk, using
two adapters: registry JSON and llms.txt link lines. Output: `catalog/items/<entry-id>.json`, then
`tools/index.mjs` builds `catalog/search-index.json`. Read `tools/items.mjs` in full first — your code follows it.

Another agent is downloading full sitemaps to `catalog/corpus/sites/<domain>/sitemap.json`:
```json
{ "domain": "navbar.gallery", "fetched_at": "...", "truncated": false,
  "urls": [{ "loc": "https://navbar.gallery/navbar/stripe", "lastmod": "2026-09-01" }] }
```
Some may already exist; build and test against fixtures in that shape, and use real files for the acceptance run.

Your job: a **pattern file per site** saying which sitemap URLs are items, an **adapter** that turns them into items,
and a **guesser** that proposes patterns automatically. No LLM anywhere: everything is deterministic.

Runtime: `bun`, plain ESM, no npm dependencies. Helpers: `tools/lib.mjs` (`FILE`, `loadJSON`, `saveJSON`, `slug`),
`tools/tag.mjs` (`tagItem`, `TAXONOMY`, `loadTagOverrides`). Element ids and aliases: `catalog/taxonomy.json`
`.elements[]` (`id`, `aliases`, `variants`, `exclude`).

## Item shape (existing, do not change)
```jsonc
{ "id": "<entry-id>/<slug>", "parent": "<entry-id>", "name": "…", "url": "…",
  "elements": ["navbar"], "variants": { "navbar": ["mega-menu"] },   // variants is an object keyed by element
  "access": "page", "granularity": "example", "from": "sitemap" }
```
`granularity`: `page` = one docs/component page; `example` = one gallery example; `variant` = one component.
New optional field you add: `"auto": true` when the pattern was machine-written (see below).

## 1. Pattern files — `catalog/patterns/<domain>.json` (one file per domain)
One file per domain so several reviewers can edit in parallel without conflicts.
```jsonc
{
  "match": "/navbar/{name}",                // or an array of templates
  "element": "navbar",                      // optional: fixed element for every match
  "granularity": "example",                 // page (default) | example | variant
  "access": "page",                         // page (default) | gated
  "exclude": ["/navbar/{name}/amp"],        // optional templates to drop
  "variants_from": { "mega-menu": "/mega-menu", "dropdown": "/dropdown" },   // filter page per variant id
  "elements_from": { "footer": "/category/footers" },                         // filter page per element id
  "status": "hand",                         // hand = checked against real pages · auto = written by the guesser
  "note": "why, quirks"
}
```
or `{ "skip": "reason", "status": "hand" }` when the site's sitemap has no component pages.

**Template rules** (one template segment ↔ one path segment; trailing slash and query ignored):
- literal text must match exactly;
- `{name}` → `.+` inside its segment (greedy), `{author}` → one segment, `{n}` → digits, `{*}` → any one segment;
- `{element}` → **only** a taxonomy element id or alias in slug form (alternation, longest first). This is what
  stops false matches: sectionmaster's `/sections/navattic-com-hero-1` with
  `/sections/{name}-{element}-{n}` must give name `navattic-com`, element `hero` — never navbar.
- variant ids in `variants_from` must be valid variants of the pattern's element (validate, error otherwise).

## 2. Filter pages — `bun tools/patterns.mjs --fetch-filters [--only=domain]`
For every `variants_from` / `elements_from` URL: download the HTML once to
`catalog/corpus/sites/<domain>/filters/<key>.html` (≤ 2 req/s per host, UA
`Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)`), skip if cached unless `--refresh`. Follow
`?page=2` style pagination only if the page links to it plainly, max 20 pages. The build reads the cached files
offline: collect `href`s, resolve them, keep those that match the site's `match`, and tag those items with the
variant / element. If a filter page yields 0 matching links (JS-rendered), print a warning — don't fail.

## 3. Adapter 3 — new `tools/sitemap-items.mjs`
Export `sitemapItems(domain, parent, { overrides, taken, pattern, sitemap, filters })` (pure; loaders separate so
tests can pass objects in). Then wire it into `buildItems` in `tools/items.mjs` after the llms adapter:
- Only when a pattern file exists and is not `skip`.
- id: `<parent.id>/<slug(name)>`, or `<parent.id>/<slug(author + "-" + name)>` when `{author}` is present; when
  only `{element}` is captured, slug the element segment.
- **Dedupe:** skip an item whose id or normalised url is already in `taken` (registry and llms items win). Add yours
  to `taken`.
- name: humanised slug (`mega-menu-acme` → `Mega Menu Acme`); for a fixed-element gallery,
  `<Name> — <Element label>` (`Stripe — Navbar`).
- elements: fixed `element` ∪ captured `{element}` ∪ `elements_from` membership; if none of these, `tagItem` on the
  name (whole-token alias matching, as the other adapters do).
- variants: from `variants_from` membership, plus `tagItem` variants.
- `auto: true` when the pattern's status is `auto`.
- `report()` in items.mjs: add the sitemap count and a per-site line for sitemap items.

## 4. Guesser — `bun tools/patterns.mjs --suggest <domain>` and `--auto <list.tsv>`
- `--suggest`: from `sitemap.json`, group URLs by path prefix with the last segment as `{name}`
  (also try the last two segments). For each prefix with ≥ 10 children print: template, child count, % of children
  whose slug tags to an element, 5 sample URLs, and a confidence. Writes nothing.
- **High confidence** = all of: ≥ 10 children; no locale / blog / docs-meta segment (export and reuse
  `SKIP_SEGMENT`, `LOCALE`, `COMPONENT_SEGMENT` from items.mjs); and either the prefix's last literal segment is a
  component segment (`components`, `blocks`, `ui`, `sections` …) or an element id/alias (`/navbar/`), or ≥ 30 % of
  children tag to an element. Everything else is low.
- `--auto briefs/phase-6/sites/auto-sites.tsv`: for each domain (column 2) without a pattern file, write the
  high-confidence suggestion with `"status": "auto"`. **Never overwrite** an existing file. Put the rest in
  `catalog/patterns-review.json` (`[{ domain, reason, top_prefixes: [...] }]`) for human/agent review.
- `--check <domain>`: matched URL count, item count, % with an element, variant counts, 8 sample items.

## 5. Write the hand patterns for the 8 plan sites
navbar.gallery, navbar.design, sectionmaster.com, footer.design, supahero.io, cta.gallery, daisyui.com, hover.dev.
For each: run `--suggest`, look at a few real pages with `curl` (status + `<title>`, not whole pages into your
context), write `catalog/patterns/<domain>.json` with `status: "hand"` and a `note`. For navbar.gallery, find its
kind filter pages (`/mega-menu`, `/browse` …), add `variants_from`, run `--fetch-filters`. If a site has no sitemap
file, record `skip` with the reason.

## Tests — new `tools/patterns.test.mjs` (no network)
Template compile/match (navbar.gallery; sectionmaster's navattic case; daisyui `/components/{element}/`; `{author}`),
exclude, variant validation, dedupe against `taken`, filter-page tagging from a fixture HTML, guesser confidence on a
fixture sitemap (a `/components/*` site → high; a blog-only site → low).

## Do not
- Edit `tools/mcp.mjs`, `tools/search.mjs`, `catalog/catalog.json`, `catalog/taxonomy.json`.
- Run `bun tools/build.mjs`. (`bun tools/items.mjs --dry` and `bun tools/index.mjs` are fine.)
- Read `catalog/catalog.json`, `catalog/search-index.json` or `catalog/corpus/` whole.

## Done when
- `bun test ./tools` passes.
- `bun tools/items.mjs --dry` shows sitemap items. navbar.gallery has ≥ 600 items with element `navbar`, and the
  variant counts from its filter pages. No sectionmaster item gets `navbar` from a company name.
- `--auto` has run over `auto-sites.tsv`.
- Report: per plan site → items, % with element, variants; `--auto` → files written vs queued for review;
  total sitemap items; `search-index.json` size after `bun tools/index.mjs` (flag it if > 25 MB, don't fix it).

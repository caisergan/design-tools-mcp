# Brief 05 — Pattern review batch (fill in BATCH before handing out)

**BATCH:** `<file>` rows `<from>`–`<to>`  (e.g. `briefs/phase-6/sites/hand-sites.tsv` rows 1–18, or
`catalog/patterns-review.json` entries 1–30)

## Context
`/Users/egeayyildiz/Desktop/personal-projects/design-tools` maps UI/design websites down to individual component
and example pages, so an AI agent asking for "pricing" gets every pricing section across all sites, each with a
direct link. Each site gets a small pattern file, `catalog/patterns/<domain>.json`, saying which of its sitemap URLs
are components/examples and which UI element they are. A script turns those into searchable items. Your job: write
correct pattern files for the sites in your batch. You edit **only** those files.

Pattern file format:
```jsonc
{
  "match": "/components/{element}",          // or an array of templates
  "element": "navbar",                       // optional: fixed element for every match
  "granularity": "page",                     // page = docs/component page · example = gallery example · variant = one component
  "exclude": ["/components/{element}/api"],  // optional
  "variants_from": { "mega-menu": "/mega-menu" },        // optional: a filter page listing every example of a kind
  "elements_from": { "footer": "/category/footers" },    // optional: same, for multi-element galleries
  "status": "hand",
  "note": "what the site is, what one page is, quirks"
}
```
or `{ "skip": "reason", "status": "hand" }` when the sitemap has no component/example pages (only blog, pricing,
marketing).
Template segments: literal text, `{name}` (any text), `{author}` (one segment), `{n}` (digits), `{*}` (any one
segment), `{element}` (only matches a UI element id/alias such as `navbar`, `hero`, `pricing`, `toast`). Element and
variant ids: `jq -c '.elements[] | {id, variants: [.variants[]?.id]}' catalog/taxonomy.json`.

## For each site in the batch
1. `bun tools/patterns.mjs --suggest <domain>` — path groups, child counts, % that name an element, samples.
2. Look at 2–3 real pages with `curl -s -A "Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)" <url>`,
   printing only the status and `<title>` (e.g. `| grep -o '<title>[^<]*'`). Never pull whole pages into your context.
   Confirm what one page actually is: a component doc, a gallery example, a template, or something else.
3. Watch for false matches: a slug can contain an element word that is a company or product name (sectionmaster's
   `navattic-com-hero-1` is a hero section of Navattic, not a navbar). Prefer `{element}` in its own position or a
   fixed `element` over relying on words in names.
4. If the site has kind/category filter pages (e.g. `/mega-menu`, `/category/footers`), add them to
   `variants_from` / `elements_from` and run `bun tools/patterns.mjs --fetch-filters --only=<domain>`.
5. Write `catalog/patterns/<domain>.json` with `status: "hand"` (replace an `auto` file if one exists).
6. `bun tools/patterns.mjs --check <domain>` — the item count, % with an element and samples must look right.
   Fix and re-check until they do.
7. No `sitemap.json` for the site, or it's blocked → write a `skip` file with the reason.

## Do not
- Edit anything outside `catalog/patterns/<domain>.json` for domains in your batch (plus filter-page downloads that
  `--fetch-filters` makes).
- Run `bun tools/build.mjs`. Read `catalog/catalog.json`, `catalog/search-index.json` or `catalog/corpus/` whole.
- Spend more than ~10 minutes on one site: write `skip` with "needs a closer look: <why>" and move on.

## Done when — report as a table
| domain | pattern or skip | items | % with element | variants found | note |

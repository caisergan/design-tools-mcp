# Brief 08 — Small component sites: anchors, rendered pages, broken sitemaps

## Context
`/Users/egeayyildiz/Desktop/personal-projects/design-tools` maps UI/design websites down to individual component and
example pages, so an AI agent asking for "toggle" gets every toggle across all sites with a direct link. Each site has
a pattern file `catalog/patterns/<domain>.json`; `tools/sitemap-items.mjs` (`sitemapScan`) turns the site's sitemap
URLs (`catalog/corpus/sites/<domain>/sitemap.json`) plus links from cached index pages (`urls_from`, `variants_from`,
`elements_from` → `catalog/corpus/sites/<domain>/filters/*.html`, downloaded by `bun tools/patterns.mjs
--fetch-filters`) into items. Read `tools/sitemap-items.mjs`, `tools/patterns.mjs` and `tools/patterns.test.mjs` in
full first, and the pattern format in `briefs/phase-6/05-pattern-review-batch.md`.

About 30 real but **small** component sites could not be mapped and were written as `skip` files, for four reasons:
1. **Client-rendered index pages.** The raw HTML has no links; a browser sees them. Checked 2026-10-07:
   `cssnippets.shefali.dev` raw HTML 4 links, rendered DOM 42 (`/buttons /cards /checkbox /dropdown /toggle …`).
2. **One-page libraries.** Every component is a section of one page, reached by `#anchor` (circleloaders: 25
   anchors; blobatar, vibeui, kinetics, shadcn-font-picker …). Patterns ignore anchors today, and
   `normalizeUrl` in `tools/lib.mjs` drops `#hash`, so such items would all collapse into one URL.
3. **Broken or redirected sitemaps.** `dycomps.oimmi.com`'s sitemap has locs with no host
   (`https://templates/c-blocks/...`), so `tools/sitemaps.mjs` saved nothing. `nsui.irung.me` 301s to `tailark.com`
   (its own catalog entry `tailark-com`, no pattern yet); `vibecodecomponents.com` points to `vibecomponents.com`.
4. Blocked / unreachable (ui8 403, two time-outs) — nothing to do; leave those skips.

Also: the guesser (`--suggest` / `--auto`) only considers path prefixes with ≥ 10 children, so a small site never gets
an automatic pattern.

Runtime: `bun`, plain ESM, no npm dependencies. Network: ≤ 2 requests/s per host, user agent
`Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)`, no auth headers, results cached so the build is offline.

## What to build

### 1. Anchor items — pattern option `anchors_from`
```jsonc
{ "anchors_from": ["/"], "granularity": "variant", "element": "loader", "status": "hand", "note": "…" }
```
- `--fetch-filters` downloads each `anchors_from` page once (cache `filters/anchors-<n>.html`, or the rendered cache
  below when `render: true`).
- The build collects in-page sections: elements with an `id` that are headings (`h1`–`h4`) or `section` / `article`
  / `div` with a heading inside, and same-page `href="#…"` links. Name = heading / link text (else the humanised id).
  Drop generic ids (`top`, `main`, `content`, `nav`, `footer`, `header`, `root`, `__next`, `app`, tab/aria noise like
  `radix-*`, `headlessui-*`, ids that are mostly digits/hashes).
- Item url = `<page url>#<id>`; id = `<parent id>/<slug(id)>`. Dedupe against `taken` by **id and full url
  including the hash** — do not run these urls through `normalizeUrl` (it drops the hash). Elements and variants as
  for other sitemap items (`element` fixed, else `tagItem` on the name).
- Optional `anchors_exclude: ["#pricing", …]`.

### 2. Rendered fetch — `"render": true`
- On a pattern, `"render": true` makes `--fetch-filters` load its `urls_from` / `variants_from` / `elements_from` /
  `anchors_from` pages in headless Chrome instead of plain `fetch`, and cache the **result**, not the HTML:
  `filters/rendered-<key>.json` = `{ url, fetched_at, links: [absolute hrefs], anchors: [{ id, text }] }`.
- Use the `chrome-devtools-axi` CLI (installed on this machine) through `Bun.spawn`, with
  `CHROME_DEVTOOLS_AXI_SESSION=catalog-render` so it never touches the user's own browser session:
  `open <url>` → `wait 3000` → `eval '(() => { … return JSON.stringify({ links, anchors }); })()'` → at the end
  `stop`. The `eval` output is `result: "<JSON string>"`; parse it. Wrap the JS in an IIFE (a bare `const …` errors).
  One page at a time, ≥ 1 s between pages of one host.
- If `chrome-devtools-axi` is missing or fails, print a warning and skip that page; never fail the build. The build
  (`sitemapScan`, `bun tools/items.mjs --dry`) reads only the caches.

### 3. Sitemap fixes — `tools/sitemaps.mjs`
- A loc with no real host (`https://templates/c-blocks/x`, `/c-blocks/x`, `c-blocks/x`) is resolved against the
  domain being fetched (`https://<domain>/templates/c-blocks/x` — check which form gives a 200 for dycomps) instead
  of being dropped. Count these as `host_repaired` in the domain's `sitemap.json`. Unit test.
- Re-fetch just the affected domain: `bun tools/sitemaps.mjs --only=dycomps.oimmi.com --refresh`.

### 4. Redirected domains — pattern option `source_domain`
- `"source_domain": "tailark.com"` makes `sitemapScan` / `--fetch-filters` read that domain's `sitemap.json` and
  filter caches (and resolve relative links against it); item urls point to the real domain.
- If the target domain is its own catalog entry (check with `jq` on `catalog/catalog.json`, e.g. `tailark-com`),
  write the pattern for the **target** entry instead, and turn the old domain's file into
  `{ "skip": "covered by <target domain>", "status": "hand" }`. Download a missing target sitemap with
  `bun tools/sitemaps.mjs --only=<target>`.

### 5. Guesser — small sites
In `tools/patterns.mjs` (`suggest`), a prefix with **3–9** children counts too when its last literal segment is a
component segment (`COMPONENT_SEGMENT` from `tools/items.mjs`) or an element id/alias; it is still never high
confidence below 10 children unless ≥ 60 % of the children tag to an element. Tests for both sides.

### 6. Re-review the technical skips
For each of these domains, use the new options where they fit and replace the `skip` file with a `hand` pattern; keep
the skip (update its reason if needed) when the site really has no per-component pages or is blocked:

acrobatreaderonline.com, ai-animate.vercel.app, animationweb.app, animista.net, blobatar.dev, circleloaders.dominikakissi.com,
cssnippets.shefali.dev, cuedesign.space, dycomps.oimmi.com, functional-snowflake-663.notion.site, kinetics.colorion.co,
motionsites.ai, nsui.irung.me, orbkit.zzzzshawn.cloud, ozanoz.notion.site, patterncraft.fun, shadcn-font-picker.vercel.app,
shop.ui8.net, simply-buttons.vercel.app, ssv5.templates.guylahav.com, tailwindtoolbox.com, vibecodecomponents.com,
vibeui.online, xsgames.co

(`jahed.21st.dev` is covered by the 21st.dev adapter — leave it.) For each site: look at the page with `curl` (status +
`<title>` + link/anchor counts, never whole pages into your context), then with the rendered fetch if the raw HTML is
empty, write the pattern, run `bun tools/patterns.mjs --check <domain>` and fix until the items look right. Spend at
most ~10 minutes per site.

## Tests — add to `tools/patterns.test.mjs` / `tools/sitemaps.test.mjs` (no network, fixtures inline)
Anchor extraction from a fixture HTML (headings with ids, `#` links, generic ids dropped), anchor items keep their
`#hash` in the url and do not collapse in dedupe; rendered-cache JSON feeds `urls_from` and `anchors_from` exactly as
HTML does; `source_domain` reads the other domain's sitemap; host-less sitemap locs are repaired; the small-site
guesser rule (5 children under `/components/` → suggested, low confidence; 5 children under `/blog/` → not).

## Do not
- Edit `tools/mcp.mjs`, `tools/search.mjs`, `tools/items.mjs` (importing its exports is fine), `catalog/catalog.json`,
  `catalog/taxonomy.json`, or pattern files of domains not listed in step 6 (except a redirect target per step 4).
- Run `bun tools/build.mjs`. Read `catalog/catalog.json`, `catalog/search-index.json` or `catalog/corpus/` whole.
- Use the user's own Chrome profile or session.

## Done when
- `bun test ./tools` passes.
- Report as a table: domain | pattern or skip | technique (anchors / render / host repair / source_domain / plain) |
  items | % with element | note. Plus: total new items, and which of the four reasons each remaining skip falls under.

# Brief 10 — Sites brief 09 found reachable: redirects, revived hosts, one rendered index

## Context
`/Users/egeayyildiz/Desktop/personal-projects/design-tools` maps UI/design websites down to individual component and
example pages, so an AI agent asking for "toggle" gets every toggle across all sites with a direct link. Each site has
a pattern file `catalog/patterns/<domain>.json`. `tools/sitemap-items.mjs` (`sitemapScan`) turns the sitemap URLs in
`catalog/corpus/sites/<domain>/sitemap.json`, plus links from cached index pages, into items. Read first:
- `briefs/phase-6/05-pattern-review-batch.md`: pattern format and the review method you follow for every site.
- `briefs/phase-6/08-small-component-sites.md` and `briefs/phase-6/reports/08.md`: `source_domain` (a domain that
  redirects elsewhere reads the target's corpus folder), `render: true` (index pages rendered with
  `chrome-devtools-axi`), `urls_from`.
- `briefs/phase-6/reports/09a.md` and `09b.md`: the probe results and **draft patterns** for every site below.

Brief 09 found these sites give zero items today **without being blocked**. Plain `curl` reaches every one. Some
redirect to another domain, and `tools/sitemaps.mjs` keeps only in-domain URLs, so their sitemap came out empty. Two
were dead in September and are back. One needs its index rendered. No Scrapling is needed here.

Runtime: `bun`, no npm dependencies. Network: ≤ 2 requests/s per host, user agent
`Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)`.

## Sites

| catalog domain | content lives on | 09 draft | what to do |
| --- | --- | --- | --- |
| `ui.beste.co` | `beste.dev` | 09b §2 | `source_domain`; sitemap index → blocks/pieces/components |
| `library.relume.io` | `www.relume.ai` | 09b §2 | `/components/{name}` only (the React mirror and `/ja/` are duplicates) |
| `mocku.co` | `mocku.com` | 09b §2 | **only the 117 `/mockups/{name}` roots**, `granularity: "example"`; the 1,673 generated variants are noise |
| `cuedesign.space` | `kit.cuedesign.space` | 09b §2 | `source_domain`; 54 `/components/{name}` |
| `mobbin.design` | `mobbin.com` | 09a §2.6 | explore families + `/explore/screens/<uuid>` via `urls_from`; leave `/colors/*` out (colour-name pages, not UI) |
| `figcomponents.com` | itself | 09a §2.8 | `urls_from` (`/`, `/category`, `/collection`); no sitemap |
| `designsystem.line.me` | itself | 09a §2.5 | `render: true` + `urls_from: ["/LDSG/components"]` |
| `raivcoo.com` | itself | 09a §2.9 | see below: the URLs are UUIDs |

## Steps
1. **Which catalog entry owns the items.** For each row, find the catalog entries of both domains:
   `jq -r '.items[] | select(.domain=="<d>") | [.id,.kind,.url] | @tsv' catalog/catalog.json`. That is the one
   allowed whole-catalog read, through `jq` only. If the target domain (`mobbin.com`, `www.relume.ai`, `beste.dev`,
   …) has its **own `site` entry**, write the pattern on the target domain's file. The source domain gets a skip:
   `{ "skip": "redirects to <target>; covered by catalog/patterns/<target>.json", "status": "hand" }` (same as
   brief 08's `nsui.irung.me`). Otherwise write the pattern on the catalog domain with `"source_domain": "<target>"`.
2. **Download the target sitemaps:**
   `bun tools/sitemaps.mjs --only=beste.dev,www.relume.ai,mocku.com,kit.cuedesign.space,mobbin.com,raivcoo.com`.
   Check each `catalog/corpus/sites/<d>/sitemap.json` count against the 09 report (beste ≈ 3,854 locs in the item
   families, relume 7,023, mocku 1,983, kit 55, mobbin 3,130, raivcoo 2,780). If a count is far off, find out why
   before writing the pattern.
3. Write each pattern (start from the 09 draft, then follow brief 05's steps 1–6). Run
   `bun tools/patterns.mjs --fetch-filters --only=<domain>` where the pattern has `urls_from`/`render`, and
   `bun tools/patterns.mjs --check <domain>` until the count, element % and sample names look right.
   For `render: true`, run with `CHROME_DEVTOOLS_AXI_SESSION=catalog-render`, as brief 08 did.
4. **raivcoo.com.** Its items are `/media/<uuid>`, so a URL-derived name would be a UUID, which is useless for
   search. Check whether the sitemap carries titles (`<image:title>`, `<video:title>`, `<news:title>`), or whether
   a listing page links the media with readable link text (`urls_from` takes names from link text?). Read
   `sitemapScan` to see. If neither gives readable names, write a skip: "media pages are UUID urls, no name
   source", and say what tool change would fix it.
5. `bun test ./tools` must pass (if anything fails, compare with a pristine run before blaming your changes).
6. `bun tools/items.mjs --dry` and note the total item count before and after your patterns.

## Item budget
The search index is 20.8 MB against a 25 MB limit, roughly 300 bytes per item. Keep every pattern to the item
families the table names. If a site would give > 4,000 items, stop and explain it in the report before writing the
pattern.

## Do not
- Edit any `tools/*.mjs` or `tools/scrapling/*`. If a site needs a tool change, write a skip that names the change.
- Edit pattern files of domains not in the table (except the target-domain file of step 1).
- Run `bun tools/build.mjs`. Read `catalog/search-index.json` or `catalog/corpus/` whole.
- Use Scrapling or any fetch that impersonates a browser; this brief is plain `fetch`/`curl` plus
  `chrome-devtools-axi` for the one render.

## Done when
- Report `briefs/phase-6/reports/10.md`, committed on your branch with the pattern files:
  table: catalog domain | pattern file written (own / target / skip-alias) | source | items | % with element |
  note. Then: sitemap counts from step 2, `items.mjs --dry` totals before → after, `bun test ./tools` result, and
  anything that differed from the 09 drafts and why.
- Last line of your final message: `PHASE6-DONE-10`.

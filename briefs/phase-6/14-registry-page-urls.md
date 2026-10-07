# Brief 14 — Page URLs for registry items (shadcnblocks first)

## Context
`/Users/egeayyildiz/Desktop/personal-projects/design-tools` maps UI/design websites down to individual components,
so an AI agent asking for "hero section" gets every hero with a **direct link**. Items come from adapters in
`tools/items.mjs`, in order: registry (`registry.json` + `items/`, best data: name, description, source), llms.txt
link lines, sitemap patterns (`tools/sitemap-items.mjs`, `sitemapScan`), the 21st.dev API. Read `tools/items.mjs`
and `tools/sitemap-items.mjs` in full, `tools/items.test.mjs` and `tools/patterns.test.mjs`, then the pattern
format in `briefs/phase-6/05-pattern-review-batch.md`.

**The gap.** 30,378 items come from registries, and only 1,097 of them have a `url`: the page a person opens to see
the component. The rest have `url: null`. The llms adapter already fixes this for its own links
(`tools/items.mjs` around line 182: *"the registry already has this component: the docs page becomes its url"*).
The sitemap adapter does not. When a sitemap page's id is already taken, `sitemapScan`
(`tools/sitemap-items.mjs`, `if (taken.has(id)) { skipped++; continue; }`) drops the page, URL and all.

**shadcnblocks.com** shows the cost. Catalog entry `www-shadcnblocks-com` has 4,171 registry items
(`catalog/items/www-shadcnblocks-com.json`, e.g. id `www-shadcnblocks-com/hero231`, `access: "gated"`,
`url: null`). Its sitemap (`catalog/corpus/sites/shadcnblocks.com/sitemap.json`, 4,850 URLs, plain fetch works)
has 2,028 `/block/<name>` pages, and every one of them matches a registry id. It also has 2,104 `/component/<name>`
pages, 321 `/blocks/<category>[/<sub>]` listings and 49 `/page/*`. robots.txt disallows `/r/`, `/api/`,
`/preview/`, `/explorer/*`; none of those is needed.

## What to build

### 1. Sitemap pages fill a missing url
In `sitemapScan`, when the id is already taken by an item whose `from` is `"registry"` and whose `url` is empty, set
that item's `url` to the page URL (same rule as the llms adapter). Count these as `urls_attached` in the scan stats
and print the count in `items.mjs`'s per-site report line. Everything else about a taken id stays as it is: no new
item, no name/element change, and the registry item keeps its `access`.
Tests: a taken registry item without a url gets the page url; one that already has a url keeps it; a taken
non-registry item is untouched.

### 2. `catalog/patterns/shadcnblocks.com.json`
- Check which catalog entry the items attach to (`www-shadcnblocks-com`, domain `www.shadcnblocks.com`, while the
  corpus folder is `shadcnblocks.com`). Look at how other `www.` sites are handled (`ls catalog/patterns | grep
  www`, `buildItems` domain lookup), then pick the file name and `source_domain` that make `--check` and the build
  see the sitemap.
- `match: ["/block/{name}", "/component/{name}"]`. Check that the `/component/` slugs line up with registry ids as
  well (they may use a different naming scheme; report the overlap). Pages with no registry twin become ordinary
  sitemap items, `granularity: "variant"`.
- Leave out `/blocks/*` listings, `/page/*`, `/template/*`, `/changelog/*`, `/docs/*`, `/blog/*`.
- `bun tools/patterns.mjs --check shadcnblocks.com` (or the file name you chose), then `bun tools/items.mjs --dry`:
  report urls attached and new items for this site.

### 3. Survey (report only, no more patterns)
For every catalog entry with registry items: count items without a url, check whether the entry's domain has
`catalog/corpus/sites/<domain>/sitemap.json` and a pattern file, and estimate how many of the url-less items a
sitemap pattern could fill (match registry item names against the last path segment of the sitemap URLs). Write
the top 25 by items-that-would-get-a-url, with the URL template that would do it. Use `jq`/small `bun -e` scripts.
Never print a whole sitemap or items file.

## Do not
- Edit `tools/mcp.mjs`, `tools/search.mjs`, `catalog/catalog.json`, `catalog/taxonomy.json`, or pattern files
  other than shadcnblocks.
- Run `bun tools/build.mjs` or `bun tools/index.mjs`. Read `catalog/search-index.json` or `catalog/corpus/` whole.
- Fetch anything from shadcnblocks beyond 5 spot checks (status + `<title>` with
  `curl -s -A "Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)"`), and nothing under the robots.txt
  disallows.

## Done when
- `bun test ./tools` passes (new tests included).
- `bun tools/items.mjs --dry` totals before → after: items, and registry items with a url (the `registry items
  with a docs url` line).
- Report `briefs/phase-6/reports/14.md`, committed on your branch with the code, tests and pattern: files changed,
  the shadcnblocks numbers (urls attached to registry items, new items, `/component` overlap, 5 sample items with
  their url), and the survey table (entry | registry items | without url | sitemap? | pattern? | fillable | template).
- Last line of your final message: `PHASE6-DONE-14`.

# Brief 11 — Scrapling as an opt-in fetch backend, pagination, uiverse.io

## Context
`/Users/egeayyildiz/Desktop/personal-projects/design-tools` maps UI/design websites down to individual component and
example pages. Pattern files `catalog/patterns/<domain>.json` turn sitemap URLs
(`catalog/corpus/sites/<domain>/sitemap.json`, downloaded by `tools/sitemaps.mjs`) and links from cached index pages
(`filters/*.html` / `filters/rendered-*.json`, downloaded by `bun tools/patterns.mjs --fetch-filters`) into items
(`tools/sitemap-items.mjs`, `sitemapScan`). Read first, in full: `tools/sitemaps.mjs`, `tools/sitemap-items.mjs`,
`tools/patterns.mjs`, `tools/patterns.test.mjs`, `tools/sitemaps.test.mjs`, `tools/scrapling/probe.py`, then
`briefs/phase-6/05-pattern-review-batch.md` (pattern format), `briefs/phase-6/09-scrapling-probe.md` and
`briefs/phase-6/reports/09a.md`.

Brief 09 tested [Scrapling](https://scrapling.readthedocs.io) 0.4.15. Four design sites block our Bun `fetch`
(403 / Cloudflare "Just a moment") but answer Scrapling:

| host | Scrapling mode that works | what it unlocks |
| --- | --- | --- |
| `uiverse.io` | `http` (Chrome TLS impersonation) | 10 category index pages, server-paginated at `?page=N` (~58 pages for buttons, 34–35 items each); no sitemap |
| `land-book.com` | `http` | sitemap index → 900 `/websites/<id>-<slug>` |
| `ui8.net` | `http` | sitemap, 17,021 product pages |
| `saasframe.io` | `stealth` (`solve_cloudflare=True`) | sitemap, 8,414 example/section/flow/pattern pages |

Only `uiverse.io` (open-source library) is enabled in this brief. The other three are commercial galleries: build the
config entries **disabled**. The owner decides later whether to enable them. Enabling must then take no code change.

Python: the shared venv `~/.venvs/scrapling` (Python 3.12, scrapling 0.4.15, browsers installed). Always run
`~/.venvs/scrapling/bin/python -I …`. No `pip install`, `uv pip install` or `scrapling install`.

## What to build

### 1. Opt-in host list — `catalog/scrapling-hosts.json`
```jsonc
{
  "uiverse.io":    { "mode": "http",    "enabled": true,  "note": "open-source element library; Bun fetch gets 403" },
  "land-book.com": { "mode": "http",    "enabled": false, "note": "commercial gallery behind Cloudflare; owner decision" },
  "ui8.net":       { "mode": "http",    "enabled": false, "note": "…" },
  "saasframe.io":  { "mode": "stealth", "enabled": false, "note": "…" }
}
```
A host matches itself and its `www.` form. Only `enabled: true` hosts ever use Scrapling.

### 2. Fetch helper — `tools/scrapling/fetch.py`
- `fetch.py --mode http|stealth|dynamic --out-dir DIR URL [URL …]`. Fetch each URL with the matching Scrapling
  fetcher (one browser session for the whole call in `stealth`/`dynamic`, `headless=True`, `solve_cloudflare=True`
  only in `stealth`). Write the body to `DIR/<n>.body` and print one JSON line per URL to stdout:
  `{url, final_url, status, bytes, file, error?}`.
- Reuse `allowed()` (robots.txt, `User-agent: *`) and `pace()` (≥ 1 s per host) from `probe.py`: import them or
  move them into a small shared module. A disallowed URL gets `{url, status: 0, error: "robots"}`.
- Fix the challenge false positive brief 09 found while you are there. `probe.py`'s `CHALLENGE` regex matches the
  `/cdn-cgi/challenge-platform/scripts/jsd/main.js` beacon and i18n strings like `"Access Denied"` inside real
  pages. A page is a challenge only if its `<title>` is "Just a moment..." / "Attention Required", **or** its status
  is 403/503 **and** it carries a challenge marker. Apply the same rule to `isChallenge` in `tools/sitemaps.mjs` if it
  has the same flaw, with a test.

### 3. Hook into the two Bun fetchers
- `tools/sitemaps.mjs` (`rawGet`) and `tools/patterns.mjs` (`get`, used by `--fetch-filters`): when the URL's host is
  enabled in `catalog/scrapling-hosts.json`, fetch through `fetch.py` (`Bun.spawn`) instead of `fetch`, and hand
  back the same result shape the callers already expect. Batch URLs per host into one `fetch.py` call where the
  caller allows; one call per URL is acceptable if batching complicates the code.
- If the venv or `fetch.py` is missing or fails, print one warning and fall back to the current `fetch`
  behaviour. Never crash the run.
- The host keeps today's limits (≤ 2 req/s, `MAX_BAD` blocking, size cap). Disabled and unlisted hosts behave exactly
  as before (test this).

### 4. Pagination for index pages — pattern option `paginate`
```jsonc
{ "elements_from": { "button": "/buttons", "card": "/cards" }, "paginate": { "param": "page", "max": 80 } }
```
- Applies to every `urls_from` / `variants_from` / `elements_from` job of the pattern. `--fetch-filters` fetches
  `<path>?page=2`, `?page=3`, … (merging with an existing query string) after the first page. It stops at `max`,
  or at the first page that adds **no new** links matching the pattern. Cache each page next to the first one, with
  a suffix the loader can glob (e.g. `filters/e-button.html`, `filters/e-button-p2.html`, …).
- `loadFilters` / `sitemapScan` read all pages of a job, and items keep the job's element/variant.
- `validatePattern` accepts `paginate: {param: string, max: 1–500}` and rejects anything else. Add tests: page
  caching names, stop on no-new-links, element carried from paginated pages, validation.

### 5. `catalog/patterns/uiverse.io.json`
- Find the uiverse catalog entry: `jq -r '.items[] | select(.domain=="uiverse.io") | [.id,.kind,.url] | @tsv'
  catalog/catalog.json`.
- Items are `/{author}/{name}` element pages (e.g. `/adamgiebl/soft-gecko-85`). The slug names nothing, so the
  element must come from the category page: use `elements_from` with the categories mapped to taxonomy element ids
  (`jq -c '.elements[] | {id, aliases}' catalog/taxonomy.json`; `/buttons` → `button`, `/checkboxes` → `checkbox`,
  `/switches` → toggle/switch, `/loaders` → loader/spinner, `/inputs` → input, `/forms` → form, `/radio-buttons`
  → radio, `/tooltips` → tooltip, `/cards` → card, `/patterns` → background pattern if the taxonomy has it, else
  `urls_from`). Check the home page for further categories.
- Exclude non-item paths (`/profile/*`, `/blog/*`, `/fonts/*`, category pages themselves, …).
- Names: if `/{author}/{name}` gives "Purple Rattlesnake 49", prefer a name built from the element plus author
  (e.g. "Button by adamgiebl"). The `{author}` prefix rule in `sitemapScan` may already do most of this; check, and
  report what the names look like.
- `paginate: { "param": "page", "max": 80 }`. Run `bun tools/patterns.mjs --fetch-filters --only=uiverse.io`
  (≈ 10 categories × ~60 pages at ≤ 1 req/s ≈ 10–15 min), then `bun tools/patterns.mjs --check uiverse.io`. The
  item count must stay ≤ 20,000. If it would be higher, lower `max` and say so.

## Do not
- Enable `land-book.com`, `ui8.net` or `saasframe.io`, or fetch from them through the new hook. Unit tests use fakes,
  not the network.
- Log in, send cookies/auth headers, use proxies, CAPTCHA services, the user's Chrome profile or `cdp_url`.
- Edit pattern files other than `uiverse.io`, `catalog/catalog.json`, `catalog/taxonomy.json`, `tools/mcp.mjs`,
  `tools/search.mjs`, `tools/items.mjs`. Run `bun tools/build.mjs`. Read `catalog/corpus/` or the index whole.
- Add npm dependencies or Python packages.

## Done when
- `bun test ./tools` passes (new tests included; compare any failure against a pristine checkout).
- `bun tools/items.mjs --dry` runs; note total items before → after.
- Report `briefs/phase-6/reports/11.md`, committed on your branch with the code, config, pattern and tests:
  files changed (table), how the hook chooses Scrapling and falls back, `paginate` format, uiverse result (pages
  fetched, items, % with element, 10 sample names + URLs, minutes taken), the challenge-rule fix with before/after on
  the brief-09 false positives (ui8.net, colorkit.co, animationweb.app, cssloaders.colorion.co cached pages are in
  `~/.cache/design-tools-scrapling/t09a|t09b/`), and exactly what the owner must change to enable one of the three
  disabled hosts.
- Last line of your final message: `PHASE6-DONE-11`.

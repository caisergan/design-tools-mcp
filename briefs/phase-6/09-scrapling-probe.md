# Brief 09 — Scrapling test: do blocked and small sites open up?

## Context
`/Users/egeayyildiz/Desktop/personal-projects/design-tools` maps UI/design websites down to individual component and
example pages. Each site gets a pattern file `catalog/patterns/<domain>.json`, which turns the site's sitemap URLs or
links from its index pages into items (format: `briefs/phase-6/05-pattern-review-batch.md`; rendered pages and
`#anchor` sections: `briefs/phase-6/08-small-component-sites.md`, results in `briefs/phase-6/reports/08.md`).

The sites below give **zero items today**. Our fetchers are Bun `fetch` (plain HTTP) and `chrome-devtools-axi`
(an automated Chrome), and both failed on them: Cloudflare "Just a moment" pages and 403s, network errors, or
client-rendered pages without links. This brief is a **test**: does [Scrapling](https://github.com/D4Vinci/Scrapling)
(Python, v0.4.15) get through, and if so, what would each site give us? Do **not** wire anything into the
catalog. The coordinator decides afterwards whether Scrapling becomes a fetch backend.

Measured by the coordinator on 2026-10-07 (`curl` → 403 on every sitemap below):

| url | Scrapling `http` | Scrapling `stealth` |
| --- | --- | --- |
| land-book.com/sitemap.xml | 200, sitemap index (7 child sitemaps) | — |
| www.ui8.net/sitemap.xml | 200, 17,315 `<loc>` | — |
| saasframe.io/sitemap.xml | 403 "Just a moment" | 200, 8,834 `<loc>` |
| uiverse.io/buttons | 200, 82 own links | 200, same |
| uiverse.io/sitemap.xml | 404 (no sitemap) | — |

## Tools (already installed, do not reinstall)
- Python venv: `~/.venvs/scrapling` (Python 3.12, `scrapling[fetchers]` 0.4.15, browsers downloaded). Always run
  `~/.venvs/scrapling/bin/python -I …`. **No** `pip install`, `uv pip install` or `scrapling install`: if something is
  missing, stop and say so in the report.
- Probe script (read it first, it is short):
  `/Users/egeayyildiz/Desktop/personal-projects/design-tools/tools/scrapling/probe.py`.
  It lives in the main checkout, not in your worktree. Call it by that absolute path.
  ```sh
  P=/Users/egeayyildiz/Desktop/personal-projects/design-tools/tools/scrapling/probe.py
  ~/.venvs/scrapling/bin/python -I $P --modes http,stealth --cache ~/.cache/design-tools-scrapling/<agent> \
      --out briefs/phase-6/reports/09<x>-probe.jsonl https://example.com/ https://example.com/sitemap.xml
  ```
  Modes: `http` (Chrome-impersonated request, fast), `dynamic` (Playwright Chromium, renders JS), `stealth`
  (patched browser, solves Cloudflare Turnstile/interstitial). One JSON line per url × mode: `status`, `final_url`,
  `challenge`, `xml_locs`, `links`, `own_links`, `own_prefixes` (first two path segments → count), `id_sections`,
  `sample_ids`, `sample_own`, `cached` (raw HTML path). It honours robots.txt and waits ≥ 1 s between two
  requests to one host.
- For a follow-up the probe can't do (scrolling a page, clicking "load more", reading a child sitemap, counting
  `<loc>` per path prefix), write a small script `tools/scrapling/09<x>-<what>.py` in your worktree. It must use
  the same rules: Scrapling fetchers only, `allowed()` and `pace()` imported or copied from `probe.py`, and the
  same session settings (`headless=True`, stealth only with `solve_cloudflare=True`). Scrapling docs:
  https://scrapling.readthedocs.io (fetchers, `page_action` for scrolling/clicking).
- `chrome-devtools-axi` is **not** part of this test. Brief 08's rendered results (in `reports/08.md` and the skip
  reasons in `catalog/patterns/<domain>.json`) are the baseline to compare against.

## Method — per domain
1. Read its current state: `catalog/patterns/<domain>.json` if it exists (the skip reason), and
   `catalog/corpus/sites/<domain>/` (`sitemap.json`, `filters/`) if present. Do not edit either.
2. `http` first: home page, `/sitemap.xml` (and a sitemap named in robots.txt), plus the 1–3 index pages that
   should list components/examples (look at the home page's `own_prefixes`).
3. Only where `http` fails (403, `challenge: true`, network error, or a JS shell with ~0 own links) → `stealth`.
   For set B, also run `dynamic` on the index pages, and `stealth` if `dynamic` shows nothing new.
4. If a sitemap index comes back, fetch its child sitemaps (all of them if ≤ 10, otherwise the 10 most
   relevant-looking) and count `<loc>` per first path segment.
5. Decide: **unlocked** (Scrapling reaches per-component or per-example URLs we could not reach before),
   **reachable but nothing to map** (the page loads, but it holds no per-item URLs or sections: the brief-08 skip
   reason still applies), **still blocked**, or **dead** (DNS/connection failure in every mode).
6. For every **unlocked** domain, draft the pattern you would write (JSON, in the report only, **not** in
   `catalog/patterns/`), give the expected item count, 5 example item URLs, and the minimal mode that works
   (`http` < `dynamic` < `stealth`).

Limits: ≤ 30 page fetches per domain (sitemap files don't count), never fetch the item pages themselves beyond
5 spot checks per domain, one Scrapling browser session at a time.

## Set A — agent `t09a`: walled and "dead" design sites (31)
Cloudflare/403 (focus on `stealth`): `uiverse.io` (no sitemap: map the category index pages, e.g. `/buttons`,
`/cards`, `/checkboxes`, `/switches`, `/loaders`, `/inputs`, `/forms`, `/patterns`, `/radio-buttons`, `/tooltips`.
Do they load more cards on scroll?), `land-book.com`, `ui8.net` (+ `shop.ui8.net`, which 302s to it), `saasframe.io`,
`colorkit.co`, `colorhexa.com`, `document.body.style`, `designsystem.line.me` (start at `/LDSG/components`),
`savee.it`, `mobbin.design`, `xdguru.com`, `umanmade.com`, `fwa.com`.

Marked dead on 2026-09-23 (network/timeout/5xx). Recheck with `http`, use `stealth` only if `http` gets a
response that looks blocked: `sv-efferd.pages.dev`, `styleshift.shefali.dev`, `loading-state-zoo.pages.dev`,
`figcomponents.com`, `free-css.com`, `shadcnui-templates.com`, `x4m1k.com`, `syncui.design`, `blobmaker.app`,
`ui.gradients.com`, `ikonate.com`, `kinetik.ink`, `videorc.com`, `shotbase.website`, `guidetouxr.com`,
`raivcoo.com`, `acrobatreaderonline.com`, `ssv5.templates.guylahav.com`.

Mobbin, Savee and UI8 hold content behind accounts. Map only what an anonymous visitor sees; a login wall counts as
**still blocked** (reason `login`).

## Set B — agent `t09b`: small sites that brief 08 could not map (18)
Client-rendered or one-page (compare with brief 08's `chrome-devtools-axi` result in the skip reason):
`ai-animate.vercel.app`, `animationweb.app`, `cuedesign.space`, `kinetics.colorion.co`, `motionsites.ai`,
`orbkit.zzzzshawn.cloud`, `ozanoz.notion.site`, `patterncraft.fun`, `shadcn-font-picker.vercel.app`,
`functional-snowflake-663.notion.site`, `xsgames.co` (start at `/animatiss`), `tailwindtoolbox.com`.

Empty sitemap, no pattern file yet: `cssloaders.colorion.co`, `ui.beste.co`, `library.relume.io`, `mocku.co`,
`tinte.railly.dev`, `type-scale.com`.

For set B the question is narrower: does `dynamic`/`stealth` (with scrolling via `page_action` where a page loads
lazily) show own-domain item links or `id` sections that brief 08's render did not? Report "same as brief 08" when
nothing changes. That is a valid answer.

## Do not
- Edit anything under `catalog/` (patterns, corpus, sitemaps-report), `tools/*.mjs`, `tools/scrapling/probe.py`,
  or other briefs/reports. `catalog/corpus` in your worktree is a symlink to the shared corpus. Never write into it.
- Run `bun tools/build.mjs`, `bun tools/sitemaps.mjs`, `bun tools/patterns.mjs --fetch-filters`.
- Log in, send cookies or auth headers, use the user's Chrome profile or a running browser (`cdp_url`), proxies, or
  any paid CAPTCHA service. `solve_cloudflare=True` is the only challenge handling allowed.
- Fetch robots.txt-disallowed paths, exceed the limits above, run more than one browser session at a time, or run
  browsers headful.
- Commit raw HTML. The cache stays in `~/.cache/design-tools-scrapling/<agent>/`.

## Done when
- Every domain of your set has a row in the report, and its probe lines are in `briefs/phase-6/reports/09<x>-probe.jsonl`.
- Report `briefs/phase-6/reports/09<x>.md` (`x` = `a` or `b`), committed on your branch together with the jsonl and
  any `tools/scrapling/09<x>-*.py` helpers:
  1. Table: domain | before (today's reason) | verdict (unlocked / nothing to map / still blocked / dead) | minimal
     mode | what Scrapling reached (sitemap N locs / index N own links / N id sections) | expected items | note.
  2. One section per **unlocked** domain: draft pattern JSON, 5 example item URLs, expected item count, and how
     the item list would be gathered (sitemap vs index pages vs scroll).
  3. Totals: unlocked domains, expected new items, average seconds per page per mode, and how often `http` alone
     was enough vs. `stealth` was needed.
  4. Problems met (Scrapling errors, time-outs, robots disallows), with the exact error text.
- Last line of your final message: `PHASE6-DONE-09<X>` (`09A` or `09B`).

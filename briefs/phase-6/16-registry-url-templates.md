# Brief 16 — Page URLs for registry items without a sitemap page

Four agents work on this brief at the same time:
- **16a** builds the engine (part 1 below) and pilots it on animate-ui.com, kibo-ui.com, retroui.dev.
- **16b, 16c, 16d** investigate one batch of sites each (part 2) and write config files in the format below. The
  engine does not exist on their branches yet: they verify by hand with `curl`, and the coordinator runs the full
  verification after everything is merged.

## Context (everyone)
`/Users/egeayyildiz/Desktop/personal-projects/design-tools` maps UI/design websites down to individual components,
so an AI agent asking for "hero section" gets every hero with a **direct link** to the page where a person sees it.
Many components come from shadcn-style registries (`catalog/corpus/sites/<domain>/registry.json`): name,
description and install URL, but often no page url. Briefs 14–15 filled 15k of those urls from sitemap pages
(read `briefs/phase-6/reports/14.md` §1–2 and the summary of `briefs/phase-6/reports/15b.md`). **13,578 registry
items of page types (ui, component, block, example) are still url-less** across 58 entries; their pages are not in
any sitemap we have — the site has no sitemap, moved to another domain, or keeps pages under a path the sitemap
does not list.

Words: an **entry** is one catalog site (`catalog/catalog.json` `.items[]`, fields `id`, `domain`, `url`); its
**registry items** live in `catalog/items/<entry id>.json` (fields `id` = `<entry id>/<slug>`, `slug`, `names`,
`type`, `url`, `from: "registry"`). The registry name of an item is its `slug` (fall back to the id after the
`<entry id>/`). Never print a whole items, registry or sitemap file — use `jq` with `head`.

## The config format — `catalog/registry-urls/<domain>.json` (everyone)
`<domain>` is the entry's `domain` field (= the corpus folder).
```jsonc
{
  "templates": [                                   // absolute urls, tried in order; the first verified one wins
    "https://animate-ui.com/docs/components/{name}",
    "https://animate-ui.com/docs/primitives/{name}"
  ],
  "rewrite": [["^components-animate-", "animate/"]], // optional: [JS regex, replacement] pairs applied in order to
                                                   // the registry name before it fills {name}; "$1" works
  "types": ["registry:ui", "registry:component", "registry:block", "registry:example"], // optional, this default
  "status": "hand",
  "note": "what one page is, which names map where, what stays url-less and why"
}
```
or `{ "skip": "reason", "status": "hand" }` when the site has no page per component (an icon set on one gallery
page, illustrations in one grid, a dead site). A **group page** is allowed: when variants such as
`accordion-default` / `accordion-collapsible` are shown on their component's page `/components/accordion`, a
rewrite to the group name is fine — say so in `note`. A link to the site's home page or a listing is not.

---

## Part 1 — engine (agent 16a only)
Read first: `tools/items.mjs` (`buildItems`, `registryItems`, `llmsItems`), `tools/patterns.mjs` (how `--check`
and `--fetch-filters` fetch: user agent, pacing, Scrapling hosts via `tools/scrapling-backend.mjs`),
`tools/sitemaps.mjs` (`UA`), `tools/lib.mjs`, and the tests `tools/items.test.mjs`, `tools/patterns.test.mjs`.

### 1. `tools/registry-urls.mjs` (new)
- `loadRegistryUrlConfig(domain)` + `validateRegistryUrlConfig(cfg, domain)`: the format above; unknown keys,
  non-absolute or non-https templates, a template without `{name}`, an invalid regex → a clear error.
- `candidates(name, cfg)` (pure): the rewritten name filled into each template, in order, deduped.
- `bun tools/registry-urls.mjs --verify <domain>[,<domain>…] | --all`: for every **url-less** registry item of the
  entry whose `type` is in `types` (take the state *after* the sitemap and llms adapters: `buildItems(entries,
  { only: domain })`), try its candidates in order and keep the first that passes:
  - GET with redirects followed, the catalog UA (`UA` from `tools/sitemaps.mjs`), 15 s timeout; for a host enabled
    in `catalog/scrapling-hosts.json` use the Scrapling client the way `tools/patterns.mjs` does.
  - **Passes** when the final status is 200, the content type is html, and the final url is not the site root or a
    path the template did not produce (a redirect to `/`, `/components`, `/docs` = miss).
  - **Soft-404 guard:** before a domain's run, fetch each template once with the name `zz-design-tools-probe-404`.
    If that answers 200 html, remember its `<title>`; a candidate whose `<title>` equals it is a miss.
  - robots.txt: read once per host; a candidate under a `Disallow` for `*` is never fetched.
  - Pacing ≤ 2 requests/s per host, ≤ 4 hosts in parallel (`pool` in `tools/lib.mjs`); a host that answers 403/429
    three times in a row is stopped for this run and reported.
  - Write `catalog/corpus/sites/<domain>/registry-urls.json`:
    `{ "checked_at", "config_hash", "results": { "<item id>": "<url>" | null }, "stats": {…} }`. A re-run checks
    only ids missing from `results`, unless `config_hash` changed (then all of them). `--force` rechecks all.
  - Print per domain: items tried, urls found, misses, soft-404 hits, stopped hosts, requests made, time.
- `bun tools/registry-urls.mjs --check <domain>`: validates the config, prints the candidates of 5 items with
  different name shapes, and verifies 10 random items live (nothing written). This is what batch agents will use
  next time.

### 2. Wire it into the build
In `buildItems` (`tools/items.mjs`), after the sitemap and api adapters: a url-less registry item takes the url
from `catalog/corpus/sites/<domain>/registry-urls.json` `results[item.id]` when it is a string. Nothing else about
the item changes. Count these per site (`urls from templates`) in the per-site report line the way `urls_attached`
is printed. A missing or broken cache file is a warning, never a build failure.

### 3. Tests (no network)
Validation errors; `candidates` (rewrite order, `$1`, dedupe); the pass/miss decision as a pure function (status,
content type, final url vs root, soft-404 title); robots `Disallow` matching; resume (ids already in `results` are
skipped, a changed `config_hash` rechecks); the build fill (a cached url fills a url-less registry item, never one
that has a url, never a non-registry item).

### 4. Pilot
Write configs for **animate-ui.com, kibo-ui.com, retroui.dev**, then `--verify` them. Report per site: items
tried, urls found, 3 found urls with status + `<title>`, what stayed url-less and why.

### Do not (16a)
Edit `tools/mcp.mjs`, `tools/search.mjs`, `catalog/catalog.json`, pattern files, or configs of other sites. Run
`bun tools/build.mjs` / `bun tools/index.mjs`, or `--verify` / `--all` on anything but the three pilot sites.

### Done when (16a)
`bun test ./tools` passes; the three pilots verified; `bun tools/items.mjs --dry` shows their `urls from templates`
counts; report `briefs/phase-6/reports/16a.md` (files changed, design decisions, pilot table, request counts)
committed with the code. Last line of your final message: `PHASE6-DONE-16A`.

---

## Part 2 — site batches (agents 16b, 16c, 16d)
Your batch is the rows of the table at the end marked with your letter. For each site:

1. **Look** (≤ 8 requests per site, `curl -sL -m 15 -A "Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)"`,
   print only status, final url (`-w '%{http_code} %{url_effective}'`) and `<title>`):
   the entry url — did it redirect to another domain? — then `robots.txt`, then the home page's links that contain
   a registry name (`grep -o 'href="[^"]*"'` filtered by a few names; never print the page). Compare with
   `jq -r '.items[].name' catalog/corpus/sites/<domain>/registry.json | head -40` and, if it exists,
   `jq -r '.urls[].loc' catalog/corpus/sites/<domain>/sitemap.json | head -60`.
2. **Pick a route** (A and B may be combined: A first, B for the rest):
   - **A — sitemap.** The site (or the domain it moved to) has a sitemap that lists the component pages. If it
     moved, fetch the new domain's sitemap: `bun tools/sitemaps.mjs --only=<new domain>`. Write
     `catalog/patterns/<domain>.json` with `"attach_only": true` (and `"source_domain": "<new domain>"` if it
     moved) — the pattern format is in `briefs/phase-6/05-pattern-review-batch.md`, how ids are built in
     `briefs/phase-6/reports/14.md` §2. If a hand pattern already exists, only **add** match templates; keep the
     rest. Check with `bun tools/patterns.mjs --check <domain>` (`registry items … urls attached … still without`).
   - **B — template.** The page url is the registry name in a fixed path. Write `catalog/registry-urls/<domain>.json`
     (format above). Spot-check 5 names of different shapes with curl (status 200 and a `<title>` naming that
     component). Also request one made-up name (`zz-design-tools-probe-404`) through the same template: if it
     answers 200 the site soft-404s — say so in `note`.
   - **C — skip.** `catalog/registry-urls/<domain>.json` with `{"skip": "…", "status": "hand"}`.
3. Count what you expect each route to fill (A: the `--check` number; B: matched names out of the url-less ones,
   estimated from your spot checks and the name shapes).

### Do not (16b–d)
Edit anything outside `catalog/patterns/<domain>.json` and `catalog/registry-urls/<domain>.json` for your batch's
domains, and your report. No `bun tools/build.mjs`, `bun tools/index.mjs`, `bun tools/fetch.mjs`; `sitemaps.mjs`
only with `--only=` for a moved site's new domain. No scraping beyond the request limit above; never a path that
robots.txt disallows.

### Done when (16b–d)
Every site in your batch has a route (A, B, C or a combination) and its files; `bun test ./tools` passes; report
`briefs/phase-6/reports/16<b|c|d>.md` committed with the files: table
`domain | url-less items | route | files | expected fill | spot checks (5 × status + title) | notes`, totals, and
anything you were unsure about. Last line of your final message: `PHASE6-DONE-16B` / `-16C` / `-16D`.

## Batch table
Url-less registry items of types ui/component/block/example (index/utils/style/base names left out), 2026-10-10.
`sitemap` = `catalog/corpus/sites/<domain>/sitemap.json` exists; `pattern` = `catalog/patterns/<domain>.json` exists.

| agent | entry | domain | entry url | url-less | sitemap | pattern |
| --- | --- | --- | --- | ---: | --- | --- |
| b | shadcn-ui-blocks-vercel-app | shadcn-ui-blocks.vercel.app | https://shadcn-ui-blocks.vercel.app | 4002 | – | – |
| c | undraw-cn-vaatun-com | undraw-cn.vaatun.com | https://undraw-cn.vaatun.com | 1362 | – | – |
| d | shadcnuikit-com | shadcnuikit.com | https://shadcnuikit.com | 932 | yes | – |
| b | uiable-com | uiable.com | https://uiable.com | 770 | yes | yes |
| c | tailark-com | tailark.com | https://tailark.com | 467 | yes | yes |
| d | icons-pqoqubbw-dev | icons.pqoqubbw.dev | https://icons.pqoqubbw.dev | 467 | – | – |
| b | canvasui-dev | canvasui.dev | https://canvasui.dev | 420 | yes | – |
| c | ui-flexnative-com | ui.flexnative.com | https://ui.flexnative.com | 418 | yes | yes |
| d | mynaui-com | mynaui.com | https://mynaui.com | 346 | – | – |
| b | heroicons-animated-vercel-app | heroicons-animated.vercel.app | https://heroicons-animated.vercel.app | 316 | – | – |
| c | www-ui-layouts-com | ui-layouts.com | https://www.ui-layouts.com | 279 | yes | yes |
| d | shadcnstore-com | shadcnstore.com | https://shadcnstore.com | 274 | yes | – |
| b | termcn-vercel-app | termcn.vercel.app | https://termcn.vercel.app | 245 | – | – |
| c | 7ovr-com | 7ovr.com | https://7ovr.com | 243 | yes | yes |
| d | efferd-com | efferd.com | http://efferd.com | 226 | yes | – |
| b | bundui-io | bundui.io | https://bundui.io | 149 | yes | yes |
| c | localmode-ai | localmode.ai | https://localmode.ai | 143 | yes | – |
| d | thegridcn-com | thegridcn.com | https://thegridcn.com | 139 | yes | – |
| b | platejs-org-docs-multi-select | platejs.org | https://platejs.org/docs/multi-select | 136 | – | – |
| c | reactbits-dev | reactbits.dev | https://reactbits.dev | 133 | yes | – |
| d | remocn-dev | remocn.dev | https://remocn.dev | 104 | yes | yes |
| b | magicui-design | magicui.design | https://magicui.design | 96 | yes | – |
| c | ui-soralabs-io-vn | ui.soralabs.io.vn | https://ui.soralabs.io.vn | 92 | – | – |
| d | dotmatrix-zzzzshawn-cloud | dotmatrix.zzzzshawn.cloud | https://dotmatrix.zzzzshawn.cloud | 91 | yes | – |
| b | agentcn-vercel-app | agentcn.vercel.app | https://agentcn.vercel.app | 76 | – | – |
| c | sv-matrix-vercel-app | sv-matrix.vercel.app | https://sv-matrix.vercel.app | 73 | – | – |
| d | sv-animations-vercel-app | sv-animations.vercel.app | https://sv-animations.vercel.app | 67 | – | – |
| b | www-vengenceui-com | vengenceui.com | https://www.vengenceui.com | 67 | yes | yes |
| c | 1st-pouf-worksonmy-dev | 1st-pouf.worksonmy.dev | https://1st-pouf.worksonmy.dev | 57 | – | – |
| d | reui-io | reui.io | https://reui.io | 55 | yes | yes |
| b | fluid-functionalism-vercel-app | fluid-functionalism.vercel.app | https://fluid-functionalism.vercel.app | 53 | – | – |
| c | shuip-plvo-dev-docs | shuip.plvo.dev | https://shuip.plvo.dev/docs | 52 | – | – |
| d | simple-ai-dev | simple-ai.dev | https://simple-ai.dev | 49 | – | – |
| b | ui-8starlabs-com | ui.8starlabs.com | https://ui.8starlabs.com | 47 | yes | yes |
| c | more-shadcn-noair-fun | more-shadcn.noair.fun | https://more-shadcn.noair.fun | 43 | – | – |
| d | beui-dev | beui.dev | https://beui.dev | 42 | yes | – |
| b | smoothui-dev | smoothui.dev | https://smoothui.dev | 41 | yes | yes |
| c | www-shadcnblocks-com | shadcnblocks.com | https://www.shadcnblocks.com | 39 | yes | yes |
| d | eldoraui-site | eldoraui.site | https://eldoraui.site | 36 | yes | – |
| b | niko-table-com | niko-table.com | https://niko-table.com | 33 | – | – |
| c | shadcn-map-vercel-app | shadcn-map.vercel.app | https://shadcn-map.vercel.app | 32 | – | – |
| d | ui-aceternity-com | ui.aceternity.com | https://ui.aceternity.com | 30 | yes | – |
| b | ui-meta-cloud-api-site | ui.meta-cloud-api.site | https://ui.meta-cloud-api.site | 29 | – | – |
| c | www-tool-ui-com | tool-ui.com | https://www.tool-ui.com | 27 | – | – |
| d | beautiful-ui-five-vercel-app | beautiful-ui-five.vercel.app | https://beautiful-ui-five.vercel.app | 26 | – | – |
| b | beautifului-dev | beautifului.dev | https://beautifului.dev | 26 | – | – |
| c | www-launchuicomponents-com | launchuicomponents.com | https://www.launchuicomponents.com | 24 | – | – |
| d | sv-blocks-vercel-app | sv-blocks.vercel.app | https://sv-blocks.vercel.app | 23 | yes | yes |
| b | rareui-com | rareui.com | https://rareui.com | 20 | yes | – |
| c | sv-table-vercel-app | sv-table.vercel.app | https://sv-table.vercel.app | 17 | – | – |
| d | ui-inference-sh | ui.inference.sh | https://ui.inference.sh | 14 | – | – |
| b | flightcn-yencheng-dev | flightcn.yencheng.dev | https://flightcn.yencheng.dev | 13 | yes | – |
| c | shadcn-chatbot-kit-vercel-app | shadcn-chatbot-kit.vercel.app | https://shadcn-chatbot-kit.vercel.app | 11 | – | – |
| d | clerk-com-docs-elements-examples-shadcn-ui | clerk.com | https://clerk.com/docs/elements/examples/shadcn-ui | 11 | yes | – |
| b | wds-shadcn-registry-netlify-app | wds-shadcn-registry.netlify.app | https://wds-shadcn-registry.netlify.app | 10 | – | – |

Pilots (16a): animate-ui.com (420), kibo-ui.com (40), retroui.dev (54). shadcn-ui-blocks.vercel.app redirects to
www.shadcn-ui-blocks.com (checked 2026-10-10) — look for that domain's sitemap first.

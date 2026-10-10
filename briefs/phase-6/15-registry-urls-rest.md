# Brief 15 — Page URLs for the other registries (fill BATCH before handing out)

**BATCH:** see the batch table at the end. Agent 15a takes rows marked `a`, agent 15b rows marked `b`.

## Context
`/Users/egeayyildiz/Desktop/personal-projects/design-tools` maps UI/design websites down to individual components,
so an AI agent asking for "hero section" gets every hero with a **direct link**. Many of those components come from
shadcn-style registries (`catalog/corpus/sites/<domain>/registry.json`): good data (name, description, install
URL), but `url: null` — no page a person can open. Brief 14 (read `briefs/phase-6/reports/14.md` in full) made
sitemap pages fill that url: when a sitemap page's id equals a registry item's id, the item takes the page's url.
It did this for shadcnblocks.com (4,132 urls). Your job is the same for the registries in your batch.

Read first: `briefs/phase-6/reports/14.md`, `catalog/patterns/shadcnblocks.com.json` (a worked example), the pattern
format and the per-site steps in `briefs/phase-6/05-pattern-review-batch.md`, and in `tools/sitemap-items.mjs` the
functions `matchUrl`, `sitemapScan` (how an id is built from the captures) and `validatePattern`.

**New since brief 14 — `attach_only`** (commit 69ac3e7): with `"attach_only": true` a matched page that has no
registry twin makes **no item**; it only ever fills a url. Use it on every pattern in this brief unless a row's note
says otherwise. These sites' registries already hold every component; pages without a twin are listings, docs or a
second name for a component we already have, and the search index is over its size budget.

**How an id is built** (from brief 14): the page id is `<entry id>/<slug of the captures joined by "-">`, the
`{author}` capture first. So `/component/{author}/{name}` on `/component/accordion/accordion-form-1` gives
`…/accordion-accordion-form-1`. The registry item id is `<entry id>/<registry name>`. Your template has to rebuild
the registry's naming scheme from the URL. Check the scheme first: `jq -r '.items[].name' catalog/corpus/sites/<domain>/registry.json | head -30`
next to `jq -r '.urls[].loc' catalog/corpus/sites/<domain>/sitemap.json | head -60` (never print a whole file).

**Check command** — fast now (one domain, < 1 s):
`bun tools/patterns.mjs --check <domain>` prints, for a site with registry items,
`registry items: N · K urls attached by this pattern · M with a url · R still without · attach_only`. That line is
the number you are maximising. Iterate on the template until K stops growing, without false attaches (spot-check).

## For each site in your batch
1. Look at the registry names and the sitemap paths side by side (above). Find the URL shapes that carry a registry
   name, and how the name is built (plain leaf, `<category>-<leaf>`, `<leaf>-<category>`, a prefix/suffix such as
   `-demo`, a different slug).
2. Write `catalog/patterns/<domain>.json`: `match` (one template per shape), `"attach_only": true`,
   `"granularity": "variant"`, `"status": "hand"`, `note` (what the site is, which shapes attach, what stays out
   and why). The file name is the entry's **domain** from the batch table (= the corpus folder).
3. `bun tools/patterns.mjs --check <domain>`. If many items stay without a url, find out why (another shape, a
   naming difference, missing from the sitemap) and say so in the report — do not force it.
4. Spot-check 3 attached pages: `curl -s -o /dev/null -w '%{http_code}' -A "Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)" <url>`
   plus the `<title>` (`| grep -o '<title>[^<]*'`), and confirm the title is that component. Never pull whole pages
   into your context. Respect robots.txt (`curl -s https://<domain>/robots.txt`): no template may match a
   disallowed path.
5. If the sitemap has zero usable pages for the site, write no file and list it in the report with the reason.

## Rules for when `attach_only` may be dropped
Only if the site has a clear set of component pages the registry does not have (real, distinct components — not
listings, docs, or other names for registry items). Then drop it for that site, count the new items in the report,
and keep the total for your batch under 1,500 new items. Ask in the report rather than exceed it.

## Extra for agent 15a only — shadcn.io
- Its `sitemap.json` is **truncated** at the 50,000-URL cap (`"truncated": true`; 18.5k icon-tag pages and 15.5k
  icon pages ate the budget). Still, ~7.8k registry names already match. Do not refetch it.
  Fetch `https://shadcn.io/sitemap.xml` once (the index) and list in the report which sub-sitemaps were not
  reached (compare with `.sources[].url` in sitemap.json) and whether any of them would carry component pages.
- Expected shapes from the survey: `/blocks/{name}` (6,147) and `/view/<category>/<name>` pages (~3k, 14 shapes in
  total). Pick for each registry item the page that *is* that component: if one item matches two shapes, say which
  one the pattern prefers and why (the first matching page in sitemap order wins; order the `match` templates
  accordingly only if the engine respects it — check `matchUrl`, and say what you found).
- Templates must not touch `/icon*`, `/icons/*`, `/template*`, `/awesome/*`, `/tools/*`, `/design/*`.

## Do not
- Edit anything outside `catalog/patterns/<domain>.json` for the domains in your batch and your report.
  In particular not `tools/`, `catalog/catalog.json`, `catalog/taxonomy.json`, other pattern files.
- Run `bun tools/build.mjs`, `bun tools/index.mjs` or `bun tools/fetch.mjs`. Read `catalog/search-index.json` or
  a whole sitemap/registry file.
- Fetch more than 5 pages per site (robots.txt and the shadcn.io sitemap index not counted).

## Done when
- One pattern file per site in your batch (or a reason in the report why not), each `--check`ed.
- `bun test ./tools` passes.
- Report `briefs/phase-6/reports/15<a|b>.md`, committed on your branch together with the pattern files:
  table `domain | registry items | urls attached | still without | new items | templates | why the rest stays url-less`,
  totals, 3 spot-checked urls per site (status + title), anything you were unsure about.
- Last line of your final message: `PHASE6-DONE-15A` or `PHASE6-DONE-15B`.

## Batch table
Survey of 2026-10-10 (registry items without a url whose id matches a sitemap URL's last segment or
`<parent>-<leaf>`; an estimate — the real number comes from `--check`).

| agent | entry | domain | registry items | without url | estimated fillable |
| --- | --- | --- | --- | --- | --- |
| a | shadcn-io | shadcn.io | 7847 | 7847 | 7843 |
| a | reui-io | reui.io | 1728 | 1706 | 1647 |
| a | shadcncraft-com-components-filter-free | shadcncraft.com | 268 | 268 | 260 |
| b | ds-interlace-tools | ds.interlace.tools | 146 | 146 | 146 |
| b | smoothui-dev | smoothui.dev | 178 | 178 | 129 |
| b | www-8bitcn-com | 8bitcn.com | 121 | 121 | 119 |
| b | remocn-dev | remocn.dev | 313 | 212 | 104 |
| b | www-payload-components-xyz | payload-components.xyz | 82 | 82 | 82 |
| b | sv-blocks-vercel-app | sv-blocks.vercel.app | 98 | 98 | 75 |
| b | pdfcn-dev | pdfcn.dev | 79 | 79 | 68 |
| b | bundui-io | bundui.io | 217 | 217 | 68 |
| b | shadcnexamples-com | shadcnexamples.com | 70 | 70 | 68 |
| b | www-vengenceui-com | vengenceui.com | 132 | 132 | 65 |
| b | uiable-com | uiable.com | 829 | 829 | 59 |
| b | shadcn-hooks-com | shadcn-hooks.com | 58 | 57 | 57 |
| b | snapcn-dev | snapcn.dev | 59 | 52 | 48 |
| b | microkit-co | microkit.co | 47 | 47 | 47 |
| b | ui-flexnative-com | ui.flexnative.com | 450 | 450 | 32 |
| b | ui-manifest-build | ui.manifest.build | 32 | 32 | 30 |
| b | uselayouts-com | uselayouts.com | 26 | 26 | 24 |
| b | agent-elements-21st-dev | agent-elements.21st.dev | 25 | 21 | 20 |
| b | ui-trophy-so | ui.trophy.so | 18 | 18 | 17 |
| b | www-ui-layouts-com | ui-layouts.com | 324 | 288 | 15 |
| b | ui-8starlabs-com | ui.8starlabs.com | 62 | 62 | 15 |
| b | chanhdai-com | chanhdai.com | 67 | 30 | 12 |
| b | uibeats-com | uibeats.com | 55 | 10 | 10 |
| b | kokonutui-com | kokonutui.com | 51 | 14 | 9 |
| b | bucharitesh-in | bucharitesh.in | 17 | 17 | 9 |
| b | ui-shadcn-com | ui.shadcn.com | 63 | 7 | 6 |
| b | 7ovr-com | 7ovr.com | 248 | 248 | 4 |
| b | zippystarter-com-tools-shadcn-ui-theme-generator | zippystarter.com | 77 | 77 | 3 |

uiable.com (829 → 59) and ui.flexnative.com (450 → 32) match poorly on plain slugs; look at their naming before
writing them off. ui.shadcn.com and the `-com`/`-dev` personal sites may already serve most items through llms.txt
docs urls; only the url-less ones count.

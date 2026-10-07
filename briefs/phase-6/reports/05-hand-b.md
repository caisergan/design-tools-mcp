# Brief 05 report — pattern review batch, hand-B

Worktree `phase6-review-hand-b`, branch `phase6/review-hand-b`. Batch = 14 hand-picked component/gallery domains
(opensourceui.in, originkit.dev, reactvibe.com, screen.movie, shadcnadmin.com, sleek.design, supaste.com,
superset.sh, sv-particles.vercel.app, text-effects.colorion.co, toolcraft.sh, transitions.dev, ui-skills.com,
vibeprompts.dev). All 14 had a `sitemap.json` in the corpus, so no `urls_from` page was needed anywhere.
Every number below comes from `bun tools/patterns.mjs --check <domain>` / the same adapter called directly, on
2026-10-07.

## Files changed

| file | what |
| --- | --- |
| `catalog/patterns/opensourceui.in.json` (new) | hand pattern |
| `catalog/patterns/originkit.dev.json` (new) | hand pattern, 3 templates |
| `catalog/patterns/reactvibe.com.json` (new) | hand pattern, 8 templates |
| `catalog/patterns/shadcnadmin.com.json` (new) | hand pattern, 2 templates + 6 excludes |
| `catalog/patterns/sv-particles.vercel.app.json` (new) | hand pattern |
| `catalog/patterns/text-effects.colorion.co.json` (new) | hand pattern, fixed element |
| `catalog/patterns/transitions.dev.json` (new) | hand pattern |
| `catalog/patterns/vibeprompts.dev.json` (new) | hand pattern, 5 templates |
| `catalog/patterns/{screen.movie,supaste.com,superset.sh,toolcraft.sh,sleek.design,ui-skills.com}.json` (new) | skips |
| `catalog/corpus/sites/opensourceui.in/filters/e-*.html` (10 pages) | downloaded by `--fetch-filters` for the elements_from experiment; corpus, not committed |

No `auto` file existed for any of the 14 domains, so all 14 are new hand files. Nothing outside
`catalog/patterns/<domain>.json` for these domains was edited.

## Commands run

```
bun tools/patterns.mjs --suggest <domain>                 # all 14
curl -sA "Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)" <2–3 pages/site> | grep <title>   # page identity
curl ... | grep -o 'href="/…'                             # category/filter pages, JS-render check
bun tools/patterns.mjs --fetch-filters --only=opensourceui.in     # 10 category pages, elements_from experiment
bun tools/patterns.mjs --check <domain>                   # all 8 patterns, repeatedly while tuning
bun -e '… loadPattern(domain) …'                          # all 14 files valid (pattern or skip)
bun test ./tools                                          # 91 pass, 9 fail — all 9 are catalog/items == 0 (build not run here)
```

## Results

| domain | pattern or skip | items | % with element | variants found | note |
| --- | --- | --- | --- | --- | --- |
| opensourceui.in | pattern `/components/{name}` | 207 | 57% | navbar:dock 4, pricing:billing-toggle 1 | one page per copy-paste React component ('Tactile 3D — Free React Component'); `/components/category/<kind>` (30) are listings and do not match |
| originkit.dev | pattern `["/components/{name}", "/components/{name}/{n}", "/sections/{name}"]` | 651 | 24% | none | 546 animated WebGL components + 47 numbered variants + 58 sections; sections 100% element-tagged, components mostly have no taxonomy element (cursor-ring-field → cursor is the exception) |
| reactvibe.com | pattern (8 templates) | 67 | 61% | none | `/docs/blocks/{element}/{*}` + `/docs/dashboard-ui/{element}/{*}` + explicit `navigation/*`, `widget/*`, `components/*`, `motion/*`, `backgrounds/*`, `text/*` |
| screen.movie | skip | — | — | — | macOS screen recorder product site: contact/privacy/updates/`/blog/*`/feature pages |
| shadcnadmin.com | pattern `["/components/{name}", "/blocks/{name}"]` + 6 excludes | 60 | 82% | none | 53 shadcn component pages + 7 block demos; 63 URLs match, 3 drop as id collisions (`/blocks/{card,table,dialog}` vs the component page) |
| sleek.design | skip | — | — | — | AI mobile-app template gallery: `/templates/<name>` are whole apps with their own screens, `/design-md/<name>` are DESIGN.md files |
| supaste.com | skip | — | — | — | macOS clipboard manager product site (14 URLs: terms, privacy, contact, roadmap, `/updates/*`) |
| superset.sh | skip | — | — | — | coding-agent product site: compare/changelog/marketplace themes, 17 locale copies |
| sv-particles.vercel.app | pattern `/particles/{name}` | 10 | 90% | none | Svelte QBlocks component library; only `menu` has no taxonomy element |
| text-effects.colorion.co | pattern `/effects/{name}`, `element: text-effect` | 99 | 100% | none | one page per pure-CSS text effect; the 8 `/css-*` root pages are kind listings, not items |
| toolcraft.sh | skip | — | — | — | `/gallery/<name>` are standalone design apps (Brick Mosaic …), `/case-studies/<name>` are tutorials |
| transitions.dev | pattern `/transitions/{name}` | 43 | 60% | none | copy-paste CSS transition library, one page per transition; element only when the name names one (toast-open-close → toast) |
| ui-skills.com | skip | — | — | — | skills directory: `/skills/*`, `/playbook/*`, `/components/<topic>` roundups, `/collections/*` tag listings |
| vibeprompts.dev | pattern (5 templates) | 268 | 84% | 56 keys / 86 assignments, e.g. cta:banner 5, pricing:usage-based 4, features:grid 3, navbar:tabs 3, testimonials:cards 3, hero:split 2, footer:with-cta 2, faq:accordion 2, navbar:mega-menu 1 | Tailwind section/component prompt library; `/{element}/{name}` captures the element from the prefix, explicit templates for dashboards/auth/onboarding/bonus |
| **total** | 8 patterns · 6 skips | **1405** | **51%** | 58 variant keys (56 on vibeprompts + navbar:dock, pricing:billing-toggle on opensourceui) | |

Pattern-file check after the last edit: all 8 patterns and 6 skips load and validate (`loadPattern` on all 14).

## Open problems

1. **opensourceui.in `elements_from` rejected after measuring.** The 10 category pages that name a taxonomy
   element (buttons, calender, docks, dropdowns, forms, inputs, loaders, otp, pricing, table) are genuine kind
   pages — 22 component links each, all on kind — but a filter-page element **replaces** the name-derived
   elements of the same item (`if (!els.size) …` in `sitemapScan`), so `checkbox-field-input` would become
   `input` instead of `checkbox + input` and `3d-button` would lose `3d`. Measured: 119 → 125 items with an
   element (57% → 60%), at the cost of the finer second elements. Kept the name-based pattern. The 10 fetched
   pages stay in the shared corpus (`sites/opensourceui.in/filters/`), harmless if another brief wants them.
   The other 20 categories (audio, frames, mockups, notifications, text, users, profile …) are not elements and
   were never candidates.
2. **shadcnadmin.com loses 3 block demos to id collisions.** `/blocks/card`, `/blocks/table` and `/blocks/dialog`
   slug to the same item ids as `/components/card`, `/components/table`, `/components/dialog`; the component
   page wins by sitemap order. 63 URLs match, 60 items. Not fixable in a pattern (ids come from the last segment).
3. **reactvibe.com's `navigation` and `widget` kinds are not element slugs.** 4 navbar block pages
   (`/docs/blocks/navigation/*`) and 1 widget page would be dropped by the `{element}` template; explicit
   templates keep them, but `morph-menu` and `overlay-menu` stay untagged (their names say "menu", not "nav",
   and the pattern format has no per-template fixed element). The kind index pages themselves cannot be used as
   `elements_from`: they contain the site-wide nav (every block and component link), which would tag everything.
4. **originkit.dev components are 24% element-tagged and that is structural**: the library is animated
   backgrounds/effects (silk-waves, plasma-ring, accretion-disc) with no taxonomy element. Its 11
   `/category/<kind>` pages render client-side (0 `/components/` links in the HTML, verified on `/category/button`),
   so no `elements_from` either. The 5 `/sections/category/<element>` pages would add nothing — sections already
   tag 100% from their names.
5. **vibeprompts.dev has 42/268 items without an element**: `/auth/*` 14, `/onboarding/*` 11, `/bonus/*` 17
   (the exotic prompts: regex tester, cron builder, JSON tree viewer …). They are real UI screens/widgets of the
   site but match no taxonomy element; kept rather than dropped, so the site's % is 84%, not ~98%.
   `/blog/*` (19 article-layout prompts) is deliberately not matched.
6. **text-effect has no variants in the taxonomy**, so text-effects.colorion.co's 8 `/css-*` kind pages could not
   become `variants_from` (the CLI rejects any variant id not in the taxonomy).
7. **`bun test ./tools` = 91 pass, 9 fail in this worktree.** All 9 failures are the search/items tests that read
   `catalog/items`, which is empty here (the brief forbids running `bun tools/build.mjs`); e.g.
   `catalog/items exists` receives 0 items. Nothing in the failures relates to pattern files. Not fixed — the
   report numbers come from the adapter directly.
8. **ui-skills.com is a judgement call**: skipped as a skills/playbook directory, consistent with the coordinator's
   earlier skips for explainx.ai ("AI skills directory pages") and flaviocopes.com. If the catalog later wants
   skill pages as items, this domain is the one to revisit (464 `/skills/*` + 48 `/playbook/*` pages).

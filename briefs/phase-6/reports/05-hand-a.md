# Brief 05 report — pattern review batch (hand-a)

Branch `phase6/review-hand-a` (worktree). The BATCH line was fixed by the task to these 14 hand-picked
domains: `404s.design, 60fps.design, aicss.dev, aura.build, browser-use.com, coss.com, designmd.me,
dock.cool, isreadyforlaunch.com, kinetics.colorion.co, logobook.com, motionsites.ai, neuform.ai,
open-design.ai`. Everything below was measured on this branch on 2026-10-07 with
`bun tools/patterns.mjs --check <domain>` (no `bun tools/build.mjs` run).

## Files changed

| file | what |
| --- | --- |
| `catalog/patterns/404s.design.json` (new) | hand pattern — fixed `element: "404"` |
| `catalog/patterns/60fps.design.json` (new) | hand pattern — `/shots/{name}` + `/appsites/{name}` |
| `catalog/patterns/aicss.dev.json` (new) | hand pattern — `/components/{element}` + `{name}` |
| `catalog/patterns/aura.build.json` (new) | hand pattern — `/s/{name}` |
| `catalog/patterns/coss.com.json` (new) | hand pattern — coss ui docs + origin components |
| `catalog/patterns/neuform.ai.json` (new) | hand pattern — `/skill/{element}` + `{name}` |
| `catalog/patterns/browser-use.com.json` (new) | skip |
| `catalog/patterns/designmd.me.json` (new) | skip |
| `catalog/patterns/dock.cool.json` (new) | skip (no sitemap, homepage checked) |
| `catalog/patterns/isreadyforlaunch.com.json` (new) | skip |
| `catalog/patterns/kinetics.colorion.co.json` (new) | skip |
| `catalog/patterns/logobook.com.json` (new) | skip |
| `catalog/patterns/motionsites.ai.json` (new) | skip |
| `catalog/patterns/open-design.ai.json` (new) | skip |

No file was edited outside `catalog/patterns/<domain>.json` for the batch; nothing under `catalog/corpus/`
was written (no filter-page downloads, see Open problems 1), and no other agent's corpus files were touched.

## Commands run

```
bun tools/patterns.mjs --suggest <domain>                                  # all 14 domains
bun tools/patterns.mjs --check <domain>                                    # all 14 domains
curl -sL -A "Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)" <url>   # status + <title> per site
bun test tools/patterns.test.mjs                                           # 27 pass, 0 fail
bun test tools                                                             # 91 pass, 9 fail (see Open problems 5)
```

No `--fetch-filters` run: for every candidate filter page the pattern could map, the links are rendered
client-side, so `elements_from`/`variants_from` would fetch pages and resolve 0 links (Open problems 1).

## Batch results

| domain | pattern or skip | items | % with element | variants found | note |
| --- | --- | --- | --- | --- | --- |
| 404s.design | pattern `/sites/{name}` (element 404, example) | 247 | 100% | — | creative 404-page gallery; one page per site's error screen |
| 60fps.design | pattern `/shots/{name}` + `/appsites/{name}` (example) | 2172 | 52% | 12 (`navbar:dock/floating/mobile/sticky/with-search`, `hero:animated-background`, `features:cards/carousel/with-image`, `pricing:billing-toggle/usage-based`) | UI-animation gallery; 2085 shots + 87 app-site animations |
| aicss.dev | pattern `/components/{element}` + `{name}` (page) | 18 | 50% | — | component docs of a UI kit for AI agents |
| aura.build | pattern `/s/{name}` (example) | 1000 | 4% | 1 (`footer:big-text`) | generated landing-page templates; names are brand names |
| browser-use.com | skip | — | — | — | agent-task showcases, posts, team, marketing |
| coss.com | pattern (page) | 69 | 77% | — | two component libraries (coss ui docs + origin) |
| designmd.me | skip | — | — | — | brand design-system profiles and comparisons |
| dock.cool | skip | — | — | — | CoolDock product site, no gallery, no sitemap |
| isreadyforlaunch.com | skip | — | — | — | SEO launch-checklist guide pages |
| kinetics.colorion.co | skip | — | — | — | single-page spring-physics demo (1 sitemap URL) |
| logobook.com | skip | — | — | — | trademark/logo archive, not UI |
| motionsites.ai | skip | — | — | — | Framer one-pager shop, no per-example URLs |
| neuform.ai | pattern `/skill/{element}` + `{name}` (example) | 71 | 39% | — | prompt-skill / UI-recipe pages |
| open-design.ai | skip | — | — | — | prompt-pack marketplace + blog, all pages duplicated per locale |

6 real patterns, 8 skips. Titles that decided the borderline cases (status + `<title>`, `curl` with the
catalog UA):
`404s.design/sites/accordion` → `Accordion` (the site; page mentions 404), root → `404s — A Curated Gallery of
Creative Error Page Designs` · `60fps.design/shots/cred-swipe-to-pay-interaction` → `CRED Swipe to Pay
Interaction - 60fps UI/UX animation` · `aicss.dev/components/thinking-state` → `Thinking State · AICSS` ·
`coss.com/ui/docs/components/accordion` → `Accordion - coss ui`, `coss.com/origin/accordion` → `Accordion
components built with React and Tailwind CSS - coss.com origin` · `aura.build/s/dayward` → `Dayward: Cinematic
3D Lamp Collection Landing Page` · `neuform.ai/skill/css-border-gradient` → `Border Gradients Prompt Skill |
Neuform` · `browser-use.com/showcase/landscape` → `What people run on Browser Use Cloud` ·
`logobook.com/logo/ansar-mosaic/` → `Ansar Mosaic - Logobook` · `motionsites.ai/sections` → `MotionSites AI —
Official Premium AI Website Prompts` · `dock.cool/` → `CoolDock — Smart Second Dock with Live Widgets for Mac`.

## Open problems

1. **60fps.design filter pages are unusable as `elements_from` sources.** `/shots/filter/<tag>` (108 tags,
   e.g. "Badge interactions: 240 examples from real iOS apps") is exactly the kind/category page the brief
   asks for, but its 2.1 MB HTML contains no link to any shot (`grep -o 'href="/shots/[^"]*"'` → 0; only
   `#…` anchors), so `--fetch-filters` + `loadFilters` would resolve 0 links and every entry would log
   "yielded 0 matching links". Left out on purpose. For a future HTML/API-aware fetch, 25 of the tag slugs
   are already taxonomy element slugs/aliases: `3d→3d, badge→badge, bottom-sheet→drawer, button→button,
   calendar→calendar, card→card, carousel→carousel, chat→chat, empty→empty-state, graph→chart, input→input,
   loading→loader, map→map, parallax→scroll-effect, particles→background, pricing→pricing, progress→progress,
   slider→slider, splash→hero, stats→stats, tabs→tabs, ticker→marquee, toast→toast, tooltip→tooltip,
   typing→text-effect`. `splash` is almost certainly a false friend (iOS splash screen, not a hero) and
   `/motion/tag/<tag>` is a brand/motion-graphics gallery, not UI — the guesser's HIGH `/motion/{element}/{*}`
   group is a false match (`tag` is an alias of `badge`), which is why `/motion/*` is not in the pattern.
2. **aura.build has three routes for the same 1000 templates**: `/s/<name>`, `/share/<name>` and
   `/templates/<name>` have identical name sets and identical titles (`/s/dayward` and `/share/dayward` both
   `Dayward: Cinematic 3D Lamp Collection Landing Page`), only the bytes differ. The pattern matches `/s/`
   only, so the catalog gets each template once. If the coordinator prefers the public hand-out route
   (`/share/…`), it is a one-word change to the pattern. `/component/<id>` (1000, opaque hex ids such as
   `6B4FC5`, client-rendered, no title), `/asset/<id>` (923) and `/design-systems/<name>` (725, no
   server-rendered title) are excluded: their pages carry no usable name or metadata.
3. **coss.com collapses 18 names.** `accordion, alert, avatar, badge, breadcrumb, button, checkbox, dialog,
   input, pagination, popover, select, slider, switch, table, tabs, textarea, tooltip` exist in both
   `/ui/docs/components/*` (55) and `/origin/*` (32). An item id is parent + slug of the last segment, so the
   two URLs are one item and the first sitemap URL (`/origin/<name>`) is kept: 69 items from 87 matched URLs.
   Making the `/ui/docs/...` page win instead would need 18 explicit `exclude` entries — rejected as
   needless brittleness for the same component.
4. **Only one batch site has no sitemap**: `dock.cool` (homepage checked → app product site, skip). Every
   other domain had `catalog/corpus/sites/<domain>/sitemap.json`, so no `urls_from` was needed anywhere.
   `kinetics.colorion.co` has a sitemap with a single URL and links only its own stylesheets, so it skips too.
5. **`bun test tools` has 9 pre-existing failures, all of them artifact-dependent**: `catalog/items/` and
   `catalog/search-index.json` do not exist in this worktree (`(fail) catalog/items exists` is one of them),
   and `tools/build.mjs` must not be run per the brief. `tools/patterns.test.mjs` alone is 27 pass / 0 fail,
   and no test reads `catalog/patterns/`, so this batch neither causes nor masks them.
6. **Expectation mismatch, recorded for the coordinator**: 8 of 14 hand-picked domains are not component or
   gallery sites at all (product/marketing pages, an SEO guide set, a trademark archive, a prompt-pack
   marketplace, a Framer one-pager). "Most should get a real pattern" holds for the 6 that are galleries; the
   rest contradict it and are documented with the evidence above.

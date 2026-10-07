# Brief 12 — Design-resource sites that have a sitemap but no pattern (fill in BATCH)

**BATCH:** `briefs/phase-6/sites/design-sitemap-sites.tsv` rows `<from>`–`<to>`

## Context
The queue file lists 154 sites in design categories (inspiration, icons, fonts, color-effects, design-rules,
design-tools, layout) whose sitemap is already downloaded (`catalog/corpus/sites/<domain>/sitemap.json`) but which
have **no** `catalog/patterns/<domain>.json` yet, so they give zero items. Columns: `row`, `entry_id`, `domain`,
`primary` category, all `categories`, `sitemap_urls`.

**Follow `briefs/phase-6/05-pattern-review-batch.md` exactly**: pattern format, the 7 steps per site, Do not, and
the report table. Read it first. This brief only adds the rules below, because most of these sites are not
component libraries.

## What counts as an item here
An item is one page a designer would want to open directly from a search hit.

| primary | map | skip |
| --- | --- | --- |
| inspiration | one showcased site/app/screen/section/example (`granularity: "example"`); element when the gallery's filter pages give one (`elements_from` / `variants_from`) | tag/category listings, designer profiles, blog, jobs |
| icons | one icon **set/pack/library** page | single-glyph pages (`/icons/arrow-left`): thousands of near-identical hits |
| fonts | one font **family** page | per-weight/style pages, glyph pages, "fonts like X" listicles, foundry profiles |
| color-effects | curated palettes, gradients, effects, shaders, textures with a human-chosen name | machine-generated permutations (every hex code, every colour pair) |
| design-rules / design-tools / layout | one guideline, rule, checklist, pattern or template page | docs of a tool's own UI, changelog, pricing, integrations |

- The site is not a design resource at all (news site, forum, generic marketplace, video stats, …)? Skip it, with
  what the site is as the reason.
- **Per-site cap: 3,000 items.** If the right families exceed it, keep the most specific family (e.g. palettes, not
  colours), or write the skip `"needs coordinator decision: <N> items in <families>"`.
- Most of these have no taxonomy element. That is fine: `% with element` can be 0 for icons/fonts/colours. Do not
  force an element from words in a slug.
- Reuse what is there: `bun tools/patterns.mjs --suggest <domain>` first; for a 50,000-URL sitemap (the cap of
  the download), look at `--suggest` groups only. Never print the sitemap.

## Do not (in addition to brief 05's list)
- Edit `tools/*`, other batches' domains, or any domain not in your rows.
- Use Scrapling, `chrome-devtools-axi`, or a fetch that impersonates a browser. A site that blocks plain `curl`
  gets the skip `"blocked: <status>"`.

## Done when
- Brief 05's report table for every row of the batch, plus: total new items, and the count of skips by reason
  (not design / single glyphs / generated colours / blocked / over cap / other).
- Report `briefs/phase-6/reports/12-<from>-<to>.md`, committed on your branch together with the pattern files
  (filter downloads land in the shared, gitignored `catalog/corpus/`; don't commit them).
- Last line of your final message: `PHASE6-DONE-12-<from>`.

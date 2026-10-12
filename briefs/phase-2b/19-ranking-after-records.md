# Brief 19 — search ranking after the Phase 2B run

One agent (Claude Code, Opus 5.5 high). Branch `phase2b/ranking`, from `phase2b/records`.

## Context
`/Users/egeayyildiz/Desktop/personal-projects/design-tools` is a dependency-free MCP server (`tools/mcp.mjs`) that maps
UI/design resources: 2,679 entries (sites, repos, pages) and ~115k items inside them, ranked by `tools/search.mjs`
(BM25F over entry and item fields, a small prior, concept parsing through `catalog/taxonomy.json`). Read first:
`MCP-PLAN.md` "In a nutshell", "Decisions" (esp. **2: no popularity in ranking**, 9, 10), 3.6–3.8, 6.8 (how the eval was
widened by a blind judge), "Phase 2B" + 2B.1; `briefs/phase-2b/reports/18.md`; then `tools/search.mjs`, `tools/eval.mjs`,
`tools/eval/queries.json`, the `search_resources` rendering in `tools/mcp.mjs`.

**What changed.** Phase 2B gave every entry a metadata record (`catalog/metadata/<id>.json`, merged by
`tools/build.mjs`): 2,636 records written by DeepSeek from crawled digests — summary, description, type, elements,
keywords, contains, stack, pricing. Before, most entries were described only by thin source hints; the well-known ones
also had X labels. Now every entry, including the long tail of one-off repos and single pages, is described richly
and accurately. Text matching alone no longer separates "the canonical resource for X" from "a small repo that also
says X", and rankings are full of near-ties.

**Measured** (`bun tools/eval.mjs`, 60 queries, recall@5 / MRR; the descriptive block is 10 site-description queries):

| state | headline | descriptive block |
| --- | --- | --- |
| before any record (pool widened 2026-10-07) | 0.983 / 0.720 | 0.800 / 0.542 |
| all records, same pool | 0.767 / 0.544 | 0.800 / 0.633 |
| all records, pool widened 2026-10-12 (blind judge: 36 of 80 hits correct, `tools/eval/judge-2026-10-12.json`) | 0.983 / 0.699 | 1.000 / 0.733 |

Most of the drop was the pool: records made true answers findable that the old pool never saw (Thiings and Icoon for
"3d icons"). The rest is real, and is this brief:

1. **Page entries rank on the sections they show.** A page's record lists its own sections (a one-pager: hero, cta,
   faq, footer), so for "cta inspiration" three One Page Love award pages (a pelvic-surgery clinic …) outrank CTA
   galleries; `cta-gallery` (504 CTA sections) is 6th.
2. **"navbar design"**: `navbar-design` (the site navbar.design) is not in the top 5 (test "an entry with mapped pages
   says pages:N" fails).
3. **"navbar"**: the `## Gallery examples` group (496 navbar.gallery examples) is gone from the answer (test "navbar:
   counts and kinds, components and the gallery" fails).
4. **"brand mark ideas for a new startup"**: no judged-correct hit in the top 5 (it passed before the records).
5. **Near-ties favour the long tail**: "animated react component library" → themicro, Amicro, Mixcn-UI; magicui-design
   is 10th. "color palette generator": coolors-co 10th.

**Tried by the coordinator, not kept** (scores pre-widening headline unless noted; re-check, do not trust blindly):
- X labels indexed for record entries again: 0.750 / 0.527 — worse.
- Record fields counted in doc length (`UNCOUNTED` empty): 0.767 / 0.538; descriptive MRR 0.633 → 0.700.
- Prior ×(1 + a) for curated / awesome-list origin and ×(1 + b·log items mapped): every (a, b) tried was worse.
- Page elements rank only when named in the page's name or summary (filter-only otherwise): widened MRR 0.699 → 0.706,
  fixes the clinic pages, but "free fonts" fell out of the top 5 — rankings are fragile; a change moves unrelated
  queries through doc-length averages and near-ties.
- Small tool: `rank(query)` debug — `createSearch(entries, loadIndex(entries)).rank(q, {})` returns
  `ranked: [{ d, score, matched }]`; entries are `d < E`.

## What to do
1. **A larger, judged eval first.** 60 queries with short `expect_any` lists are too brittle to tune against. Add ≥ 60
   new queries (element, variant, kind-of-resource, descriptive, named, Turkish — like the existing mix; include the 5
   cases above) to a new file, pool the top 10 of the current ranker **and** of every variant you try, and have a
   **blind judge** grade each pooled hit (a separate Claude Code subagent that sees only the query and the hit line —
   never `expect_any`, the ranker or your hypotheses; same rules as `judge-2026-10-12.json`; graded 0/1/2 if you want
   nDCG). Split the queries into a tuning half and a held-out half before you tune. Extend `tools/eval.mjs` to score
   the new file (recall@5, MRR, nDCG@5 if graded; per half) next to the existing headline.
2. **Fix the ranking** for the five problems above, generally — not per query. Ideas to weigh (yours to choose):
   per-field length normalisation (proper BM25F) instead of whole-doc; how a record's `elements` rank vs what the entry
   is *about* (pages especially, and broad galleries listing many elements); the weight and saturation of `keywords`
   (many near-duplicate phrases inflate tf); use of record `type` vs query intent ("library", "gallery", "generator");
   a content prior that is not popularity (decision 2: no post counts, likes or mentions — entry origin and the amount
   mapped inside an entry are allowed only if they generalise on the held-out half).
3. Keep items (components, docs pages, gallery examples) ranking as they are unless a fix needs it; report any change.

## Do not
- Change records, `catalog/metadata/*`, the crawl, items, patterns or registry configs; change eval expectations of
  the existing 60 queries except by a blind judge (the same way, a new dated judge file); add dependencies.
- Use popularity (mentions, post counts) in ranking. Grow `search_*` text answers (≤ 3 KB) or the index past 40 MB.
- Make a test pass by editing its expectation, unless a blind judge says the new answer is correct.

## Done when
- `bun test ./tools` passes, including the two ranking tests named above.
- Existing eval (widened pool, as committed on `phase2b/records`): recall@5 ≥ 0.983, MRR ≥ 0.720; descriptive block not
  lower than 1.000 / 0.733.
- New judged eval: held-out half better than the current ranker on its own pooled judgments (report both halves, and
  the current ranker's numbers on the same pool).
- The five problems are fixed or explained.
- Report `briefs/phase-2b/reports/19.md`, committed on your branch with the code: what you changed and why, every
  variant tried with its numbers (tuning and held-out), the judge files, before/after top-5 for the five problems,
  anything you were unsure about. Last line of your final message: `PHASE2B-DONE-19`.

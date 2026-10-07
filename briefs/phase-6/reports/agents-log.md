# Phase 6 agent log

Agents run as `omp` (model `deepseek/deepseek-v4.1-flash`, `--thinking max`) inside herdr worktrees
(`~/.herdr/worktrees/design-tools/<branch-slug>`, created with `herdr worktree create --base main`). Each worktree
symlinked `catalog/corpus` to the main checkout. An agent is closed once its branch is merged: the corpus symlink is
removed, then `herdr worktree remove --workspace <id>` ends the agent and deletes the worktree. The branch is kept.

| agent | brief | branch @ tip | outcome | merged | closed |
| --- | --- | --- | --- | --- | --- |
| s01 | 01 sitemaps | `phase6/sitemaps` @ 1a1d40a | 784 domains, 3.17 M URLs | 2026-10-07 (fast-forward) | 2026-10-07 |
| p02 | 02 patterns + adapter + guesser | `phase6/patterns` @ 24f2f68 | 8 hand + 60 auto patterns, 19,152 sitemap items; one fix round (non-UI auto patterns → skip, guesser rules) | 2026-10-07 (f3e0cd4) | 2026-10-07 |
| r051 | 05 review queue 1–28 | `phase6/review-r1` @ 84e5fa0 | 4 patterns, 24 skips | 2026-10-07 | 2026-10-07 |
| r056 | 05 review queue 141–168 | `phase6/review-r6` @ 6027eb3 | 5 patterns, 23 skips | 2026-10-07 | 2026-10-07 |
| r054 | 05 review queue 85–112 | `phase6/review-r4` @ 404430a | 3 patterns, 25 skips | 2026-10-07 | 2026-10-07 |
| r055 | 05 review queue 113–140 | `phase6/review-r5` @ 4f77864 | 3 patterns, 25 skips | 2026-10-07 | 2026-10-07 |
| h05a | 05 hand sites (14) | `phase6/review-hand-a` @ 7cb9db7 | 6 patterns, 8 skips | 2026-10-07 | 2026-10-07 |
| h05b | 05 hand sites (14) | `phase6/review-hand-b` @ a80ffcb | 8 patterns, 6 skips | 2026-10-07 | 2026-10-07 |
| r052 | 05 review queue 29–56 | `phase6/review-r2` @ 4f5f3b5 | 4 patterns, 24 skips | 2026-10-07 | 2026-10-07 |
| r053 | 05 review queue 57–84 | `phase6/review-r3` @ 9a89143 | 3 patterns, 25 skips | 2026-10-07 | 2026-10-07 |
| l04 | 04 list_pages + gallery examples | `phase6/list-pages` @ cee2721 | list_pages tool, Gallery examples group, pages:N, auto ×0.92; one fix round (gallery = page examples, skip answers, fallback test site) | 2026-10-07 | 2026-10-07 |
| g07 | 07 get_content sections | `phase6/get-content` @ f2b96f8 | query/section/outline; 2.3–8.4 KB answers instead of ~80 KB; one fix round (heading bonus, code 0.3×, word forms, alias groups, CJK penalty) | 2026-10-07 | 2026-10-07 |
| s08 | 08 small component sites | `phase6/small-sites` @ 0920c14 | 9 skipped sites mapped (~1,785 items: anchors, render, host repair, tailark); two fix rounds on item names (positional rule, 0 repeated names, 0 id changes) | 2026-10-07 | 2026-10-07 |
| a03 | 03 21st.dev metadata | `phase6/api-21st` @ 4021874 | 7,394 components (title + description) from allowed component pages, 251 category pages; fetch crashed once on an uncaught timeout, fixed with tests | 2026-10-07 | 2026-10-07 |

Still running: none. All Phase 6 agents are merged and closed; step 06 (wire the 21st.dev adapter, index size, eval) is the coordinator's.

All 05 batches merged: `catalog/patterns/` holds 274 files (44 hand · 60 auto · 170 skip).

Follow-ups noted in review: dycomps.oimmi.com was skipped because its sitemap locs have no host (a real block library,
worth a urls_from look); whole-site template shops are inconsistent (themefisher, uideck, wrappixel, bootstrapmade got
patterns; frameplate and sleek.design were skipped).

## Brief 09–12 (2026-10-07, evening)

| agent | brief | branch @ tip | outcome | merged | closed |
| --- | --- | --- | --- | --- | --- |
| t09a | 09 Scrapling probe, set A (31 walled/dead) | `phase6/scrapling-a` @ b3f5048 | 4 truly walled (uiverse, land-book, ui8, saasframe) + 5 reachable by curl; 16 dead | 2026-10-07 | 2026-10-07 |
| t09b | 09 Scrapling probe, set B (18 small) | `phase6/scrapling-b` @ 42c81e6 | 4 redirect-target sites (no Scrapling needed), 14 unchanged | 2026-10-07 | 2026-10-07 |

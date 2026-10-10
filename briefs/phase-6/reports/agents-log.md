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
| f10 | 10 redirects + revived sites | `phase6/redirects` @ 1b66a21 | 7 patterns (+7,624 items after dropping 120 uuid-named mobbin screens), raivcoo skip (uuid names) | 2026-10-07 | 2026-10-07 |
| r12-105 | 12 design sitemap sites rows 105–130 | `phase6/design-105` @ e479d69 | 6 patterns (+3,442: grainient 1,481, gradientora 1,066, youworkforthem 823 …), 20 skips | 2026-10-07 | 2026-10-07 |
| r12-53 | 12 design sitemap sites rows 53–78 | `phase6/design-53` @ 2ad4722 | 8 patterns (+2,770: uidesigndaily 1,505, webpo 788, icon.museum 247 …), 18 skips | 2026-10-07 | 2026-10-07 |
| r12-27 | 12 design sitemap sites rows 27–52 | `phase6/design-27` @ 5653acd | 13 patterns (+7,237), 13 skips | 2026-10-07 | 2026-10-07 |
| r12-79 | 12 design sitemap sites rows 79–104 | `phase6/design-79` | 9 patterns (+6,462: fonts.google.com 2,219, typewolf 1,139 …) | 2026-10-07 | 2026-10-07 |
| r12-1 | 12 design sitemap sites rows 1–26 | `phase6/design-1` @ 7addd1b | 14 patterns (+11,178: admiretheweb 2,982, bestwebsite.gallery 2,641 …), 12 skips | 2026-10-07 | 2026-10-07 |
| r12-131 | 12 design sitemap sites rows 131–154 | `phase6/design-131` @ 92f643b | 9 patterns (+1,543: getdesign.md 633, designmd.ai 400, m3.material.io 248 …), 15 skips | 2026-10-07 | 2026-10-07 |
| b13 | 13 real-browser test (Claude Code, Opus 5.5 medium, user's Search browser) | `phase6/real-browser` @ 58510d0 | real browser no better than Scrapling: Turnstile checkbox on saasframe/colorkit; same reach on land-book/ui8/uiverse/mobbin; savee 30 saves/board; shadcnblocks 286 hero blocks found | 2026-10-07 | 2026-10-07 |
| w11 | 11 Scrapling opt-in backend + paginate + uiverse.io | `phase6/scrapling-backend` @ 3e2857c | uiverse.io 6,013 items (100 % element); hosts file with land-book/ui8/saasframe disabled; challenge-rule fix; 173 tests pass on main | 2026-10-07 | 2026-10-07 |

Still running: none. Briefs 09–13 merged and closed.
| u14 | 14 registry page urls (shadcnblocks) | `phase6/registry-urls` @ c524b95 | sitemap pages fill url-less registry items; shadcnblocks 4,132 urls attached (registry items with a url 1,097 → 5,229); survey: 15,253 more fillable, shadcn.io 7,843 next | 2026-10-07 | 2026-10-07 |

2026-10-10: brief 15 (registry page urls for the other registries, `attach_only`) launched.
| u15a | 15 registry urls: shadcn.io, reui.io, shadcncraft.com | `phase6/registry-urls-a` @ 9fc1ce8 | 9,748 urls attached (shadcn.io 7,841 · reui 1,647 · shadcncraft 260), 0 new items | 2026-10-10 | 2026-10-10 |
| u15b | 15 registry urls: 28 smaller registries | `phase6/registry-urls-b` @ 18c1af3 | 1,335 urls attached, 0 new items; ui-layouts 6 dead sitemap urls excluded | 2026-10-10 | 2026-10-10 |

Still running: none. Brief 15 merged and closed (MCP-PLAN 6.10).

2026-10-10: brief 16 (registry url templates).
| u16a | 16 engine `tools/registry-urls.mjs` + pilots (Claude Code Opus 5.5 high; first started as omp, stopped before any commit) | `phase6/registry-tpl-a` @ f71cb8d | engine, build fill, 204 tests; pilots +248 urls; follow-up: html-first Accept, sitemap carve-out for blind/soft templates | 2026-10-10 | 2026-10-10 |
| u16b | 16 batch b (19 sites) | `phase6/registry-tpl-b` @ 0323627 | 15 templates, 4 skips; expected 6,138 (shadcn-ui-blocks → .com 3,903) | 2026-10-10 | 2026-10-10 |
| u16c | 16 batch c (18 sites) | `phase6/registry-tpl-c` @ 7acbfd4 | 18 configs + soralabs pattern; expected ~825 (+258 tailark after the carve-out); found the two engine gaps | 2026-10-10 | 2026-10-10 |
| u16d | 16 batch d (18 sites) | `phase6/registry-tpl-d` @ 9160fa5 | 16 configs + 2 patterns; expected 2,449 (icons.pqoqubbw → lucide-animated 467) | 2026-10-10 | 2026-10-10 |

Still running: none. Brief 16 merged and closed; full `--verify --all` run by the coordinator.

2026-10-10: brief 17 (Phase 4 tool surface, `briefs/phase-4/17-tool-surface.md`) launched.
| u17 | 17 Phase 4 tool surface (Claude Code Opus 5.5 high) | `phase4/tool-surface` @ f5cb64f | schemas + structuredContent, get_install_command, get_component paging/examples, list_components filters, follow_url; 222 tests | 2026-10-10 | 2026-10-10 |

Still running: none.

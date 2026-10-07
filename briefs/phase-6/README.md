# Phase 6 (6.1 + 6.3) — work briefs

Written 2026-10-07. Each `0N-*.md` file is a complete brief for one agent: it does not need this README, the
conversation, or MCP-PLAN.md beyond the sections it quotes. Hand an agent exactly one brief.

## Scope (measured 2026-10-07)

| What | Count | List |
| --- | --- | --- |
| Unique sites with a sitemap (level 1: full sitemap download) | 860 | `sites/all-sitemap-domains.txt` |
| Component-type sites without items yet (level 2 candidates) | 272 | `sites/component-sites.tsv` |
| … mapped by hand (curated + plan sites) | 36 | `sites/hand-sites.tsv` |
| … mapped by the pattern guesser, low-confidence ones reviewed | 238 | `sites/auto-sites.tsv` |
| Inspiration-only galleries (optional, after the above) | 94 | `sites/inspiration-sites.tsv` |
| 21st.dev component pages (6.3) | 7,401 | from 21st.dev's sitemap |

Earlier estimates in conversation (1,283 sites / 409 candidates) counted catalog *entries*; many entries are pages of
the same domain. The numbers above are per domain.

## Order

```
01 sitemaps ──┐
              ├──> 04 list_pages tool ──┐
02 patterns ──┤                         ├──> 06 integrate + eval (coordinator)
              └──> 05 review batches ───┤
03 21st.dev ────────────────────────────┘
```

- **01, 02, 03 run in parallel.** They touch different files. 02 can be developed against fixtures before 01's
  downloads finish, but its acceptance run needs 01's output.
- **04** starts after 02 is merged (needs the sitemap item shape).
- **05** runs once per batch after 01 and 02. Batches write one file per domain, so several can run at once.
  Suggested batches: hand-sites rows 1–18, 19–36; then the guesser's low-confidence queue in chunks of ~30;
  then inspiration-sites in chunks of ~30 (optional).
- **06** is not outsourced: wire 03's adapter into `tools/items.mjs`, rebuild, check index size (< 25 MB), run the
  eval, write results into MCP-PLAN.md 6.x.

## Before handing out

1. **Put the project under git** (`git init && git add -A && git commit -m baseline`). There is no version control
   today, and reviewing five agents' work without diffs is guesswork. Each agent then works on its own branch or
   worktree.
2. Agents never need the 21st.dev API key. Do not put it in any brief, file or environment they can see.

## Shared rules (repeated inside each brief)

- Runtime is `bun`; no new npm dependencies.
- Never read `catalog/catalog.json`, `catalog/search-index.json`, `catalog/sources/*` or `catalog/corpus/` whole —
  query them with `jq` / scripts and print counts and samples.
- Never run `bun tools/build.mjs` (it rewrites catalog.json from sources). `bun tools/index.mjs` and
  `bun tools/items.mjs --dry` are fine.
- `bun test ./tools` must stay green (60 tests on 2026-10-07).
- Network: ≤ 2 requests/s per host, user agent `Mozilla/5.0 (compatible; design-tools-catalog/1.0; +local)`, no auth
  headers, resumable runs.
- Return a short report: files changed, commands run, the numbers asked for, open problems.

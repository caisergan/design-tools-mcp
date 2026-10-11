# Phase 2B extraction run — runbook

The tooling is in place (brief 18); this is the owner's part: one record per entry, written by omp + DeepSeek from
a no-LLM digest. Everything downstream works with any number of records, so the run can stop and resume at any batch.

| Step | Command | Writes |
| --- | --- | --- |
| queue | `bun tools/metadata-queue.mjs` | `_queue.json` (gitignored): new / stale (> 90 days) / hints-changed, curated → readable → rest; counts + token estimate |
| crawl | `bun tools/crawl.mjs --pilot` · `--queue [--limit n]` · `--id a,b` | `catalog/crawl/<id>.json` (gitignored, third-party text); `--report` prints sizes and failures |
| batches | `bun tools/metadata-batch.mjs --from-queue --size 20` · `--ids a,b --size 10` | `_batches/<n>.md` (gitignored): prompt + taxonomy view + ids + steps + marker `METADATA-BATCH-<n>-DONE` |
| extract | one omp session per batch file (below) | `catalog/metadata/<id>.json` |
| check | `bun tools/metadata-check.mjs` | normalizes keywords in place, `_review.md`; exit 1 on any error |
| build | `bun tools/build.mjs` | catalog.json (records merged, `metadata: "missing"` elsewhere), ROUTER.md, llms.txt, items, search index |

## 1. Work in one run worktree

All sessions share one checkout. They read the same digests, write different record files and never commit, so they
cannot collide.

```sh
herdr worktree create --cwd ~/Desktop/personal-projects/design-tools --branch phase2b/run --base main --label run --no-focus
cd ~/.herdr/worktrees/design-tools/phase2b-run
ln -s ~/Desktop/personal-projects/design-tools/catalog/corpus catalog/corpus   # gitignored, never commit
cp -R ~/Desktop/personal-projects/design-tools/catalog/items catalog/items     # for `known` item counts in the digests
```

## 2. Pilot first (50 entries)

```sh
bun tools/crawl.mjs --pilot                     # ~30 s; prints ok / partial / blocked and digest tokens
bun tools/metadata-batch.mjs --ids "$(jq -r '[.entries[].id] | join(",")' catalog/metadata/pilot.json)" --size 10
```

Run the 5–6 batches (step 3), then review every pilot record by hand: `bun tools/metadata-check.mjs`, read
`_review.md`, `bun tools/build.mjs`, try `get_resource` / `search_resources` on a few. Fix
`tools/prompts/metadata-v2.md` or `catalog/taxonomy.json` if a pattern is wrong, delete the records it produced, and
re-run them. Note the real tokens per record from omp's usage; it replaces the estimate in the queue.

## 3. Run the batches — `tools/metadata-run.mjs` (recommended)

```sh
bun tools/metadata-run.mjs --parallel 8            # every batch file; headless `omp -p`, deepseek-v4.1-flash, thinking max
bun tools/metadata-run.mjs --batches 1-6           # some of them; batches whose records already pass the check are skipped
bun tools/metadata-run.mjs --usage                 # token / cost totals from the logs
```

Each session may read up to 6 of an entry's own pages with `bun tools/crawl.mjs --page <url>` (robots, pacing and
the disabled hosts kept) when the digest is thin. Logs: `_batches/<n>.log` (gitignored). Pilot, 2026-10-11: 51
entries in 6 batches of 9, ~10 min per batch, $0.33 in total (input 0.62M + 13.6M cache reads, output 0.33M).

The manual way, one herdr pane per batch:


For each batch `n`, start an agent in a new tab of the run workspace and point it at its file:

```sh
WS=<workspace id from `herdr workspace list`>; WT=~/.herdr/worktrees/design-tools/phase2b-run
herdr tab create --workspace "$WS" --cwd "$WT" --label "m$n"                 # then: herdr pane list → its pane id
herdr agent start "m$n" --kind omp --pane <pane> -- --model deepseek/deepseek-v4.1-flash --thinking max
herdr agent prompt "m$n" "Read catalog/metadata/_batches/$n.md and do exactly what it says."
```

Run 4–6 at once (a host is never fetched during extraction, so the only limit is the model's rate). herdr does not see
omp's working / done state, so watch the batch's records and its marker line instead:

```sh
bun tools/metadata-check.mjs --id "$(cat catalog/metadata/_batches/$n.ids)"   # exit 0 = every record of batch n exists and is valid
herdr agent read "m$n" | tail -5                                            # the session's last reply ends with METADATA-BATCH-<n>-DONE
```

A session works through its 20 entries in one context, so its input grows with every entry. Smaller batches
(`--size 10`) cost fewer tokens, more batches cost more setup; DeepSeek's prefix cache makes the repeated part cheap.
Stop a stuck session: `herdr agent send-keys "m$n" esc`, then `ctrl+c` twice. Its finished records stay; re-run the
queue to pick up the rest.

## 4. Full run

```sh
bun tools/metadata-queue.mjs                    # after the pilot: the pilot's records are no longer queued
bun tools/crawl.mjs --queue                     # ~2,600 entries, ~20 min at 2 req/s per host; resumable
bun tools/metadata-batch.mjs --from-queue --size 20
```

Then run step 3 over every batch file. Regenerate batches only while no session is running (they are renumbered).

## 5. Check, review, rebuild, repeat

```sh
bun tools/metadata-check.mjs                    # every record; errors name the field; _review.md lists confidence < 0.6
                                                # and primary categories no source hint supports
bun tools/build.mjs                             # merge; prints merged / blocked / skipped-invalid counts
bun tools/eval.mjs                              # the "site descriptions" block is the run's before/after
bun tools/metadata-queue.mjs                    # what is left: records missing, failed or stale
```

Fix a record by editing its file and running the check (or add a hand fix to `catalog/overrides.json`: it beats
metadata). Add search words for one entry in `keywords_manual`: a re-run never overwrites them. Commit
`catalog/metadata/<id>.json`, `_review.md` and the rebuilt catalog; never `catalog/crawl/`, `_batches/` or the corpus.

Blocked digests (walled, JavaScript-only, robots, disabled Scrapling hosts) still get a short `status: "blocked"`
record. The entry keeps its source description and is not queued again for 90 days. The 3 hosts that
`catalog/scrapling-hosts.json` disables stay unfetched until the owner decides.

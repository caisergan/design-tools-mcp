# Brief 17 — Phase 4: tool surface (structured output, install command, paging)

One agent (Claude Code, Opus 5.5 high). Branch `phase4/tool-surface`.

## Context
`/Users/egeayyildiz/Desktop/personal-projects/design-tools` is an MCP server (`tools/mcp.mjs`, a single-file
JSON-RPC loop over stdio, **no dependencies** — MCP-PLAN decision 1) that gives AI coding agents a map of UI/design
resources: ~2,680 sites/repos ("entries") and ~115k components, docs pages and gallery examples inside them
("items"), ranked by `tools/search.mjs`. Read first, in full: `MCP-PLAN.md` sections "In a nutshell", "Decisions",
"Phase 4", "Final tool surface" and 6.10–6.11; then `tools/mcp.mjs`, `tools/mcp.test.mjs`, `tools/lib.mjs`
(`resolveItemBase`, `itemBaseCandidates`, `isGatedResponse`), and `tools/items.mjs` (item fields: `access`
code|gated|page, `granularity`, `type`, `install_url`, `stacks`, `names`, `examples`, `local`, `url`).

The plan's Phase 4 was written before Phases 3 and 6 landed, so parts of it are already done. **Already there — keep:**
paging (`offset`) on `search_resources`, `search_components`, `list_pages`; `get_content` answers a big doc with an
outline, `query` ranks sections, `section=<n>` returns one (brief 07 — this replaces the plan's `max_chars` paging);
`get_component` accepts item ids and a `stack` param, explains page/gated items, and prints `page: <url>`; every
hit line shows the item's url; protocol negotiation keeps `protocolVersion` (2025-06-18 / 2025-03-26 / 2024-11-05).

## What to build

### 1. Structured output (plan 4.1)
- New `tools/schemas.mjs`: JSON Schemas for the answers — at least `ResourceHit`, `ComponentHit`, `PageHit`,
  `Resource`, `ComponentSource`, `ContentAnswer`, `InstallPlan`, and one `outputSchema` per tool built from them.
- When the client negotiated `2025-06-18`: `tools/list` carries each tool's `outputSchema`, and every successful
  `tools/call` returns `structuredContent` **plus** the existing text (unchanged in meaning; clients that ignore
  structured output keep working). Older protocol versions get exactly what they get today. Errors stay text with
  `isError: true` and no `structuredContent`.
- The text stays the compact rendering it is now — do not let search answers grow (the token budget in "In a
  nutshell": an agent reaches the right component in < 1.5k tokens). `structuredContent` holds the same facts with
  stable field names (ids, urls, counts, kinds, `next_offset` or null), not extra prose.
- `resource_link` content items (2025-06-18 only) for the **primary** url of `get_resource`, `get_component` and
  `get_install_command` answers — not for every search hit.

### 2. `get_install_command` — new tool (plan 4.4)
`get_install_command({ items: ["<item id>" | {ref, name}], package_manager: "npx" | "pnpm" | "bunx" | "yarn" = "npx" })`
- Resolves each item to its registry JSON url (`install_url` when the item has one; else `resolveItemBase` on the
  entry's registry, as `get_component` does). No network when the corpus already has what is needed.
- Returns one runnable command per package manager form (`npx shadcn@latest add <url1> <url2> …`; pnpm: `pnpm dlx`,
  bun: `bunx --bun`, yarn: `yarn dlx`), the npm `dependencies` and `registryDependencies` it will pull in (from the
  registry item JSON: corpus `catalog/corpus/sites/<domain>/items/` or `registry.json` first), and the items it could
  not include: page items (no code — give their url), gated items (licence/login — give their page url), unknown
  ids (with the closest ids). Cap at 25 items per call.
- Done when: 3 Magic UI items give one runnable command (check: the urls answer 200 JSON — do not run shadcn).

### 3. `get_component` (plan 4.3)
- `include_examples: true` also returns the item's sibling examples (`examples` field: `<name>-demo*`), each as its
  own clipped source block, capped so the whole answer stays ≤ 40k chars.
- Paging for big sources: `offset` (chars) + the existing 80k clip becomes `max_chars` (default 20k, ≤ 40k) with
  `next_offset`; say how to get the rest.
- Always state `type`, `dependencies`, `registryDependencies`, `install_url` (and the install command one-liner)
  when known.

### 4. `list_components` filters (plan 4.5)
`query` (substring/word match on name, title, description), `type` (`registry:ui` …), `offset` + `limit`
(default 60, ≤ 300), with `next_offset`. Keep each line's page url (added 2026-10-10).

### 5. `get_content` `follow_url` (plan 4.2, the part not done)
`follow_url`: fetch one document linked from the entry's llms.txt and answer it with the same outline / query /
section modes. Allowed only when the url has the same origin as the entry or appears in its llms.txt (SSRF guard:
https only, no IP literals, no localhost/private ranges, redirects re-checked against the same rule, 2 MB cap, 15 s
timeout). Wrap the body in the existing `untrusted(...)` marker.

### 6. Docs inside the server
Update `INSTRUCTIONS` and each changed tool's `description` so an agent knows `get_install_command`, `include_examples`,
`follow_url` exist — one line each, keep the instructions short.

## Tests (no network unless a test already uses it)
- A small JSON-Schema validator in the test file (types, required, properties, items, enum, nullable via type
  arrays — only what your schemas use; no dependency). **Every tool's successful answer in `mcp.test.mjs` validates
  against its `outputSchema`** when the session negotiated 2025-06-18; a 2025-03-26 session gets no
  `structuredContent` and no `outputSchema`.
- `get_install_command`: grouping, package-manager forms, page/gated/unknown items reported, the 25 cap.
- `follow_url`: the SSRF rules (other origin not in llms.txt, http, IP literal, localhost, redirect to another
  origin → refused) as pure-function tests.
- `list_components` filters and paging; `get_component` `max_chars`/`offset`, `include_examples` cap.
- Keep every existing test green. `bun tools/eval.mjs` must stay at recall@5 0.983 / MRR 0.720 (you change no
  ranking).

## Do not
- Add dependencies (no `@modelcontextprotocol/sdk`, no ajv). Change ranking (`tools/search.mjs` scoring), the
  catalog, items, patterns or corpus. Run `bun tools/build.mjs` / `fetch.mjs` / `registry-urls.mjs --verify`.
- Grow the text answers of `search_resources` / `search_components` / `list_pages`. Compare a few answers before
  and after (e.g. `search_resources {query:"navbar"}`, `search_components {element:"hero"}`) and report sizes.

## Done when
- `bun test ./tools` passes, including the new tests; eval unchanged.
- MCP-PLAN Phase 4 "Done when": every tool response validates against its `outputSchema` in tests; `get_content` on a
  big llms.txt answers within its limit and pages; `get_install_command` for 3 Magic UI items returns one runnable
  command.
- Report `briefs/phase-4/reports/17.md`, committed on your branch with the code: files changed, the schemas (names +
  one line each), design decisions, before/after text sizes of 4 sample answers, a sample `structuredContent` for
  `search_components` and `get_install_command`, anything you were unsure about.
- Last line of your final message: `PHASE4-DONE-17`.

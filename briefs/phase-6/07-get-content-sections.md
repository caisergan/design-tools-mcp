# Brief 07 — `get_content` returns matching sections, not the first 80 KB

## Context
`/Users/egeayyildiz/Desktop/personal-projects/design-tools/tools/mcp.mjs` is a dependency-free MCP server (stdio
JSON-RPC) over a catalog of UI/design sites. AI agents call it and pay tokens for every byte it returns.

`get_content(ref, file?)` (`toolGetContent`) returns a resource's `llms-full.txt` / `llms.txt` (sites) or
`SKILL.md` / `README.md` (repos): the local copy in `catalog/corpus/` first, else a live fetch. Today it returns the
whole body clipped to `MAX_CODE = 80_000` characters (`clip`). That is ~20k tokens per call, and for a large doc it is
the *start* of the file, not the part the agent needs: 55 local `llms-full.txt` files are over 200 KB (37 MB in total;
the largest is 2.9 MB). An agent asking how daisyUI's drawer works gets the first 80 KB of the docs.

Your job: let the agent ask for the part it needs, deterministically (no model, no embeddings, no new dependency).
Read `tools/mcp.mjs` in full first (`toolGetContent`, `untrusted`, `clip`, `TOOLS`, `HANDLERS`, the server
`instructions`), then `tools/search.mjs` (`tokens`, `stemWord`, `createSearch` → `S.analyse`) and the `get_content`
tests in `tools/mcp.test.mjs`.

Runtime: `bun`, plain ESM, no npm dependencies.

## What to build

### 1. New `tools/sections.mjs` (pure functions, no I/O)
- `splitSections(text) → [{ n, title, path, source, start, end, chars }]`
  - Boundaries, in priority order:
    1. Markdown headings `#`, `##`, `###` **outside fenced code blocks** (a `# comment` inside ```` ``` ```` or `~~~` is
       not a heading — test it). `path` is the heading trail (`Components › Drawer › Props`).
    2. Page separators used by llms-full generators: a `---` line followed (after blank lines) by a heading or a
       `Source:` / `URL:` line. Keep that URL as the section's `source`.
    3. No headings at all (e.g. `sunglasses.dev/llms-full.txt`, 2.3 MB with two `#` lines): fixed chunks of ~3,000
       chars, cut at a blank line; title = the chunk's first non-empty line (clipped to 80 chars).
  - Merge sections shorter than ~200 chars into the next one; split sections longer than ~12,000 chars at blank lines.
  - `n` is 1-based and stable for a given text.
- `rankSections(text, sections, concepts, { limit, offset }) → { hits: [{ n, score }], total }`
  - BM25 over sections (title words count 3×, body 1×), using `tokens()` from `tools/search.mjs`.
  - `concepts` comes from the server's `S.analyse(query).concepts`: score each concept as its best alternative ×
    weight, sum over concepts, ×1.25 when every concept matched (same idea as search). Sections don't carry
    `el:` / `va:` / `cat:` terms, so **expand** `el:<id>` into the element's id, label and aliases from
    `catalog/taxonomy.json` (whole-token match): `"dialog"` must find a section titled `Modal`. Drop `va:` / `cat:`
    terms the same way (variant / category label + aliases).
  - A section with score 0 is never returned.
- Cache per document: the server keeps the split (and term stats) for the last ~20 documents in memory, keyed by path
  + size + mtime (live bodies by URL), so a second query on a 2.9 MB file does not re-split it.

### 2. `get_content(ref, file?, query?, section?, offset?)`
- **`query`** given: return the best `limit = 4` sections (more with `offset`), whole if a section is ≤ 2,500 chars,
  otherwise its best-matching ~2,500-char window plus `…(section continues: N chars, get_content(ref, section=<n>))`.
  Total body ≤ 8,000 chars. Header line:
  `<name> — corpus/llms-full.txt (2,861,784 chars · 1,240 sections) · "drawer": 4 of 37 matching sections`.
  Each section starts with `§<n> <path>` and its `source` URL when it has one. Footer: `more: offset=4` when there is
  more. No match: say so in one line and list the 15 most frequent section titles' first words as hints.
- **`section=<n>`**: return that one section, clipped at 12,000 chars (`…truncated`).
- **No `query`, no `section`**:
  - Body ≤ 12,000 chars: unchanged (the whole text).
  - Larger: an **outline** instead of the first 80 KB — the first section clipped to 1,500 chars, then the headings as
    `§<n> <title>` lines (indent by depth; collapse to top two levels when it would not fit), whole answer ≤ 7,000
    chars, ending with `pass query="…" for matching sections, or section=<n>`.
- Same rules for live-fetched bodies and for `file=…`. Everything third-party stays inside `untrusted(...)`.
- `tools/list`: add `query` (string, 1–200 chars), `section` (integer ≥ 1), `offset` (integer ≥ 0) to the
  `get_content` schema; update its description and line 4 of the server `instructions` in one short clause each.
  `tools/list` must stay < 8 KB (existing test).

## Tests
- New `tools/sections.test.mjs` (no network, fixtures inline): headings + heading trail; `#` lines inside a fenced code
  block are not headings; `---` + `Source:` page separators keep `source`; a no-heading text splits into ~3 KB chunks
  at blank lines; tiny sections merge, huge ones split; `rankSections` puts the `Drawer` section first for
  `"drawer"`; `"dialog"` finds a `Modal` section through taxonomy aliases; score-0 sections are never returned;
  `limit` / `offset` paging.
- Add to `tools/mcp.test.mjs` (real `catalog/` data, as the existing tests do; pick an entry whose local
  `llms-full.txt` is > 200 KB with `jq`/`ls -S`, never read it whole):
  - `query` answer contains the matching heading and is ≤ 9,000 bytes in total;
  - no-`query` answer on that entry is an outline ≤ 7,500 bytes;
  - `section=<n>` from that outline returns the section;
  - a small doc (navbar.gallery's llms.txt) still comes back whole — the existing tests stay green;
  - the `untrusted-content` wrapper is present in all three.

## Do not
- Edit `tools/items.mjs`, `tools/sitemap-items.mjs`, `tools/index.mjs`, `catalog/`. In `tools/search.mjs`, only
  export something that already exists if you need it.
- Run `bun tools/build.mjs`. Read `catalog/catalog.json`, `catalog/search-index.json` or files under `catalog/corpus/`
  whole (use `wc`, `head`, `grep -c`, `jq`).

## Done when
- `bun test ./tools` passes.
- Report: for 3 real calls on large docs (one with headings, one with `---`/`Source:` pages, one with no headings —
  `sunglasses.dev` if it resolves) the response bytes **before** (today's `get_content`) and **after** (`query`, and
  no-`query` outline), the top section titles returned, the time of the first and the second (cached) query, and the
  `tools/list` size.

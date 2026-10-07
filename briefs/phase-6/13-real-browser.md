# Brief 13 — Do walled design sites let the user's real Chrome in?

The user asked for this test. It drives the user's **own Chrome** (real profile, real cookies, possibly logged in)
through the claude-in-chrome MCP tools, to see whether sites that block our scripted fetchers (Bun `fetch`, `curl`,
Scrapling) let a real browser in.

## Setup
- First invoke the `claude-in-chrome` skill, then load the browser tools in ONE ToolSearch call:
  `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__tabs_close_mcp,mcp__claude-in-chrome__find`.
- Call `tabs_context_mcp` first. Open your OWN new tab(s) with `tabs_create_mcp`. Never touch, navigate or close the
  user's existing tabs. Close every tab you opened when done.
- If the extension isn't connected or the tools fail 2–3 times, stop and report that; don't loop.

## Project context
`/Users/egeayyildiz/Desktop/personal-projects/design-tools` maps UI/design websites down to individual
component/example pages (URL + name per item), so an AI agent asking for "pricing section" gets direct links across
sites. Items come from a site's sitemap or from links on its listing/category pages. Read
`briefs/phase-6/reports/09a.md` (sections 1–2 and the coordinator review at the end) for what the Scrapling probe
already found. Plain curl gets 403/Cloudflare on several of these sites.

## Sites (in this order)
1. **saasframe.io**: `/sitemap.xml` (8,834 locs via Scrapling stealth), plus a listing such as `/examples`,
   `/sections`, `/patterns`.
2. **land-book.com**: `/sitemap.xml` (index → child sitemaps, e.g. `sitemap.templates.xml`), one gallery listing.
3. **ui8.net**: `/sitemap.xml` (17,315 locs), one category listing.
4. **uiverse.io**: `/buttons`, `/buttons?page=2`, `/cards`. How many element links per page, and does pagination
   go on?
5. **colorkit.co**: `/sitemap_index.xml` / `/sitemap.xml` (even a stealth browser failed). Do palettes/gradients load?
6. **savee.com** (savee.it redirects there): does a board/user page show saves, or "Join to see more"? Is the user
   logged in?
7. **mobbin.com**: `/explore/web`, one `/explore/screens/<uuid>` page, and whether flows/apps pages show content
   (logged in or not).
8. **shadcnblocks.com**: `/blocks` and one category such as `/blocks/hero`. Are block pages listed with names?

For each, record whether the page loads with real content or shows a challenge / login wall / paywall, and whether
the user appears logged in.

## How to collect
- Sitemaps: navigate to the XML URL, then use `javascript_tool` to count `<loc>` and group by first path segment,
  e.g. `(() => { const locs=[...document.querySelectorAll('loc')].map(l=>l.textContent.trim()); …; return
  JSON.stringify({n: locs.length, byPrefix, sample: locs.slice(0,10)}); })()`. If the XML renders as text, parse
  `document.body.innerText`.
- Listing pages: `javascript_tool` to collect same-site `a[href]` (absolute URL + trimmed link text), deduped,
  grouped by the first two path segments. Never pull a whole page's text into your context; return counts and
  ≤ 15 samples.
- Save the full harvested lists (all locs; all item links + link text) as JSON under
  `~/.cache/design-tools-browser/<domain>/` (`mkdir -p`). Move large data out of `javascript_tool` in chunks
  (e.g. 2,000 at a time). If a list is over ~20k entries, save the counts plus a 500-entry sample and say so.

## Rules
- Human pace: ≥ 3 s between page loads on one site, ≤ 25 page loads per site, one site at a time.
- Do NOT log in, sign up, type into forms, buy, click "Add to cart" / "Download" / "Subscribe", or trigger any
  alert/confirm dialog. Use the session as it already is. A login the user doesn't already have = "login wall", move
  on.
- Collect only URLs, page titles and link text. Never copy paid content (component source, downloadable files,
  full descriptions). The repository is public.
- Don't use Scrapling, curl or chrome-devtools-axi for these sites; this test is only about the real browser.
- Don't run project build/test/fetch scripts, and edit nothing in the repository except your report.

## Done when
- Report `briefs/phase-6/reports/13-real-browser.md`, committed on your branch (only that file):
  1. Table: domain | loads in real browser? (content / challenge / login wall / paywall) | logged in? | what was
     reached (sitemap N locs by prefix / listing N item links) | vs Scrapling in 09a (better / same / worse) | cache
     file(s) | note.
  2. Per site, 5 example item URLs with their names/link text.
  3. Anything surprising: challenges that appeared, pages that differ when logged in, rate limiting.
  4. 3–5 lines of conclusions: does the real browser get in where Scrapling and curl didn't, and which sites are
     worth harvesting this way.
- Last line of your final message: `PHASE6-DONE-13`.

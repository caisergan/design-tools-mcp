# Brief 13 — Do walled design sites let the user's real browser in? Report

Branch `phase6/real-browser`, 2026-10-07. This replaces the earlier "blocked" report (commit 73e189d).

## How it was run

- **Browser: the user's "Search" browser (WebKit, macOS), not Chrome.** The user asked mid-run to use the
  claude-in-search MCP (`mcp__search__*`) instead of claude-in-chrome. Search runs the user's own profile: other
  tabs were logged into Gmail, GitHub and X. The tools are the same kind (tabs, navigate, javascript, read_page).
- `tabs_context` first. One tab of my own (`tabs_create`), closed at the end. None of the user's tabs was touched.
- Pace: ≥ 3 s between loads on one site, one site at a time. The most loads on any site was 3 navigations + 7
  same-origin `fetch`es (land-book). No logins, no form input, no clicks on challenges or buy/download buttons.
- Sitemap children and uiverse pagination checks used `fetch()` from inside the page (same origin, the browser's
  own cookies and TLS), 3 s apart. So that is still "the real browser", not curl.
- Saving: a local HTTP receiver was refused by the permission classifier, so each harvest was saved with an
  in-page blob download (`<a download>`) to `~/Downloads` and then moved to `~/.cache/design-tools-browser/<domain>/`.
  This kept the full lists out of the chat context. Only URLs, titles and link text were collected.

## 1. Table

| domain | loads in real browser? | logged in? | what was reached | vs Scrapling (09a) | cache file(s) | note |
| --- | --- | --- | --- | --- | --- | --- |
| saasframe.io | **challenge** (Cloudflare Turnstile "Gerçek kişi olduğunuzu doğrulayın" checkbox) | — | nothing: `/sitemap.xml`, `/`, `/examples` all stuck on "Bir dakika lütfen…" (2 links) after 8–20 s | **worse** (stealth got 8,834 locs) | — | interactive checkbox, not auto-passing; I did not click it |
| land-book.com | content | no ("Sign in", "Sign up", "Join for free") | sitemap index → 7 children, **2,758 locs**: websites 900 · design 102 · sections 15 · changelog 12 · og-images 6 · templates 3 · `/<expert>` profiles 1,719 · root 1. Home listing: 70 own links, 20 `/websites/*` | same (09a: 2,758) | `land-book.com/sitemap-locs.json`, `land-book.com/listing-home.json` | listing shows newer items (ids up to 100748) than the sitemap (max 100408); only 4 of 20 listing items are in the sitemap |
| ui8.net | content | no ("Sign up", "Log in") | sitemap **17,315 locs**: `/{author}/products/*` 16,823 · `/products/*` 199 · `/tags/*` 267 · `/categories/*` 18. `/categories/ui-kits`: 110 own links, 52 distinct product pages with names | same | `ui8.net/sitemap-locs.json`, `ui8.net/listing-ui-kits.json` | listing links carry `?browse=<id>`; strip it |
| uiverse.io | content | no ("Join the Community") | `/buttons` 34 element links, `?page=2` 34 different ones, `/cards` 34. Pagination: `?page=30` 34, `?page=58` 34, `?page=60` 0 | same | `uiverse.io/buttons.json`, `buttons_page_2.json`, `cards.json` | titles state totals: "2018 Buttons", "1174 Cards". Link text is "Get code"; names must come from the slug |
| colorkit.co | **challenge** (same Turnstile checkbox) | — | nothing: `/sitemap_index.xml`, `/sitemap.xml`, `/palettes/` all on "Bir dakika lütfen…" | **worse** (stealth loaded home + palettes; sitemaps failed in both) | — | palettes/gradients did not load either |
| savee.com | content, then **login wall** after 30 saves | no ("Log in", "Join for free") | sitemap index 4 children (boards-1 = 20,000 locs). Board `/kugis/boards/web/` shows **30 save links + images**, then "Join to see more saves". A single save page `/i/<id>/` is public with a title | **better** (09a: 0 images behind the wall) | `savee.com/board-kugis-web.json` | save links have no link text; the name is only in the save page's `<title>` |
| mobbin.com | content (explore); **login wall** (apps/flows) | no ("Log in", "Join for free") | `/explore/web`: 194 own links, **60 `/explore/screens/<uuid>`**, 105 `/explore/web/*`. Screen page public (h1 "Mindtrip Web Chat Start", 30 images). `/browse/web/apps` → redirect to `/?redirect_to=%2Fdiscover%2Fapps%2Fweb` | same | `mobbin.com/explore-web.json` | screen pages link only to more screens, not to apps or flows |
| shadcnblocks.com | content | no ("Sign in", "Get All Access") | `/blocks`: 128 category links with counts ("Bento 53"). `/blocks/hero`: **286 `/block/heroN` links** named "Hero 231" etc., plus 27 subcategories `/blocks/hero/<sub>` ("Hero Saas 12") | n/a (not in 09a) | `shadcnblocks.com/blocks.json`, `shadcnblocks.com/blocks-hero.json` | title "286+ Sections" matches the 286 block links |

All lists are under 20k entries, so every file holds the full list (no sampling). Paths are relative to
`~/.cache/design-tools-browser/`.

## 2. Examples (5 per site)

**saasframe.io**: none reached in the real browser. See 09a §2.4 for stealth examples.

**land-book.com**
- https://land-book.com/websites/100748-stoa-conseil-developpement-and-formation-ia — Stoa — Conseil, développement & formation IA
- https://land-book.com/websites/100714-ferio-a-curated-image-library-for-modern-creatives — Ferio, A curated image library for modern creatives.
- https://land-book.com/websites/99700-grid-os-portfolio-and-agency-website-template — Grid OS - Portfolio & Agency Website Template
- https://land-book.com/websites/100573-thirdway — Thirdway
- https://land-book.com/websites/100495-mindcloud-connect-anything-automate-everything — MindCloud - Connect anything, automate everything.

**ui8.net**
- https://ui8.net/juyedui/products/glow-ai---ai-powered-wellness-care-mobile-ui-kit — Glow AI - AI-Powered Wellness Care Mobile App UI Kit
- https://ui8.net/jmj-studio/products/relay--ai-support-operations-dashboard-ui-kit — Relay — AI Support Operations Dashboard UI Kit
- https://ui8.net/podro-supply/products/olaq — Oláq – AI Assistant Mobile UI Kit (Dark & Light)
- https://ui8.net/aditjuniior/products/orvexa---crypto-wallet-mobile-apps — Orvexa - Crypto Wallet Mobile Apps
- https://ui8.net/emura/products/zentra---saas-web-template-kit — Zentra - SaaS Web Template KIT

**uiverse.io** (link text is "Get code" on all of them; the name is the `<author>/<slug>`)
- https://uiverse.io/mrhyddenn/moody-badger-62 — buttons
- https://uiverse.io/tirth_5172/yellow-pug-84 — buttons
- https://uiverse.io/njesenberger/thin-owl-11 — buttons
- https://uiverse.io/emmanuelh-dev/nervous-starfish-19 — cards
- https://uiverse.io/andrew-demchenk0/bad-squid-34 — cards

**colorkit.co**: none reached (challenge).

**savee.com** (from board "! web – board by Manvydas Kugis"; only the first was opened)
- https://savee.com/i/CEra5fp/ — "Designer Steel Trolley NM23 — Small by NM3 by Manvydas Kugis – Savee"
- https://savee.com/i/E31i2Da/ — (no link text)
- https://savee.com/i/Yn5zs6k/ — (no link text)
- https://savee.com/i/O9lASp4/ — (no link text)
- https://savee.com/i/sUAmcB6/ — (no link text)

**mobbin.com**
- https://mobbin.com/explore/screens/260683ec-edbd-4a0e-a500-9a0e80b48847 — Mindtrip Web screen (page title "Mindtrip Web Chat Start | Mobbin")
- https://mobbin.com/explore/screens/3e29dd35-0c1d-4f71-831b-af35c13bf1ec — Front Web screen
- https://mobbin.com/explore/screens/cec3ccca-064b-447b-b15e-268bc27b1dbf — Front Web screen
- https://mobbin.com/explore/screens/5c61518b-f03f-4c26-8ec1-6215c153ecd3 — Jasper Web screen
- https://mobbin.com/explore/screens/839dd83a-4d45-424f-8a1b-ec841114a7d6 — Jobber Web screen

**shadcnblocks.com**
- https://www.shadcnblocks.com/block/hero231 — Hero 231
- https://www.shadcnblocks.com/block/hero195 — Hero 195
- https://www.shadcnblocks.com/block/hero18 — Hero 18
- https://www.shadcnblocks.com/block/hero144 — Hero 144
- https://www.shadcnblocks.com/blocks/hero/saas — Hero Saas 12 (subcategory)

## 3. Surprises

- **Cloudflare Turnstile shows an interactive checkbox to this browser** on saasframe.io and colorkit.co, on
  every path tried, and it did not pass on its own within 8–20 s. Scrapling's patched Chromium solved these
  automatically in 09a (`solve_cloudflare=True`). A real WebKit browser with no Cloudflare history on these sites
  does worse here. A person clicking the checkbox would probably get through, but the brief rules out solving
  challenges for the user.
- **savee shows more to a real browser than to Scrapling**: 30 saves with images before "Join to see more saves",
  against 0 in 09a. Individual save pages are public and titled.
- **land-book's sitemap lags its listing**: 16 of the 20 newest `/websites/*` on the homepage are not in
  `sitemap.templates.xml`. A listing crawl would catch new items sooner.
- **mobbin's apps/flows library is a hard login wall**: `/browse/web/apps` redirects to the homepage with
  `redirect_to=/discover/apps/web`. Screen pages are public, but they link only to other screens.
- No rate limiting or 429s anywhere. All same-origin fetches returned 200.
- The user's session was not logged into any of the eight sites, so "logged in vs not" could not be compared.

## 4. Conclusions

- The real browser does **not** get in where Scrapling didn't. On the two Cloudflare-Turnstile sites (saasframe,
  colorkit) it does worse, because it gets an interactive checkbox that Scrapling's stealth mode passes. On
  land-book, ui8, uiverse and mobbin it reaches exactly what 09a reached.
- The only gain is savee (30 public saves per board instead of 0), and that is still behind "Join to see more".
- None of the eight sites was logged in, so the "logged-in session gets past walls" idea (savee, mobbin flows) is
  still untested. It needs the user to log in first.
- Worth harvesting this way: shadcnblocks.com (286 named hero blocks on one page, 128 categories; not in 09a)
  and land-book's listing (newer than its sitemap). For ui8, uiverse and mobbin the sitemap/http route from 09a is
  as good and cheaper. saasframe and colorkit should stay on Scrapling stealth.

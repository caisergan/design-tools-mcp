# Brief 13 — Real-browser test of walled design sites: report

Branch `phase6/real-browser`, 2026-10-07.

## Status: BLOCKED — the claude-in-chrome extension was not connected

No site was visited. The brief says: "If the extension isn't connected or the tools fail 2–3 times, stop and report
that; don't loop." So I stopped.

What happened:

1. Invoked the `claude-in-chrome` skill and loaded the browser tools with the one ToolSearch call from the brief.
   That worked.
2. `tabs_context_mcp` → `Browser extension is not connected. Please ensure the Claude browser extension is
   installed and running (https://claude.ai/chrome), and that you are logged into claude.ai with the same account
   as Claude Code. …`
3. `tabs_context_mcp {createIfEmpty: true}` → same error.
4. `list_connected_browsers` → `[]`: no Chrome extension instance is connected to this account.

No tab was opened, so there was nothing to close. None of the user's existing tabs were touched. No fallback was
used, because the brief rules out Scrapling, curl and chrome-devtools-axi for these sites. Nothing was written to
`~/.cache/design-tools-browser/`.

## 1. Table

| domain | loads in real browser? | logged in? | what was reached | vs Scrapling (09a) | cache file(s) | note |
| --- | --- | --- | --- | --- | --- | --- |
| saasframe.io | not tested | — | — | — | — | extension not connected |
| land-book.com | not tested | — | — | — | — | extension not connected |
| ui8.net | not tested | — | — | — | — | extension not connected |
| uiverse.io | not tested | — | — | — | — | extension not connected |
| colorkit.co | not tested | — | — | — | — | extension not connected |
| savee.com | not tested | — | — | — | — | extension not connected |
| mobbin.com | not tested | — | — | — | — | extension not connected |
| shadcnblocks.com | not tested | — | — | — | — | extension not connected |

## 2. Example item URLs

None collected.

## 3. Surprises

The only one: the extension was not connected even though the brief assumes it is. `list_connected_browsers`
returned an empty list, which means Chrome either isn't running with the Claude extension, or the extension is
signed in to a different claude.ai account than Claude Code.

## 4. Conclusions

- This run can't say whether the real browser gets in where Scrapling and curl didn't.
- To re-run: open Chrome with the Claude extension (https://claude.ai/chrome), signed in to the same claude.ai
  account as Claude Code. Restart Chrome if the extension was just installed. Confirm that
  `list_connected_browsers` returns this machine, then dispatch brief 13 again unchanged.
- The open questions are the same as in 09a's coordinator review. Can a logged-in session get past savee's "Join to
  see more" and mobbin's flows? Can a real browser load colorkit's sitemaps, which even stealth couldn't fetch?

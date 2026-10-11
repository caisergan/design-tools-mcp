#!/usr/bin/env bun
// tools/crawl.mjs: digest extraction from saved HTML fixtures (tools/fixtures/crawl/, written for these tests),
// boilerplate trim, text caps, extra-page choice, and the fetch rules (disabled hosts, robots.txt) — no network.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";
import { createFetcher } from "./registry-urls.mjs";
import {
  extractHtml,
  extractMarkdown,
  visibleText,
  cleanLines,
  trimPages,
  cutText,
  pickExtraPages,
  bucketOf,
  blockReason,
  thinReason,
  disabledHost,
  crawlEntry,
  LIMITS,
} from "./crawl.mjs";

const fixture = (name) => readFileSync(join(ROOT, "tools", "fixtures", "crawl", name), "utf8");
const HOME = "https://widgetshelf.test";

test("title, meta / og description, og:image, h1–h3 and nav texts come out of the page", () => {
  const p = extractHtml(fixture("home.html"), HOME);
  expect(p.title).toBe("Widget Shelf – Copy-paste UI widgets");
  expect(p.description).toBe("Widget Shelf is a free collection of 120 copy-paste UI widgets for React & Tailwind.");
  expect(p.og_image).toBe("https://widgetshelf.test/og.png");
  expect(p.headings).toEqual({ h1: ["Widgets you can copy"], h2: ["Popular", "Pricing"], h3: ["Install"] });
  expect(p.nav).toEqual(["Widget Shelf", "Docs", "Components", "Pricing", "GitHub"]);
});

test("visible text drops scripts, styles, svg, <pre> code, nav, footer, the cookie banner and chrome lines", () => {
  const text = visibleText(fixture("home.html"));
  expect(text).toContain("120 animated widgets: buttons, cards, navbars and toasts.");
  expect(text).toContain("Free forever. A Pro plan adds 40 blocks.");
  for (const gone of ["never page text", "color: red", "svg text", "npx shadcn", "All rights reserved", "We use cookies", "Accept all", "Skip to content", "GitHub"])
    expect(text).not.toContain(gone);
  expect(text.split("\n").filter((l) => l === "View")).toHaveLength(1); // a line repeated in the page is kept once
});

test("cleanLines drops cookie and chrome lines and in-page repeats", () => {
  expect(cleanLines("Hello\nWe use cookies to personalise content.\nAccept all\nMenu\nHello\nWorld")).toBe("Hello\nWorld");
});

test("internal links: same site, absolute, no hash / mailto / assets, deduped in page order", () => {
  const urls = extractHtml(fixture("home.html"), HOME).links.map((l) => l.url);
  expect(urls).toContain("https://widgetshelf.test/components/shimmer-button");
  expect(urls).toContain("https://widgetshelf.test/components/glass-card?ref=home");
  expect(urls.filter((u) => u.endsWith("/shimmer-button"))).toHaveLength(1);
  expect(urls.some((u) => u.includes("github.com") || u.startsWith("mailto:") || u.endsWith(".png"))).toBe(false);
});

test("markdown digests (llms.txt, README): headings, text without code blocks / badges, links resolved against the base", () => {
  const md = "# Kit\n[![build](https://img.test/b.svg)](https://ci.test)\n> A kit of 40 blocks.\n## Install\n```sh\nnpm i kit\n```\n- [Docs](/docs) and [Repo](https://github.com/o/kit)\n### Usage\n<img src=x.png> Use it.";
  const p = extractMarkdown(md, "https://kit.test/");
  expect(p.title).toBe("Kit");
  expect(p.headings).toEqual({ h1: ["Kit"], h2: ["Install"], h3: ["Usage"] });
  expect(p.text).not.toContain("npm i kit");
  expect(p.text).not.toContain("img.test");
  expect(p.text).toContain("> A kit of 40 blocks.");
  expect(p.links.map((l) => l.url)).toEqual(["https://kit.test/docs"]);
});

test("boilerplate repeated across pages stays on the first page only; nav too", () => {
  const home = extractHtml(fixture("home.html"), HOME);
  const pricing = extractHtml(fixture("pricing.html"), `${HOME}/pricing`);
  const [a, b] = trimPages([{ ...home }, { ...pricing }], { budget: 10_000, heads: [5_000] });
  expect(a.text).toContain("120 animated widgets");
  expect(b.text).not.toContain("120 animated widgets");
  expect(b.text).toContain("Pro costs $49 once");
  expect(b.nav).toBeUndefined(); // every nav text was already on the homepage
});

test("text caps: the heads keep their share, the rest share the budget, a short page passes its share on", () => {
  const long = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} line ${i} with some words`).join("\n");
  const pages = [{ text: long(400, "home") }, { text: long(400, "docs") }, { text: "short page" }, { text: long(400, "pricing") }];
  trimPages(pages, { budget: 9_000, heads: [4_000], restCap: 3_000 });
  expect(pages[0].text.length).toBeLessThanOrEqual(4_000 + 10);
  expect(pages[0].text.endsWith("[…cut]")).toBe(true);
  expect(pages[2].text).toBe("short page");
  for (const p of [pages[1], pages[3]]) expect(p.text.length).toBeLessThanOrEqual(3_000 + 10);
  const total = pages.reduce((n, p) => n + p.text.length, 0);
  expect(total).toBeLessThanOrEqual(9_000 + 40);
  expect(cutText("a\nb\nc", 100)).toBe("a\nb\nc");
  expect(LIMITS.pageText).toBe(12_000);
});

test("extra pages: one per bucket (docs, components, pricing, about, license), shallow index pages first, never blog / login / locale / assets", () => {
  const links = extractHtml(fixture("home.html"), HOME).links.map((l) => ({ url: l.url, from: "home" }));
  const picked = pickExtraPages(HOME, [...links, { url: `${HOME}/docs/getting-started/install/deep`, from: "llms" }, { url: `${HOME}/components`, from: "nav" }, { url: `${HOME}/docs`, from: "sitemap" }]);
  expect(picked.map((p) => p.url)).toEqual([`${HOME}/docs`, `${HOME}/components`, `${HOME}/pricing`, `${HOME}/about`]);
  expect(pickExtraPages(HOME, links, { max: 10 }).map((p) => p.bucket)).toContain("license");
  for (const bad of ["/blog/why-widgets", "/login", "/fr/docs", "/logo.png", "/components/glass-card?ref=home"]) expect(picked.some((p) => p.url === HOME + bad)).toBe(false);
  expect(bucketOf(`${HOME}/style/patterns`)).toBeNull(); // only the first path segment names a bucket
});

test("walled and JS-only pages are blocked with their reason; a title-and-meta page is thin", () => {
  const shell = fixture("shell.html");
  expect(blockReason({ status: 200, finalUrl: HOME }, extractHtml(shell, HOME), shell)).toMatch(/^js-only/);
  const wall = fixture("challenge.html");
  expect(blockReason({ status: 403, finalUrl: HOME }, extractHtml(wall, HOME), wall)).toBe("bot-wall (http 403)");
  expect(blockReason({ status: 200, finalUrl: HOME }, extractHtml(wall, HOME), wall)).toBe("bot-wall (challenge page)");
  expect(blockReason({ status: 200, finalUrl: `${HOME}/login?next=/` }, extractHtml(fixture("home.html"), HOME))).toMatch(/^login-required/);
  expect(blockReason({ status: 0, error: "robots" }, null)).toBe("robots.txt disallows it");
  expect(blockReason({ status: 200, finalUrl: HOME }, extractHtml(fixture("home.html"), HOME), fixture("home.html"))).toBeNull();
  expect(thinReason({ text: "", description: "A theme editor." }, '<div id="__next"></div>')).toMatch(/^only title and meta description/);
  expect(thinReason(extractHtml(fixture("pricing.html"), HOME), fixture("pricing.html"))).toBeNull(); // short, but no app shell
});

// ---------------------------------------------------------------- crawlEntry with a fake network

/** createFetcher over a map of url → { status, type, text }; records every url it was asked for. */
function fakeFetcher(pages) {
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    const p = pages[url];
    if (!p) return { status: 404, type: "text/html", finalUrl: url, title: "", text: "" };
    return { status: p.status ?? 200, type: p.type ?? "text/html", finalUrl: p.finalUrl ?? url, title: "", text: p.text };
  };
  return { fetcher: createFetcher({ get, wait: async () => {}, interval: 0 }), asked };
}
const entry = (url, kind = "site") => ({ id: "fixture-entry", url, kind, domain: new URL(url).hostname.replace(/^www\./, ""), name: "Fixture", desc: "A fixture.", categories: ["components"], origins: ["curated"], probe: {} });
const ctx = (fetcher, hosts = new Map()) => ({ fetcher, hosts, siteOf: () => null, now: Date.parse("2026-10-11T00:00:00Z") });

test("a host scrapling-hosts.json disables is never fetched: the digest is blocked with the owner decision", async () => {
  const { fetcher, asked } = fakeFetcher({});
  const hosts = new Map([["walled.test", { mode: "http", enabled: false, note: "owner decision" }]]);
  expect(disabledHost("https://www.walled.test/x", hosts)).toBe("owner decision");
  expect(disabledHost("https://shop.walled.test/x", hosts)).toBe("owner decision"); // a subdomain is the same owner
  expect(disabledHost("https://notwalled.test", hosts)).toBeNull();
  const d = await crawlEntry(entry("https://walled.test"), ctx(fetcher, hosts));
  expect(asked).toEqual([]);
  expect(d.status).toBe("blocked");
  expect(d.reason).toBe("host disabled (owner decision)");
  expect(d.hints.name).toBe("Fixture");
});

test("a redirect onto a disabled host is dropped unread", async () => {
  const hosts = new Map([["walled.test", { mode: "http", enabled: false, note: "owner decision" }]]);
  const { fetcher } = fakeFetcher({ [`${HOME}/robots.txt`]: { status: 404, text: "" }, [HOME]: { text: fixture("home.html"), finalUrl: "https://walled.test/" } });
  const d = await crawlEntry(entry(HOME), ctx(fetcher, hosts));
  expect(d.status).toBe("blocked");
  expect(d.reason).toBe("redirected to a disabled host (walled.test: owner decision)");
  expect(JSON.stringify(d)).not.toContain("120 animated widgets");
});

test("robots.txt is read once per host and a disallowed page is skipped, never requested", async () => {
  const { fetcher, asked } = fakeFetcher({
    [`${HOME}/robots.txt`]: { type: "text/plain", text: "User-agent: *\nDisallow: /pricing\n" },
    [HOME]: { text: fixture("home.html") },
    [`${HOME}/docs`]: { text: "<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>Install the widgets with one command and start building pages today with forty blocks.</p></main></body></html>" },
    [`${HOME}/components`]: { text: "<html><head><title>Components</title></head><body><main><h1>Components</h1><p>Shimmer button, glass card, floating navbar, toast stack and a dozen more widgets for React.</p></main></body></html>" },
  });
  const d = await crawlEntry(entry(HOME), ctx(fetcher));
  expect(asked.filter((u) => u.endsWith("/robots.txt"))).toHaveLength(1);
  expect(asked).not.toContain(`${HOME}/pricing`);
  expect(d.skipped).toContainEqual({ url: `${HOME}/pricing`, why: "robots.txt disallows it" });
  expect(d.status).toBe("ok");
  expect(d.pages.map((p) => p.url)).toEqual([HOME, `${HOME}/docs`, `${HOME}/components`]);
  expect(d.pages[1].picked_as).toBe("docs");
  expect(d.pages[0].links.every((l) => l.startsWith("/"))).toBe(true); // links are stored as paths
  expect(d.tokens).toBeGreaterThan(100);
  expect(d.tokens).toBeLessThan(6_000);
});

test("a JS-only homepage blocks a site that has nothing else to read; a page entry reads only itself", async () => {
  const { fetcher, asked } = fakeFetcher({ [`${HOME}/robots.txt`]: { status: 404, text: "" }, [HOME]: { text: fixture("shell.html") } });
  const d = await crawlEntry(entry(HOME), ctx(fetcher));
  expect(d.status).toBe("blocked");
  expect(d.reason).toMatch(/^js-only/);
  expect(asked).toEqual([`${HOME}/robots.txt`, HOME]); // a walled homepage: no more doors knocked on
  const page = fakeFetcher({ [`${HOME}/robots.txt`]: { status: 404, text: "" }, [`${HOME}/pricing`]: { text: fixture("pricing.html") } });
  const p = await crawlEntry(entry(`${HOME}/pricing`, "page"), ctx(page.fetcher));
  expect(p.status).toBe("ok");
  expect(page.asked).toEqual([`${HOME}/robots.txt`, `${HOME}/pricing`]);
});

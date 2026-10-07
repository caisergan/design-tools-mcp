#!/usr/bin/env bun
// Pattern layer (MCP-PLAN 6.2): template matching, the sitemap adapter, filter pages and the guesser. No network:
// sitemaps, HTML and `taken` maps are passed in.
import { test, expect } from "bun:test";
import { compilePattern, hrefs, humanise, loadFilters, matchUrl, sitemapItems, sitemapScan, validatePattern } from "./sitemap-items.mjs";
import { nextPageUrl, parseDomainList, suggest } from "./patterns.mjs";

const ov = { assetDomains: new Set(), components: {} };
const S = (loc, lastmod) => ({ loc, ...(lastmod ? { lastmod } : {}) });
const scan = (domain, id, opts) => sitemapScan(domain, { id }, { overrides: ov, taken: new Map(), ...opts });
const match = (pattern, url) => matchUrl(url, compilePattern(pattern, { taxonomy: undefined }));
const caps = (m) => (m ? m.captures.map(({ kind, raw, id }) => ({ kind, raw, ...(id ? { id } : {}) })) : null);

// ---------------------------------------------------------------- templates

test("navbar.gallery: /navbar/{name}, a fixed element and a trailing slash/query ignored", () => {
  const pattern = { match: "/navbar/{name}", element: "navbar", granularity: "example", status: "hand" };
  expect(caps(match(pattern, "https://navbar.gallery/navbar/stripe/"))).toEqual([{ kind: "name", raw: "stripe" }]);
  expect(match(pattern, "https://navbar.gallery/navbar/stripe?utm_source=x")?.captures[0].raw).toBe("stripe");
  expect(match(pattern, "https://navbar.gallery/navbar/a/b")).toBeNull(); // one template segment ↔ one path segment
  expect(match(pattern, "https://navbar.gallery/browse/stripe")).toBeNull();
});

test("sectionmaster: {element} never reads an element out of a company name", () => {
  const c = compilePattern({ match: "/sections/{name}-{element}-{n}", status: "hand" });
  const m = matchUrl("https://sectionmaster.com/sections/navattic-com-hero-1", c);
  expect(caps(m)).toEqual([
    { kind: "name", raw: "navattic-com" },
    { kind: "element", raw: "hero", id: "hero" },
    { kind: "n", raw: "1" },
  ]);
  const r = scan("sectionmaster.com", "sm", {
    pattern: { match: "/sections/{name}-{element}-{n}", status: "hand" },
    sitemap: { urls: [S("https://sectionmaster.com/sections/navattic-com-hero-1")] },
  });
  expect(r.items[0].elements).toEqual(["hero"]);
  expect(r.items[0].id).toBe("sm/navattic-com-hero-1");
  expect(r.items[0].name).toBe("Navattic Com Hero 1");
});

test("daisyui: /components/{element}/ matches ids and aliases, and slugs the element segment", () => {
  const pattern = { match: "/components/{element}", status: "hand" };
  expect(caps(match(pattern, "https://daisyui.com/components/navbar/"))).toEqual([{ kind: "element", raw: "navbar", id: "navbar" }]);
  expect(match(pattern, "https://daisyui.com/components/button-group/")?.captures[0].id).toBe("button");
  expect(match(pattern, "https://daisyui.com/components/not-a-thing/")).toBeNull();
  const r = scan("daisyui.com", "daisy", { pattern, sitemap: { urls: [S("https://daisyui.com/components/button-group/")] } });
  expect(r.items[0].id).toBe("daisy/button-group");
  expect(r.items[0].name).toBe("Button Group");
});

test("{author} widens the id and the display name", () => {
  const pattern = { match: "/components/{author}/{name}", status: "hand" };
  const r = scan("x.dev", "x", { pattern, sitemap: { urls: [S("https://x.dev/components/jane-doe/hero-split")] } });
  expect(r.items[0].id).toBe("x/jane-doe-hero-split");
  expect(r.items[0].name).toBe("Jane Doe Hero Split");
});

test("humanise", () => {
  expect(humanise("mega-menu-acme")).toBe("Mega Menu Acme");
  expect(humanise("404")).toBe("404");
});

test("exclude drops matching urls", () => {
  const pattern = { match: ["/components/{name}", "/blocks/{name}"], exclude: ["/components/{name}/api"], status: "hand" };
  expect(match(pattern, "https://x.dev/blocks/hero")?.captures[0].raw).toBe("hero");
  expect(match(pattern, "https://x.dev/components/card/api")).toBeNull();
  const r = scan("x.dev", "x", { pattern, sitemap: { urls: [S("https://x.dev/components/card"), S("https://x.dev/components/card/api")] } });
  expect(r.items.map((i) => i.id)).toEqual(["x/card"]);
});

// ---------------------------------------------------------------- validation

test("variants_from is validated against the pattern's element", () => {
  expect(() => validatePattern({ match: "/navbar/{name}", element: "navbar", variants_from: { "mega-menu": "/mega-menu" }, status: "hand" }, "a.com")).not.toThrow();
  expect(() => validatePattern({ match: "/navbar/{name}", element: "navbar", variants_from: { accordion: "/a" }, status: "hand" }, "a.com")).toThrow(/not a variant of navbar/);
  expect(() => validatePattern({ match: "/hero/{name}", variants_from: { nope: "/n" }, status: "hand" }, "a.com")).toThrow(/not a variant id/);
  // an alias key is not a variant either
  expect(() => validatePattern({ match: "/navbar/{name}", element: "navbar", variants_from: { "mega menu": "/m" }, status: "hand" }, "a.com")).toThrow(/not a variant of navbar/);
});

test("a broken pattern file throws with its name", () => {
  expect(() => validatePattern({ match: "/components/{slug}", status: "hand" }, "a.com")).toThrow(/a\.com.*unknown placeholder/);
  expect(() => validatePattern({ match: "components/{name}", status: "hand" }, "a.com")).toThrow(/"\/"-path/);
  expect(() => validatePattern({ match: "/components/{name}", granularity: "thing", status: "hand" }, "a.com")).toThrow(/granularity/);
  expect(() => validatePattern({ match: "/components/{name}", element: "not-an-element", status: "hand" }, "a.com")).toThrow(/not a taxonomy element/);
  expect(() => validatePattern({ match: "/components/{name}", status: "auto-ish" }, "a.com")).toThrow(/status/);
  expect(() => validatePattern({ skip: "no component pages", status: "hand" }, "a.com")).not.toThrow();
});

// ---------------------------------------------------------------- adapter

test("dedupe: registry and llms items win by id and by url", () => {
  const pattern = { match: "/navbar/{name}", element: "navbar", status: "hand" };
  const taken = new Map();
  taken.set("ng/taken-by-url", { id: "ng/taken-by-url", url: "https://navbar.gallery/navbar/shared" });
  taken.set("ng/stripe", { id: "ng/stripe", from: "registry", name: "Stripe" });
  const r = scan("navbar.gallery", "ng", {
    pattern,
    taken,
    sitemap: { urls: [S("https://navbar.gallery/navbar/shared/"), S("https://navbar.gallery/navbar/stripe"), S("https://navbar.gallery/navbar/fresh")] },
  });
  expect(r.items.map((i) => i.id)).toEqual(["ng/fresh"]);
  expect(r.skipped).toBe(2);
  expect(taken.has("ng/fresh")).toBe(true); // our items join `taken` for the next adapter
});

test("ids and names come from the whole captured segment, never from sitemap order", () => {
  const pattern = { match: "/sections/{name}-{element}-{n}", granularity: "example", status: "hand" };
  const urls = [
    "https://sectionmaster.com/sections/rig-ai-hero-1",
    "https://sectionmaster.com/sections/rig-ai-hero-2",
    "https://sectionmaster.com/sections/wist-chat-hero-1",
  ];
  const a = scan("sectionmaster.com", "sm", { pattern, sitemap: { urls: urls.map((u) => S(u)) } });
  expect(a.items.map((i) => [i.id, i.name, i.elements])).toEqual([
    ["sm/rig-ai-hero-1", "Rig Ai Hero 1", ["hero"]],
    ["sm/rig-ai-hero-2", "Rig Ai Hero 2", ["hero"]],
    ["sm/wist-chat-hero-1", "Wist Chat Hero 1", ["hero"]], // chat is the company, not a second element
  ]);
  const b = scan("sectionmaster.com", "sm", { pattern, sitemap: { urls: [...urls].reverse().map((u) => S(u)) } });
  expect(b.items.map((i) => [i.id, i.name]).sort()).toEqual(a.items.map((i) => [i.id, i.name]).sort());
});

test("the same page listed twice becomes one item", () => {
  const pattern = { match: "/sections/{name}-{element}-{n}", status: "hand" };
  const r = scan("sm.dev", "sm", {
    pattern,
    sitemap: { urls: [S("https://sm.dev/sections/acme-cta-1"), S("https://sm.dev/sections/acme-cta-1/"), S("https://sm.dev/sections/acme-cta-2")] },
  });
  expect(r.items.map((i) => i.id)).toEqual(["sm/acme-cta-1", "sm/acme-cta-2"]);
});

test("www and non-www are the same page for dedupe and filter tagging", () => {
  const pattern = { match: "/navbar/{name}", element: "navbar", variants_from: { sticky: "/type/sticky" }, status: "hand" };
  const taken = new Map();
  taken.set("ng/x", { id: "ng/x", url: "https://navbar.gallery/navbar/www-page" });
  const filters = { variants: { sticky: ["https://www.navbar.gallery/navbar/sticky-one"] }, elements: {}, urls: [] };
  const r = scan("navbar.gallery", "ng", {
    pattern,
    taken,
    filters,
    sitemap: { urls: [S("https://www.navbar.gallery/navbar/www-page"), S("https://www.navbar.gallery/navbar/sticky-one")] },
  });
  expect(r.items.map((i) => [i.id, i.variants.navbar || []])).toEqual([["ng/sticky-one", ["sticky"]]]);
  expect(r.skipped).toBe(1);
});

test("auto patterns mark their items", () => {
  const r = scan("x.dev", "x", { pattern: { match: "/components/{name}", status: "auto" }, sitemap: { urls: [S("https://x.dev/components/navbar-mega")] } });
  expect(r.items[0].auto).toBe(true);
  expect(r.items[0].elements).toEqual(["navbar"]); // tagItem on the name when no element is fixed or captured
  expect(r.items[0].variants).toEqual({ navbar: ["mega-menu"] });
  const hand = scan("x.dev", "x", { pattern: { match: "/components/{name}", status: "hand" }, sitemap: { urls: [S("https://x.dev/components/navbar-mega")] } });
  expect(hand.items[0].auto).toBeUndefined();
});

test("skip and missing parents yield nothing", () => {
  expect(sitemapItems("x.dev", { id: "x" }, { pattern: { skip: "blog only", status: "hand" }, sitemap: { urls: [S("https://x.dev/a-b")] } })).toEqual([]);
  expect(sitemapItems("x.dev", undefined, { pattern: { match: "/a/{name}", status: "hand" }, sitemap: { urls: [S("https://x.dev/a/b")] } })).toEqual([]);
});

// ---------------------------------------------------------------- filter pages and urls_from

const FILTER_HTML = `<html><body>
<a href="/navbar/acme">Acme</a>
<a href="/navbar/mega-menu-venus">Venus</a>
<a href="https://navbar.gallery/navbar/dropdown-x?utm_source=nl">X</a>
<a href="/blog/navbar-tips">blog</a>
<a href="#top">top</a>
<a href="mailto:a@b.c">mail</a>
<a href="/navbar/acme/">Acme again</a>
</body></html>`;

test("filter page links are collected, resolved and matched against the pattern", () => {
  const pattern = { match: "/navbar/{name}", element: "navbar", variants_from: { "mega-menu": "/mega-menu" }, status: "hand" };
  const filters = loadFilters("navbar.gallery", pattern, { exists: (p) => p.endsWith("v-mega-menu.html"), readFile: () => FILTER_HTML });
  expect(filters.variants["mega-menu"]).toEqual(["https://navbar.gallery/navbar/acme", "https://navbar.gallery/navbar/dropdown-x", "https://navbar.gallery/navbar/mega-menu-venus"]);
  const r = scan("navbar.gallery", "ng", {
    pattern,
    filters,
    sitemap: { urls: [S("https://navbar.gallery/navbar/acme"), S("https://navbar.gallery/navbar/mega-menu-venus"), S("https://navbar.gallery/navbar/other")] },
  });
  expect(r.items.map((i) => [i.id, i.variants.navbar || []])).toEqual([
    ["ng/acme", ["mega-menu"]],
    ["ng/mega-menu-venus", ["mega-menu"]],
    ["ng/other", []],
  ]);
});

test("elements_from tags membership, urls_from supplies the urls when there is no sitemap", () => {
  const pattern = { match: "/sections/{name}", elements_from: { footer: "/category/footers" }, status: "hand" };
  const filters = loadFilters("x.dev", pattern, { exists: (p) => p.endsWith("e-footer.html"), readFile: () => `<a href="/sections/acme-bottom">bottom</a><a href="/blog/x">b</a>` });
  expect(filters.elements.footer).toEqual(["https://x.dev/sections/acme-bottom"]);
  const r = scan("x.dev", "x", { pattern, filters, sitemap: { urls: [S("https://x.dev/sections/acme-bottom"), S("https://x.dev/sections/acme-top")] } });
  expect(r.items.map((i) => [i.id, i.elements])).toEqual([
    ["x/acme-bottom", ["footer"]],
    ["x/acme-top", []],
  ]);
});

test("urls_from is the only url source for a site without a sitemap", () => {
  const pattern = { match: "/hero/{name}", element: "hero", granularity: "example", status: "hand", urls_from: ["/"] };
  const html = `<a href="/hero/acme">a</a><a href="/hero/venus">b</a><a href="/pricing">c</a>`;
  const filters = loadFilters("supahero.io", pattern, { exists: (p) => p.endsWith("urls-1.html"), readFile: () => html });
  expect(filters.urls).toEqual(["https://supahero.io/hero/acme", "https://supahero.io/hero/venus"]);
  const r = scan("supahero.io", "supa", { pattern, sitemap: null, filters });
  expect(r.items.map((i) => i.id)).toEqual(["supa/acme", "supa/venus"]);
  expect(r.items[0].granularity).toBe("example");
});

test("pagination is followed only when the page links to it plainly", () => {
  expect(nextPageUrl(`<a href="/components?page=2">next</a>`, "https://x.dev/components", 2)).toBe("https://x.dev/components?page=2");
  expect(nextPageUrl(`<a href="https://x.dev/components?page=2">next</a>`, "https://x.dev/components?page=1", 2)).toBe("https://x.dev/components?page=2");
  expect(nextPageUrl(`<a href="/blog?page=2">next</a>`, "https://x.dev/components", 2)).toBeNull();
  expect(nextPageUrl(`<a href="/components?page=3">next</a>`, "https://x.dev/components", 2)).toBeNull();
  // Webflow's hashed pagination param (navbar.gallery's filter pages)
  expect(nextPageUrl(`<a href="?9edfe7e5_page=2" aria-label="Next Page">n</a>`, "https://navbar.gallery/type/mega-menu", 2)).toBe("https://navbar.gallery/type/mega-menu?9edfe7e5_page=2");
  expect(nextPageUrl(`<a href="?9edfe7e5_page=2">n</a>`, "https://navbar.gallery/type/mega-menu?9edfe7e5_page=1", 2)).toBe("https://navbar.gallery/type/mega-menu?9edfe7e5_page=2");
});

test("hrefs resolves, decodes and skips non-links", () => {
  expect(hrefs(`<a class=x href='/a?b=1&amp;c=2'>1</a><a HREF="mailto:a@b.c">m</a><a href="#x">h</a>`, "https://x.dev/root/")).toEqual(["https://x.dev/a?b=1&c=2"]);
});

// ---------------------------------------------------------------- guesser

const sitemapOf = (paths) => ({ urls: paths.map((p) => S(`https://x.dev${p}`)) });
const paths = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test("guesser: a /components/* site is high confidence", () => {
  const rows = suggest(sitemapOf(paths(12, (i) => `/components/thing-${i}`)), { domain: "x.dev", overrides: ov });
  expect(rows[0]).toMatchObject({ template: "/components/{name}", children: 12, high: true });
  expect(rows[0].samples).toHaveLength(5);
});

test("guesser: an element prefix (/navbar/*) is high confidence", () => {
  const rows = suggest(sitemapOf(paths(11, (i) => `/navbar/acme-${i}`)), { domain: "x.dev", overrides: ov });
  expect(rows.find((r) => r.template === "/navbar/{name}")).toMatchObject({ high: true, children: 11 });
});

test("guesser: a blog-only site is low confidence", () => {
  const rows = suggest(sitemapOf(paths(20, (i) => `/blog/post-${i}`)), { domain: "x.dev", overrides: ov });
  expect(rows.every((r) => !r.high)).toBe(true);
  expect(rows[0].why).toMatch(/meta segment "blog"/);
});

test("guesser: few children or no element naming stays low; numeric leaves are not names", () => {
  expect(suggest(sitemapOf(paths(4, (i) => `/components/thing-${i}`)), { domain: "x.dev", overrides: ov })).toEqual([]);
  const rand = suggest(sitemapOf(paths(12, (i) => `/misc/item-${i}`)), { domain: "x.dev", overrides: ov });
  expect(rand.every((r) => !r.high)).toBe(true);
  const numeric = suggest(sitemapOf(paths(12, (i) => `/misc/thing/${i}`)), { domain: "x.dev", overrides: ov });
  expect(numeric.map((r) => r.template)).toEqual(["/misc/{name}/{n}"]); // leaves are numbers: only the two-segment grouping
});

test("guesser: two-segment galleries become {element}/{n} or {name}/{n}", () => {
  const el = suggest(sitemapOf(paths(12, (i) => `/blocks/hero/${i + 1}`)), { domain: "x.dev", overrides: ov });
  expect(el.find((r) => r.template === "/blocks/{element}/{n}")).toMatchObject({ high: true, elemPct: 100 });
  const other = suggest(sitemapOf(paths(12, (i) => `/blocks/landing-${i}/1`)), { domain: "x.dev", overrides: ov });
  expect(other.find((r) => r.template === "/blocks/{name}/{n}")).toMatchObject({ high: true });
  expect(other.some((r) => r.template === "/blocks/{element}/{n}")).toBe(false);
});

test("domain lists are read from column 2", () => {
  expect(parseDomainList("entry_id\tdomain\tcurated\nfoo\tx.dev\t\nbar\t\t\n")).toEqual(["x.dev"]);
});

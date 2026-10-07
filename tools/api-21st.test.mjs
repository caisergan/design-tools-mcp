#!/usr/bin/env bun
// Adapter 5 (21st.dev): the pure parsing/robots/url rules, the item adapter on injected data,
// then a check over the generated catalog/corpus/sites/21st.dev/components.json. No network.
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { UA, COMPONENTS_FILE, apiItems, componentUrls, decodeEntities, errName, fetchComponent, fetchPage, getText, parsePage, robotsCheck, stripTitleSuffix, tagPageKeys } from "./api-21st.mjs";
import { loadJSON } from "./lib.mjs";

const ov = { assetDomains: new Set(), components: {} };

// The shape of a component page: Next.js streams the head, so the metadata sits inside the body,
// after the RSC payload, with `content` as the last attribute. (<title> and the meta are adjacent.)
const html = (title, desc) =>
  `<!DOCTYPE html><html><head><meta charSet="utf-8"/><title>${
    title ?? ""
  }</title><meta name="description" content="${desc ?? ""}"/><link rel="canonical" href="https://21st.dev/@a/components/b"/></head><body><script>self.__next_f.push([1,"x"])</script></body></html>`;
const ogHtml = (title, desc) =>
  `<!DOCTYPE html><html><head><meta property="og:title" content="${title}"/><meta property="og:description" content="${desc}"/></head><body></body></html>`;

test("parsePage keeps the title and description, dropping the site suffix", () => {
  const p = parsePage(html("Earth Blaze | Community Components | 21st", "A reusable, interactive Earth horizon. "));
  expect(p).toEqual({ title: "Earth Blaze", description: "A reusable, interactive Earth horizon." });
  expect(parsePage(html("Component Not Found | 21st", "A community registry.")).title).toBe("Component Not Found");
});

test("parsePage decodes entities and collapses whitespace", () => {
  expect(parsePage(html("Mac&amp;Cheese", "Apple&#x27;s\n  product   pages &nbsp;— with &#8212; dash")).description).toBe(
    "Apple's product pages — with — dash",
  );
  expect(decodeEntities("&amp;&lt;&gt;&quot;&#39;&#x27;&nbsp;&unknown;")).toBe("&<>\"'' &unknown;"); // &nbsp; collapses to a plain space
});

test("parsePage falls back to og: tags, and reports a page with neither as null", () => {
  expect(parsePage(ogHtml("Fallback Card | Community Components | 21st", "og tail text"))).toEqual({ title: "Fallback Card", description: "og tail text" });
  expect(parsePage("<html><head></head><body>no metadata at all</body></html>")).toBeNull();
  expect(parsePage("")).toBeNull();
  expect(parsePage(html("Only A Title | 21st", ""))).toEqual({ title: "Only A Title", description: "" });
});

test("stripTitleSuffix only drops the site's own trailing segments", () => {
  expect(stripTitleSuffix("Earth Blaze | Community Components | 21st")).toBe("Earth Blaze");
  expect(stripTitleSuffix("Cards & Tables | 21st.dev")).toBe("Cards & Tables");
  expect(stripTitleSuffix("Yes | No")).toBe("Yes | No");
  expect(stripTitleSuffix("Pricing")).toBe("Pricing");
});

test("componentUrls takes only component pages, deduped, URL case preserved", () => {
  const locs = [
    "https://21st.dev/@Legacy/components/earth-blaze",
    "https://21st.dev/@Legacy/components/earth-blaze",
    "https://21st.dev/@ruixen.ui/components/aurora",
    "https://21st.dev/community/components/s/hero",
    "https://21st.dev/@ruixen.ui",
    "https://21st.dev/blog/something",
    "https://21st.dev/community/components",
    "/@a/components/b?x=1",
  ];
  expect(componentUrls(locs).map((c) => c.key)).toEqual(["Legacy/earth-blaze", "ruixen.ui/aurora", "a/b"]);
  expect(componentUrls(locs)[0].url).toBe("https://21st.dev/@Legacy/components/earth-blaze");
  expect(componentUrls([{ loc: "https://21st.dev/@a/components/b" }])).toHaveLength(1);
});

test("tagPageKeys reads the server-rendered component links of a category page", () => {
  const page = '<li><a href="/@sensewood8/components/responsive-hero-banner"><img/></a></li><a href="/@Legacy/components/earth-blaze">x</a><a href="/@Legacy/components/earth-blaze">x</a><a href="/@a/components/b?sort=new#top">q</a><a href="/community/components/s/hero">tag</a>';
  expect(tagPageKeys(page)).toEqual(["sensewood8/responsive-hero-banner", "Legacy/earth-blaze", "a/b"]);
});

// The live robots.txt of 2026-10-07 (verbatim groups that matter here).
const ROBOTS = `# Content Signals (https://contentsignals.org/)
User-agent: *
Content-Signal: ai-train=no, search=yes, ai-input=yes
Allow: /
Allow: /api/og/
Disallow: /api/
Disallow: /r/
Disallow: /auth/

User-agent: GPTBot
Content-Signal: ai-train=no
Allow: /community/
Allow: /r/
Disallow: /community/bookmarks/

Sitemap: https://21st.dev/sitemap.xml
`;

test("robotsCheck allows component pages and enforces the disallowed paths", () => {
  expect(robotsCheck(ROBOTS, "/@jean.duthil13/components/mac-book-neo-hero").allowed).toBe(true);
  expect(robotsCheck(ROBOTS, "/community/components/s/hero").allowed).toBe(true);
  expect(robotsCheck(ROBOTS, "/r/mac-book-neo-hero").allowed).toBe(false);
  expect(robotsCheck(ROBOTS, "/api/items").allowed).toBe(false);
  expect(robotsCheck(ROBOTS, "/api/og/x.png").allowed).toBe(true); // longer Allow wins over /api/
});

test("robotsCheck picks the group our UA belongs to, not GPTBot's", () => {
  expect(robotsCheck(ROBOTS, "/r/x", UA).allowed).toBe(false); // our UA matches only `*`
  expect(robotsCheck(ROBOTS, "/r/x", "GPTBot/1.0").allowed).toBe(true);
  expect(robotsCheck(ROBOTS, "/community/bookmarks/x", "GPTBot/1.0").allowed).toBe(false);
  expect(robotsCheck("User-agent: *\nDisallow: /\n", "/@a/components/b").allowed).toBe(false);
});

// ---------------------------------------------------------------- adapter, on injected data

const rec = (title, description = "", status = 200) => ({ title, description, status, fetched_at: "2026-10-07T00:00:00.000Z" });
const parent = { id: "21st-dev" };
const build = (items, categories = {}, extra = {}) => apiItems("21st.dev", parent, { data: { items }, categories, overrides: ov, ...extra });

test("apiItems yields gated items with the url, title, description and author", () => {
  const items = build({ "jean.duthil13/mac-book-neo-hero": rec("MacBook Neo Hero", "Scroll-driven   image-sequence hero.") });
  expect(items).toHaveLength(1);
  expect(items[0]).toEqual({
    id: "21st-dev/jean-duthil13-mac-book-neo-hero",
    parent: "21st-dev",
    name: "MacBook Neo Hero",
    url: "https://21st.dev/@jean.duthil13/components/mac-book-neo-hero",
    description: "Scroll-driven image-sequence hero.",
    author: "jean.duthil13",
    elements: ["hero"],
    variants: {},
    access: "gated",
    granularity: "variant",
    from: "api",
  });
});

test("apiItems tags name + title, never the description", () => {
  const items = build({ "a/zqx-1": rec("Zqx One", "A pricing table under a navbar, with a pricing footer") });
  expect(items[0].elements).toEqual([]);
  const tagged = build({ "a/zqx-2": rec("Pricing", "some hero and navbar words") });
  expect(tagged[0].elements).toEqual(["pricing"]);
});

test("apiItems adds the category tags a component is a member of", () => {
  const items = build({ "a/zqx-1": rec("Zqx One") }, { hero: ["a/zqx-1", "b/other"], testimonials: ["a/zqx-1"] });
  expect(items[0].elements).toEqual(["hero", "testimonials"]);
  expect(build({ "a/zqx-1": rec("Zqx One") }, { "framer-motion": ["a/zqx-1"] })[0].elements).toEqual([]); // a tag that maps to no element adds nothing
});

test("apiItems skips failed pages, missing titles, ids already taken and any other domain", () => {
  const items = build({ "a/ok": rec("Hero One"), "b/404": rec("", "", 404), "c/notitle": rec(""), "d/empty": { status: 200 } });
  expect(items.map((i) => i.id)).toEqual(["21st-dev/a-ok"]);
  expect(build({ "a/ok": rec("Hero One") }, {}, { taken: new Map([["21st-dev/a-ok", {}]]) })).toEqual([]);
  expect(apiItems("other.dev", parent, { data: { items: { "a/ok": rec("Hero") } }, categories: {}, overrides: ov })).toEqual([]);
});

test("apiItems dedupes keys that slug to the same id", () => {
  const items = build({ "A/Hero": rec("Hero A"), "a/hero": rec("Hero B") });
  expect(items).toHaveLength(1);
  expect(items[0].name).toBe("Hero A");
});

// ---------------------------------------------------------------- transient failures

const boom = () => new DOMException("The operation timed out.", "TimeoutError");
const okPage = new Response(html("Recovered | Community Components | 21st", "back again"), { status: 200 });

test("a request that times out comes back as status 0 with an error, never as a throw", async () => {
  const request = async () => {
    throw boom();
  };
  expect(await fetchPage("https://21st.dev/@a/components/b", { request })).toEqual({ status: 0, title: "", description: "", error: "timeout" });
  expect(await getText("https://21st.dev/community/components/s/hero", { request })).toEqual({ status: 0, text: "", error: "timeout" });
  expect(errName(new DOMException("x", "AbortError"))).toBe("timeout");
  expect(errName(new Error("connection reset"))).toBe("connection reset");
});

test("a body that dies mid-read (the AbortSignal.timeout case) is a status 0 too", async () => {
  const request = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("<!DOCTYPE html><html><head><title>Half A Page"));
          c.error(boom());
        },
      }),
      { status: 200 },
    );
  expect(await fetchPage("https://21st.dev/@a/components/b", { request })).toEqual({ status: 0, title: "", description: "", error: "timeout" });
});

test("fetchComponent retries transient failures, honours Retry-After, then gives up with status 0", async () => {
  const backoffs = [];
  const dead = async () => {
    throw boom();
  };
  expect(await fetchComponent({ url: "https://21st.dev/@a/components/b" }, { request: dead, backoff: async (ms) => backoffs.push(ms) })).toEqual({
    status: 0,
    title: "",
    description: "",
    error: "timeout",
  });
  expect(backoffs).toEqual([2000, 4000]);

  let n = 0;
  const flaky = async () => (++n === 1 ? new Response("boom", { status: 503, headers: { "retry-after": "1" } }) : okPage);
  const waited = [];
  expect(await fetchComponent({ url: "https://21st.dev/@a/components/b" }, { request: flaky, backoff: async (ms) => waited.push(ms) })).toEqual({
    status: 200,
    title: "Recovered",
    description: "back again",
  });
  expect(waited).toEqual([1000]);

  const away = async () => new Response("", { status: 429, headers: { "retry-after": "600" } });
  expect(await fetchComponent({ url: "https://21st.dev/@a/components/b" }, { request: away, backoff: async () => {} })).toMatchObject({ status: 429, abandon: true });
});

test("fetchPage does not retry what cannot change", async () => {
  let calls = 0;
  const missing = async () => {
    calls++;
    return new Response("nope", { status: 404 });
  };
  expect((await fetchComponent({ url: "https://21st.dev/@a/components/b" }, { request: missing, backoff: async () => {} })).status).toBe(404);
  expect(calls).toBe(1);
  const gone = async () => new Response(html("Component Not Found | 21st", "A community registry."), { status: 200 });
  expect(await fetchPage("https://21st.dev/@a/components/b", { request: gone })).toEqual({ status: 404, title: "", description: "" });
});

// ---------------------------------------------------------------- generated data (bun tools/api-21st.mjs --fetch)

test("components.json holds the community's components", () => {
  expect(existsSync(COMPONENTS_FILE)).toBe(true);
  const data = loadJSON(COMPONENTS_FILE);
  expect(Object.keys(data.items).length).toBeGreaterThan(7_000);
  const bad = Object.entries(data.items).filter(([key, r]) => !/^[^/]+\/[^/]+$/.test(key) || typeof r.status !== "number" || typeof r.title !== "string" || typeof r.description !== "string" || !r.fetched_at);
  expect(bad.slice(0, 5)).toEqual([]);
  expect(Object.values(data.items).filter((r) => r.status === 200 && r.title).length).toBeGreaterThan(7_000);
  const items = apiItems("21st.dev", parent, {});
  expect(items.length).toBeGreaterThan(7_000);
  expect(items.every((i) => i.access === "gated" && i.from === "api" && i.author && i.url.startsWith("https://21st.dev/@"))).toBe(true);
  expect(items.filter((i) => i.elements.includes("navbar")).length).toBeGreaterThan(100);
}, 30_000);

#!/usr/bin/env bun
// Item layer (MCP-PLAN 3.1–3.4): the pure rules, then checks over the generated catalog/items/.
import { test, expect } from "bun:test";
import { stackOf, baseName, isDemo, llmsLinks, docsPage, loadItems } from "./items.mjs";
import { SKIP_TYPE } from "./tag.mjs";

const ov = { assetDomains: new Set(), components: {} };
const page = (url, domain = new URL(url).hostname.replace(/^www\./, "")) =>
  docsPage({ title: "", url, host: new URL(url).hostname.replace(/^www\./, ""), path: new URL(url).pathname }, domain, { ov });

test("stack builds share one base name", () => {
  expect(stackOf("PillNav-TS-TW")).toBe("ts-tw");
  expect(stackOf("BlobCursor-JS-CSS")).toBe("js-css");
  expect(stackOf("navbar")).toBeNull();
  expect(baseName("PillNav-TS-TW")).toBe("PillNav");
});

test("demos are recognised by type or name", () => {
  expect(isDemo({ name: "marquee-demo", type: "registry:example" })).toBe(true);
  expect(isDemo({ name: "demo-components-animate-code", type: "registry:ui" })).toBe(true);
  expect(isDemo({ name: "demonstration-card", type: "registry:ui" })).toBe(false);
});

test("llms.txt link lines resolve relative urls", () => {
  const links = llmsLinks("# Docs\n- [Navbar](/components/navbar): A top bar\n* [Blog](https://x.dev/blog/a)\nnot a link", "x.dev");
  expect(links.map((l) => l.url)).toEqual(["https://x.dev/components/navbar", "https://x.dev/blog/a"]);
  expect(links[0].desc).toBe("A top bar");
});

test("only component docs pages become items", () => {
  expect(page("https://daisyui.com/components/navbar/")?.slug).toBe("navbar");
  expect(page("https://ui.aceternity.com/blocks/navbars/navbar-with-children")?.slug).toBe("navbar-with-children");
  expect(page("https://moduix.dev/docs/native-select.md")?.slug).toBe("native-select"); // /docs/ + an element name
  expect(page("https://moduix.dev/docs/bleed.md")).toBeNull(); // /docs/ but no element
  expect(page("https://heroui.com/cn/docs/react/components/button")).toBeNull(); // locale copy
  expect(page("https://openstatus.dev/blog/status-page-badge")).toBeNull();
  expect(page("https://x.dev/components")).toBeNull(); // the index page itself
  expect(page("https://other.dev/components/navbar", "x.dev")).toBeNull(); // another site's page
});

// ------------------------------------------------------------------ generated data (bun tools/index.mjs)

const items = loadItems();

test("catalog/items exists", () => {
  expect(items.length).toBeGreaterThan(20_000);
});

test("no hook, lib, style or theme item carries an element", () => {
  const bad = items.filter((i) => SKIP_TYPE.test(i.type || "") && i.elements.length);
  expect(bad.map((i) => i.id)).toEqual([]);
});

test("reactbits stack builds appear once, with their stacks", () => {
  const pill = items.filter((i) => i.parent === "reactbits-dev" && /^pill-?nav$/i.test(i.slug || i.name));
  expect(pill).toHaveLength(1);
  expect(pill[0].stacks).toEqual(["js-css", "js-tw", "ts-css", "ts-tw"]);
  expect(pill[0].elements).toContain("navbar");
});

test("item ids are unique and point at their parent", () => {
  const ids = items.map((i) => i.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(items.every((i) => i.id.startsWith(`${i.parent}/`))).toBe(true);
});

test("pinned navbars are items tagged navbar", () => {
  const nav = new Set(items.filter((i) => i.elements.includes("navbar")).map((i) => i.id));
  for (const id of ["ui-aceternity-com/floating-navbar", "shadcn-io/navbar-mega-menu-featured", "tailark-com/navigation-menu"]) expect(nav.has(id)).toBe(true);
});

test("the packed on-disk index unpacks to exactly what buildIndex returned", async () => {
  const { buildIndex, packIndex, unpackIndex, INDEX_SCHEMA } = await import("./search.mjs");
  const entries = [{ id: "a-com", domain: "a.com", name: "A", desc: "", categories: ["components"], labels: [] }, { id: "b-io", domain: "b.io", name: "B", desc: "", categories: ["sections"], labels: [] }];
  const items = [
    { id: "a-com/navbar", parent: "a-com", name: "Navbar", slug: "navbar", access: "code", granularity: "variant", from: "registry", type: "registry:ui", install_url: "https://a.com/r/navbar.json", elements: ["navbar"], variants: { navbar: ["mega-menu"] }, description: "A navbar." },
    { id: "a-com/hero", parent: "a-com", name: "Hero", slug: "hero-x", access: "code", granularity: "variant", from: "registry", elements: ["hero"], variants: {} },
    { id: "a-com/docs-page", parent: "a-com", name: "Docs", access: "page", granularity: "page", from: "llms", url: "https://a.com/docs/page", elements: [] },
    { id: "b-io/stripe", parent: "b-io", name: "Stripe — Hero", access: "page", granularity: "example", from: "sitemap", url: "https://www.b.io/hero/stripe", elements: ["hero"], variants: {}, auto: true },
    { id: "b-io/other", parent: "b-io", name: "Other", access: "page", granularity: "example", from: "sitemap", url: "https://elsewhere.dev/x", elements: [], variants: {} },
  ];
  const idx = buildIndex(entries, items);
  const packed = JSON.parse(JSON.stringify(packIndex(idx)));
  expect(packed.packed).toBe(1);
  expect(packed.schema).toBe(INDEX_SCHEMA);
  expect(unpackIndex(packed)).toEqual(idx);
  expect(unpackIndex(idx)).toBe(idx); // an unpacked (in-memory) index passes through
});

test("an element's typed words count only on docs tagged with it (\"no items\" ≠ every list item)", async () => {
  const { buildIndex, createSearch } = await import("./search.mjs");
  const entries = [{ id: "a-com", domain: "a.com", name: "A", desc: "", categories: ["components"], labels: [] }];
  const items = [
    { id: "a-com/list-item", parent: "a-com", name: "List Item", access: "code", granularity: "variant", from: "registry", elements: ["list"], variants: {} },
    { id: "a-com/list-empty", parent: "a-com", name: "List Empty", access: "code", granularity: "variant", from: "registry", elements: ["empty-state", "list"], variants: {} },
  ];
  const s = createSearch(entries, buildIndex(entries, items));
  const { ranked } = s.rank("what to show when a list has no items");
  expect(s.itemOf(ranked[0].d).id).toBe("a-com/list-empty");
  const listItem = ranked.find((r) => s.isItem(r.d) && s.itemOf(r.d).id === "a-com/list-item");
  expect(listItem.matched.map(([w]) => w)).toEqual(["list"]);
});

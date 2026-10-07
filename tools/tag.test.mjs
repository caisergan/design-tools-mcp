#!/usr/bin/env bun
// Element / variant tagging (MCP-PLAN 3.4) against catalog/taxonomy.json. Pure: no corpus files read.
// Items are pinned by name instead of a registry count, so the checks survive re-harvests.
import { test, expect } from "bun:test";
import { tagItem, tok, TAXONOMY } from "./tag.mjs";

const item = (reg, name, title = "", type = "registry:block") => ({ reg, name, title, description: "", type });
const els = (...a) => tagItem(item(...a)).elements.sort();
const vars = (el, ...a) => (tagItem(item(...a)).variants[el] || []).sort();

test("taxonomy ids are unique and every entry has id, label, definition, aliases", () => {
  for (const list of ["categories", "types", "elements", "synonyms"]) {
    const ids = TAXONOMY[list].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of TAXONOMY[list]) for (const k of ["id", "label", "definition", "aliases"]) expect(e[k]).toBeTruthy();
  }
  for (const e of TAXONOMY.elements) {
    const vids = (e.variants || []).map((v) => v.id);
    expect(new Set(vids).size).toBe(vids.length);
  }
});

test("tokens split camelCase, digits and punctuation", () => {
  expect(tok("PillNav-TS-TW")).toEqual(["pill", "nav", "ts", "tw"]);
  expect(tok("menu3")).toEqual(["menu", "3"]);
});

test("real navbars are tagged navbar", () => {
  expect(els("ui.aceternity.com", "floating-navbar")).toEqual(["navbar"]);
  expect(els("reactbits.dev", "PillNav-TS-TW", "PillNav")).toEqual(["navbar"]);
  expect(els("efferd.com", "header-1")).toEqual(["navbar"]);
  expect(els("mynaui.com", "appheaders1", "Appheaders1")).toEqual(["navbar"]);
  expect(els("tailark.com", "navigation-menu", "Navigation Menu")).toEqual(["navbar"]);
  expect(els("shadcn.io", "navbar-mega-menu-featured", "Navbar Mega Menu Featured")).toEqual(["navbar"]);
});

test("things that only mention nav or header are not navbars", () => {
  expect(els("fluid-functionalism.vercel.app", "use-keyboard-nav-gate", "useKeyboardNavGate", "registry:hook")).toEqual([]);
  expect(els("shadcn.io", "faq-keyboard-nav", "Faq Keyboard Nav")).toEqual(["faq"]);
  expect(els("shadcncraft.com", "header-1", "Header 1 – Page header with actions and search")).toEqual([]);
  expect(els("sv-table.vercel.app", "header-checkbox", "Header Checkbox")).toEqual(["checkbox"]);
  expect(els("ui.meta-cloud-api.site", "chat-header", "Chat Header")).toEqual(["chat"]);
  expect(els("bundui.io", "card-with-header", "Card")).toEqual(["card"]);
  expect(els("sv-blocks.vercel.app", "hero-header")).toEqual(["hero"]);
  expect(els("ui.aceternity.com", "hero-with-background-and-navbar")).toEqual(["hero"]);
});

test("menubar and sidebar nav are their own elements, not navbars", () => {
  expect(els("ui.shadcn.com", "menubar")).toEqual(["menubar"]);
  expect(els("uiable.com", "menubar-checkbox", "Menubar Checkbox")).toEqual(["checkbox", "menubar"]);
  expect(els("beautifului.dev", "sidebar-nav", "Sidebar Nav")).toEqual(["sidebar"]);
});

test("a dock implies navbar; mega menu implies navbar + mega-menu", () => {
  expect(els("shadcn.io", "menu-dock", "Menu Dock")).toEqual(["dock", "navbar"]);
  expect(vars("navbar", "shadcn.io", "menu-dock", "Menu Dock")).toEqual(["dock"]);
  expect(els("shadcn.io", "blog-mega-menu")).toEqual(["navbar"]);
});

test("loose variant words are gone", () => {
  // every store navbar used to get with-cart through 'store' / 'ecommerce'
  expect(vars("navbar", "shadcn-ui-blocks.vercel.app", "ecommerce-pro-store-navbars-centered-logo-navbar", "Centered Logo Navbar")).toEqual(["centered"]);
  expect(vars("navbar", "shadcn-ui-blocks.vercel.app", "ecommerce-pro-store-navbars-minimal-logo-cart", "Minimal Logo Cart")).toEqual(["with-cart"]);
  expect(vars("hero", "shadcn.io", "hero-gradient-text", "Hero Gradient Text")).toEqual([]);
  expect(vars("hero", "shadcn.io", "hero-animated-counter", "Hero Animated Counter")).toEqual(["with-stats"]);
  expect(vars("hero", "shadcn-ui-blocks.vercel.app", "marketing-pro-help-center-sections-help-search-hero")).toEqual(["with-form"]);
});

test("longest match and the 'with' rule pick the item's own element", () => {
  expect(els("x", "pricing-table")).toEqual(["pricing"]);
  expect(els("x", "alert-dialog", "Alert Dialog")).toEqual(["modal"]);
  expect(els("x", "footer-with-nav")).toEqual(["footer"]);
  expect(els("ui.aceternity.com", "world-map")).toEqual(["map"]);
});

test("new elements and their excludes", () => {
  expect(els("x", "stats-section-01")).toEqual(["stats"]);
  expect(els("x", "team-1")).toEqual(["team"]);
  expect(els("shadcn.io", "sidebar-team-switcher", "Sidebar Team Switcher")).toEqual(["sidebar"]);
  expect(els("shadcn.io", "pricing-team-tiers", "Pricing Team Tiers")).toEqual(["pricing"]);
  expect(els("x", "contact-1")).toEqual(["contact"]);
  expect(els("shadcn.io", "empty-state-no-contacts", "Empty State No Contacts")).toEqual(["empty-state"]);
  expect(els("x", "changelog-1")).toEqual(["changelog"]);
  expect(els("shadcn.io", "banner-top-bar-workspace", "Banner Top Bar Workspace")).toEqual(["banner"]);
  expect(els("x", "alert", "Alert")).toEqual(["alert"]);
  expect(els("x", "accordion-01")).toEqual(["accordion"]);
  expect(els("x", "timeline")).toEqual(["timeline"]);
  expect(els("x", "progress", "Progress")).toEqual(["progress"]);
  expect(els("x", "mind-map")).toEqual([]);
});

test("icon registries and icon items get no elements", () => {
  const ov = { assetDomains: new Set(["icons.pqoqubbw.dev"]), components: {} };
  expect(tagItem(item("icons.pqoqubbw.dev", "calendar-check"), { overrides: ov }).elements).toEqual([]);
  expect(tagItem(item("x", "icons-calendar"), { overrides: ov }).elements).toEqual([]);
});

test("a components override replaces the computed tags", () => {
  const ov = { assetDomains: new Set(), components: { "shadcn.io/faq-sticky-nav": { elements: ["faq"] } } };
  expect(tagItem(item("shadcn.io", "faq-sticky-nav", "Faq Sticky Nav")).elements.sort()).toEqual(["faq", "navbar"]);
  expect(tagItem(item("shadcn.io", "faq-sticky-nav", "Faq Sticky Nav"), { overrides: ov }).elements).toEqual(["faq"]);
});

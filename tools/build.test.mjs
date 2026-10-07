#!/usr/bin/env bun
// Naming + url rules of the catalog build (pure functions, no files touched).
import { test, expect } from "bun:test";
import { displayName } from "./build.mjs";
import { normalizeUrl, urlKey } from "./lib.mjs";

const entry = (url, name, title = "") => {
  const u = new URL(url);
  const kind = /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(url) ? "repo" : u.pathname === "/" ? "site" : "page";
  return { url, name, title, domain: u.hostname.replace(/^www\./, ""), kind };
};

test("a real source name is kept", () => {
  expect(displayName(entry("https://reactbits.dev", "React Bits", "Whatever — Title"))).toBe("React Bits");
});

test("repos get owner/repo instead of github.com", () => {
  expect(displayName(entry("https://github.com/pbakaus/impeccable", "github.com"))).toBe("pbakaus/impeccable");
});

test("a site takes the title segment that is its own brand, else stays the host", () => {
  expect(displayName(entry("https://navbar.gallery", "navbar.gallery", "Navbar Gallery – Navigation Design Inspiration"))).toBe("Navbar Gallery");
  expect(displayName(entry("https://mobbin.com", "mobbin.com", "Mobbin — UI & UX design inspiration"))).toBe("Mobbin");
  // the first segment is a tagline, not the brand -> keep the host rather than guess
  expect(displayName(entry("https://saaspo.com", "saaspo.com", "Best SaaS Website Designs"))).toBe("saaspo.com");
});

test("a page is named from its title plus its brand", () => {
  expect(displayName(entry("https://beui.dev/components/motion/loader", "beui.dev", "Loader · React motion component · beUI"))).toBe("Loader (beUI)");
});

test("error and bot-wall titles are never names; the path is used instead", () => {
  const e = entry("https://framer.com/marketplace/components/smooth-scroll", "framer.com", "Component unavailable | Framer Marketplace");
  expect(displayName(e)).toBe("Smooth scroll (Framer Marketplace)");
});

test("GitHub paths dedupe case-insensitively, other paths do not", () => {
  expect(urlKey("https://github.com/CapSoftware/Cap")).toBe(urlKey("https://github.com/CapSoftware/cap"));
  expect(urlKey("https://example.com/Docs")).not.toBe(urlKey("https://example.com/docs"));
});

test("normalizeUrl drops tracking, utm_* and markdown leftovers", () => {
  expect(normalizeUrl("https://7ovr.com/?utm_source=x&utm_medium=y&utm_campaign=z")).toBe("https://7ovr.com");
  expect(normalizeUrl("https://a.io/kit?view=explore](https://a.io/kit?view=explore)")).toBe("https://a.io/kit?view=explore");
  expect(normalizeUrl("https://a.io/kit?view=explore%5D%28https%3A%2F%2Fa.io")).toBe("https://a.io/kit?view=explore");
});

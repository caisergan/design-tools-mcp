#!/usr/bin/env bun
// Pure (offline) tests for the sitemap downloader: parsing, gzip, host filtering, cap.
import { test, expect } from "bun:test";
import { gzipSync } from "node:zlib";
import { parseSitemap, decodeXml, maybeGunzip, isChallenge, keepInDomain, sitemapsByDomain } from "./sitemaps.mjs";

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://x.dev/a</loc><lastmod>2026-09-01</lastmod></url>
  <url><loc>https://x.dev/b</loc><changefreq>daily</changefreq></url>
</urlset>`;

test("urlset: loc + optional lastmod", () => {
  const r = parseSitemap(URLSET);
  expect(r.kind).toBe("urlset");
  expect(r.entries).toEqual([{ loc: "https://x.dev/a", lastmod: "2026-09-01" }, { loc: "https://x.dev/b" }]);
});

test("urlset: an empty urlset is valid, not invalid", () => {
  const r = parseSitemap(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`);
  expect({ kind: r.kind, n: r.entries.length }).toEqual({ kind: "urlset", n: 0 });
});

test("sitemapindex: children carry loc and lastmod", () => {
  const r = parseSitemap(`<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://x.dev/sitemap-1.xml</loc><lastmod>2026-08-01</lastmod></sitemap>
  <sitemap><loc>https://x.dev/sitemap-2.xml.gz</loc></sitemap>
</sitemapindex>`);
  expect(r.kind).toBe("index");
  expect(r.entries).toEqual([
    { loc: "https://x.dev/sitemap-1.xml", lastmod: "2026-08-01" },
    { loc: "https://x.dev/sitemap-2.xml.gz" },
  ]);
});

test("image/xhtml locs do not shadow the page loc", () => {
  const r = parseSitemap(
    `<urlset><url><loc>https://x.dev/a</loc><image:image><image:loc>https://x.dev/a.png</image:loc></image:image><xhtml:link rel="alternate" href="https://x.dev/de/a"/></url></urlset>`,
  );
  expect(r.entries).toEqual([{ loc: "https://x.dev/a" }]);
});

test("entities and CDATA are decoded", () => {
  const r = parseSitemap(
    `<urlset>
       <url><loc>https://x.dev/?a=1&amp;b=2</loc></url>
       <url><loc><![CDATA[https://x.dev/c?d=3&e=4]]></loc></url>
       <url><loc>https://x.dev/it&#39;s</loc></url>
     </urlset>`,
  );
  expect(r.entries.map((e) => e.loc)).toEqual(["https://x.dev/?a=1&b=2", "https://x.dev/c?d=3&e=4", "https://x.dev/it's"]);
  expect(decodeXml("&lt;a&gt;&#x26;&#38;")).toBe("<a>&&");
});

test("html, challenge pages and junk are invalid", () => {
  const challenge = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>
    <div id="cf-chl-widget">Checking your browser before accessing the site. Enable JavaScript and cookies to continue.</div></body></html>`;
  expect(parseSitemap(challenge)).toEqual({ kind: "invalid", entries: [] });
  expect(parseSitemap(`<!DOCTYPE html><html><body><h1>404 Not Found</h1></body></html>`)).toEqual({ kind: "invalid", entries: [] });
  expect(parseSitemap("")).toEqual({ kind: "invalid", entries: [] });
  expect(isChallenge(challenge)).toBe(true);
  expect(isChallenge(URLSET)).toBe(false);
});

test("gzip bodies are decompressed before parsing", () => {
  const gz = Buffer.from(gzipSync(Buffer.from(URLSET)));
  expect(maybeGunzip(gz).toString("utf8")).toContain("<urlset");
  const plain = Buffer.from(URLSET);
  expect(maybeGunzip(plain)).toBe(plain); // untouched, not a copy
  expect(parseSitemap(maybeGunzip(gz).toString("utf8")).entries).toHaveLength(2);
  expect(parseSitemap(maybeGunzip(Buffer.from([0x1f, 0x8b, 0x00, 0x01])).toString("utf8")).kind).toBe("invalid"); // corrupt gzip
});

// ------------------------------------------------------------------ host filter / cap

const u = (loc, lastmod) => (lastmod ? { loc, lastmod } : { loc });

test("only the domain and its www host survive", () => {
  const { urls, foreign, truncated } = keepInDomain(
    [
      u("https://x.dev/a"),
      u("https://www.x.dev/b", "2026-01-01"),
      u("https://x.dev:8443/f"), // same hostname, non-default port
      u("https://sub.x.dev/c"),
      u("https://other.com/d"),
      u("https://notx.dev/e"),
      u("mailto:hi@x.dev"),
      u("/relative"),
    ],
    "x.dev",
  );
  expect(urls).toEqual([
    { loc: "https://x.dev/a" },
    { loc: "https://www.x.dev/b", lastmod: "2026-01-01" },
    { loc: "https://x.dev:8443/f" },
  ]);
  expect(foreign).toBe(5);
  expect(truncated).toBe(false);
});

test("a domain given with www. matches its bare host too", () => {
  expect(keepInDomain([u("https://x.dev/a")], "www.x.dev").urls).toEqual([{ loc: "https://x.dev/a" }]);
});

test("duplicate locs collapse", () => {
  expect(keepInDomain([u("https://x.dev/a"), u("https://x.dev/a", "2026-02-02")], "x.dev").urls).toEqual([{ loc: "https://x.dev/a" }]);
});

test("cap keeps the first N and marks truncation", () => {
  const many = Array.from({ length: 5 }, (_, i) => u(`https://x.dev/${i}`));
  const r = keepInDomain(many, "x.dev", 3);
  expect(r.urls.map((e) => e.loc)).toEqual(["https://x.dev/0", "https://x.dev/1", "https://x.dev/2"]);
  expect(r.truncated).toBe(true);
  const under = keepInDomain(many, "x.dev", 5);
  expect({ n: under.urls.length, truncated: under.truncated }).toEqual({ n: 5, truncated: false });
});

// ------------------------------------------------------------------ probe index

test("probe sitemap urls are grouped by the entry host, www-less, deduped", () => {
  const by = sitemapsByDomain({
    items: {
      "https://x.dev/one": { sitemap: { url: "https://x.dev/sitemap.xml" } },
      "https://www.x.dev/two": { sitemap: { url: "https://x.dev/sitemap.xml" } },
      "https://x.dev/three": { sitemap: { url: "https://cdn.x.dev/sitemap-index.xml" } },
      "https://y.dev": {},
      "https://z.dev": { sitemap: { status: 404 } },
      "not a url": { sitemap: { url: "https://nope.dev/sitemap.xml" } },
    },
  });
  expect([...by.keys()]).toEqual(["x.dev"]);
  expect(by.get("x.dev")).toEqual(["https://x.dev/sitemap.xml", "https://cdn.x.dev/sitemap-index.xml"]);
});

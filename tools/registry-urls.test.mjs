#!/usr/bin/env bun
// Registry url templates (brief 16): config validation, candidates, the pass/miss decision, robots.txt, resume and
// the build fill. No network: responses and fetchers are passed in.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROBE_NAME,
  candidates,
  configHash,
  createFetcher,
  judge,
  pageTitle,
  parseRobots,
  planRun,
  probeState,
  probeUrl,
  registryName,
  robotsAllows,
  validateRegistryUrlConfig,
  verifyItems,
} from "./registry-urls.mjs";
import { applyTemplateUrls, loadTemplateUrls } from "./items.mjs";

const cfg = (extra = {}) => ({ templates: ["https://x.dev/docs/components/{name}"], status: "hand", ...extra });
const bad = (c) => () => validateRegistryUrlConfig(c, "x.dev");
const html = (status, finalUrl, title = "", extra = {}) => ({ status, type: "text/html; charset=utf-8", finalUrl, title, ...extra });

// ---------------------------------------------------------------- config

test("a valid config, and a skip config, pass validation", () => {
  const c = cfg({ rewrite: [["^components-animate-", "animate/"]], types: ["registry:ui"], exclude: ["^icons-"], note: "n" });
  expect(validateRegistryUrlConfig(c, "x.dev")).toBe(c);
  expect(validateRegistryUrlConfig({ skip: "icon gallery on one page", status: "hand" }, "x.dev").skip).toBe("icon gallery on one page");
});

test("validation errors name the problem", () => {
  expect(bad(cfg({ templatez: [] }))).toThrow(/unknown key "templatez"/);
  expect(bad({ templates: ["https://x.dev/{name}"] })).toThrow(/status must be/);
  expect(bad(cfg({ templates: [] }))).toThrow(/non-empty array/);
  expect(bad(cfg({ templates: ["http://x.dev/{name}"] }))).toThrow(/must be https/);
  expect(bad(cfg({ templates: ["/docs/{name}"] }))).toThrow(/not an absolute url/);
  expect(bad(cfg({ templates: ["https://x.dev/docs/button"] }))).toThrow(/has no \{name\}/);
  expect(bad(cfg({ templates: ["https://{name}.x.dev/docs"] }))).toThrow(/not the host/);
  expect(bad(cfg({ rewrite: [["(unclosed", "x"]] }))).toThrow(/not a valid regex/);
  expect(bad(cfg({ rewrite: [["^a"]] }))).toThrow(/\[regex, replacement\] pair/);
  expect(bad(cfg({ rewrite: "^a" }))).toThrow(/array of \[regex, replacement\]/);
  expect(bad(cfg({ exclude: ["[z"] }))).toThrow(/exclude\[0\] is not a valid regex/);
  expect(bad(cfg({ types: ["ui"] }))).toThrow(/registry:ui/);
  expect(bad({ skip: "", status: "hand" })).toThrow(/skip must be/);
  expect(bad({ skip: "gone", status: "hand", templates: ["https://x.dev/{name}"] })).toThrow(/a skip config has no "templates"/);
});

test("the config hash ignores note and status, and sees templates, rewrites, types and excludes", () => {
  const a = cfg();
  expect(configHash({ ...a, note: "other", status: "auto" })).toBe(configHash(a));
  expect(configHash(cfg({ rewrite: [["^a-", ""]] }))).not.toBe(configHash(a));
  expect(configHash(cfg({ exclude: ["^icons-"] }))).not.toBe(configHash(a));
  expect(configHash(cfg({ types: ["registry:ui"] }))).not.toBe(configHash(a));
});

// ---------------------------------------------------------------- candidates

test("candidates: rewrites run in order, $1 works, duplicates collapse", () => {
  const c = cfg({
    templates: ["https://x.dev/docs/{name}", "https://x.dev/docs/{name}", "https://x.dev/blocks/{name}"],
    rewrite: [
      ["^demo-", ""],
      ["^(components|primitives)-([a-z]+)-(.+)$", "$1/$2/$3"],
    ],
  });
  expect(candidates("components-radix-alert-dialog", c)).toEqual(["https://x.dev/docs/components/radix/alert-dialog", "https://x.dev/blocks/components/radix/alert-dialog"]);
  expect(candidates("demo-primitives-texts-typing", c)[0]).toBe("https://x.dev/docs/primitives/texts/typing"); // "^demo-" ran first
  // order matters: the same pairs reversed leave the demo prefix in place
  const reversed = cfg({ templates: ["https://x.dev/docs/{name}"], rewrite: [...c.rewrite].reverse() });
  expect(candidates("demo-primitives-texts-typing", reversed)).toEqual(["https://x.dev/docs/primitives-texts-typing"]);
  expect(candidates("button", cfg({ templates: ["https://x.dev/a/{name}", "https://x.dev/a/{name}"] }))).toEqual(["https://x.dev/a/button"]);
});

test("candidates: excluded names, empty rewrites and path climbing give none; parts are encoded", () => {
  expect(candidates("icons-arrow", cfg({ exclude: ["^icons-"] }))).toEqual([]);
  expect(candidates("index", cfg({ rewrite: [["^index$", ""]] }))).toEqual([]);
  expect(candidates("x", cfg({ rewrite: [["^x$", "../admin"]] }))).toEqual([]);
  expect(candidates("a b", cfg())).toEqual(["https://x.dev/docs/components/a%20b"]);
  expect(candidates("a", cfg({ templates: ["https://x.dev/c?item={name}"] }))).toEqual(["https://x.dev/c?item=a"]);
});

test("the soft-404 probe sits in the candidate's own directory", () => {
  const c = cfg({ templates: ["https://x.dev/docs/{name}"], rewrite: [["^(components)-([a-z]+)-(.+)$", "$1/$2/$3"]] });
  expect(probeUrl("components-radix-tabs", c.templates[0], c)).toBe(`https://x.dev/docs/components/radix/${PROBE_NAME}`);
  expect(probeUrl("button", "https://x.dev/ui/{name}/preview", cfg())).toBe(`https://x.dev/ui/${PROBE_NAME}/preview`);
});

test("the registry name is the slug, else the id after the entry id", () => {
  expect(registryName({ id: "a-com/components-animate-code", slug: "components-animate-code" })).toBe("components-animate-code");
  expect(registryName({ id: "kibo-ui-com/gantt" })).toBe("gantt");
});

// ---------------------------------------------------------------- pass / miss

const at = "https://x.dev/docs/components/button";
const j = (res, extra = {}) => judge(res, { candidate: at, name: "button", ...extra });

test("200 html at the produced path passes; a trailing slash or a www hop is the same page", () => {
  expect(j(html(200, at, "Button – X"))).toEqual({ verdict: "pass", why: "ok" });
  expect(j(html(200, `${at}/`, "Button")).verdict).toBe("pass");
  expect(j(html(200, "https://www.x.dev/docs/components/button", "Button")).verdict).toBe("pass");
});

test("status and content type decide misses and retries", () => {
  expect(j(html(404, at)).verdict).toBe("miss");
  expect(j(html(410, at)).verdict).toBe("miss");
  expect(j({ status: 200, type: "application/json", finalUrl: at, title: "" }).verdict).toBe("miss");
  for (const status of [0, 403, 429, 500, 503]) expect(j(html(status, at)).verdict).toBe("retry");
  expect(j({ status: 0, type: "", finalUrl: at, title: "", error: "robots" })).toEqual({ verdict: "miss", why: "robots" });
});

test("a redirect to the root, a listing, another page or another host is a miss", () => {
  expect(j(html(200, "https://x.dev/", "X")).why).toBe("redirect to the site root");
  expect(j(html(200, "https://x.dev/docs", "Docs")).verdict).toBe("miss");
  expect(j(html(200, "https://x.dev/components", "Components")).verdict).toBe("miss");
  expect(j(html(200, "https://x.dev/docs/components/avatar-stack", "Avatar Stack")).verdict).toBe("miss"); // kibo's /components → first item
  expect(j(html(200, "https://elsewhere.dev/docs/components/button", "Button")).why).toBe("moved to elsewhere.dev");
});

test("soft-404: the probe's title, a blind probe, and a not-found title are misses", () => {
  const soft = probeState(html(200, `https://x.dev/docs/components/${PROBE_NAME}`, "X — UI kit"), `https://x.dev/docs/components/${PROBE_NAME}`);
  expect(soft).toEqual({ state: "soft", title: "X — UI kit" });
  expect(j(html(200, at, "X — UI kit"), { probe: soft }).why).toBe("soft-404: probe title");
  expect(j(html(200, at, "Button — X"), { probe: soft }).verdict).toBe("pass");
  expect(j(html(200, at, "Button"), { probe: { state: "blind", why: "w" } }).verdict).toBe("miss");
  expect(j(html(200, at, "404: This page could not be found.")).verdict).toBe("miss");
  expect(j(html(200, at, "Page Not Found | X")).verdict).toBe("miss");
  expect(judge(html(200, "https://x.dev/blocks/404-page", "404 Page — X"), { candidate: "https://x.dev/blocks/404-page", name: "404-page" }).verdict).toBe("pass");
});

test("probe states", () => {
  const p = `https://x.dev/docs/${PROBE_NAME}`;
  expect(probeState(html(404, p), p).state).toBe("clean");
  expect(probeState(html(200, "https://x.dev/", "X"), p).state).toBe("clean"); // redirected away: the path rule catches it
  expect(probeState(html(200, p, ""), p).state).toBe("blind");
  expect(probeState(html(200, p, "Zz Design Tools Probe 404 — X"), p).state).toBe("blind"); // the name is echoed
  expect(probeState(html(503, p), p).state).toBe("retry");
  expect(probeState({ status: 0, error: "robots" }, p).state).toBe("blind");
});

test("page titles are decoded and collapsed", () => {
  expect(pageTitle('<html><head><title data-x="1">\n  Alert &amp; Dialog &#8211; Kit </title></head>')).toBe("Alert & Dialog – Kit");
  expect(pageTitle("<p>no title</p>")).toBe("");
});

// ---------------------------------------------------------------- robots.txt

test("robots: the * group's Disallow blocks, the longest rule wins, other agents are ignored", () => {
  const rules = parseRobots(`User-agent: Googlebot
Disallow: /

User-Agent: *
Allow: /
Allow: /api/og/
Disallow: /preview/
Disallow: /api/
Disallow: /*.json$
Disallow:
`);
  expect(robotsAllows(rules, "/docs/components/button")).toBe(true);
  expect(robotsAllows(rules, "/preview/button")).toBe(false);
  expect(robotsAllows(rules, "/api/og/x")).toBe(true); // longer Allow beats Disallow: /api/
  expect(robotsAllows(rules, "/api/health")).toBe(false);
  expect(robotsAllows(rules, "/r/button.json")).toBe(false);
  expect(robotsAllows(rules, "/r/button.json?x=1")).toBe(true); // "$" anchors the end
  expect(robotsAllows(parseRobots("User-agent: *\nDisallow: /docs\nAllow: /docs"), "/docs/a")).toBe(true); // a tie goes to Allow
  expect(robotsAllows(parseRobots("User-agent: a\nUser-agent: *\nDisallow: /x"), "/x/y")).toBe(false); // a group of several agents
  expect(robotsAllows([], "/anything")).toBe(true);
});

// ---------------------------------------------------------------- resume

test("resume: ids in results are skipped; a changed config hash or --force rechecks all", () => {
  const targets = [{ id: "e/a" }, { id: "e/b" }, { id: "e/c" }];
  const cache = { config_hash: "h1", results: { "e/a": "https://x.dev/a", "e/b": null } };
  const resume = planRun(targets, cache, "h1");
  expect(resume.todo.map((i) => i.id)).toEqual(["e/c"]);
  expect(resume.results).toEqual(cache.results);
  expect(resume.fresh).toBe(false);
  expect(planRun(targets, cache, "h2").todo).toHaveLength(3);
  expect(planRun(targets, cache, "h2").results).toEqual({});
  expect(planRun(targets, cache, "h1", { force: true }).todo).toHaveLength(3);
  expect(planRun(targets, null, "h1").todo).toHaveLength(3);
});

// ---------------------------------------------------------------- the run loop (fake network)

function fakeFetcher(pages, { robots = [] } = {}) {
  const asked = [];
  return {
    asked,
    allowed: async (url) => robotsAllows(robots, new URL(url).pathname),
    request: async (url) => {
      asked.push(url);
      return pages[url] || html(404, url);
    },
    requests: () => asked.length,
    stopped: () => [],
  };
}

test("verifyItems: first passing template wins, group pages are fetched once, retries stay unrecorded", async () => {
  const c = cfg({
    templates: ["https://x.dev/docs/{name}", "https://x.dev/blocks/{name}"],
    rewrite: [["^accordion-.*$", "accordion"]],
    exclude: ["^icons-"],
  });
  const f = fakeFetcher({
    "https://x.dev/docs/accordion": html(200, "https://x.dev/docs/accordion", "Accordion"),
    "https://x.dev/blocks/hero": html(200, "https://x.dev/blocks/hero", "Hero"),
    "https://x.dev/docs/slow": html(0, "https://x.dev/docs/slow", "", { error: "timeout" }),
  });
  const items = ["accordion-default", "accordion-collapsible", "hero", "nothing", "slow", "icons-arrow"].map((n) => ({ id: `e/${n}` }));
  const { results, stats } = await verifyItems(items, c, { fetcher: f });
  expect(results).toEqual({
    "e/accordion-default": "https://x.dev/docs/accordion",
    "e/accordion-collapsible": "https://x.dev/docs/accordion",
    "e/hero": "https://x.dev/blocks/hero",
    "e/nothing": null,
    "e/icons-arrow": null,
  });
  expect(Object.hasOwn(results, "e/slow")).toBe(false);
  expect(stats).toEqual({ tried: 5, found: 3, misses: 1, excluded: 1, unfinished: 1, soft404: 0 });
  expect(f.asked.filter((u) => u === "https://x.dev/docs/accordion")).toHaveLength(1);
  expect(f.asked.filter((u) => u.endsWith(PROBE_NAME))).toEqual([`https://x.dev/docs/${PROBE_NAME}`, `https://x.dev/blocks/${PROBE_NAME}`]); // one probe per template directory
  expect(f.asked.some((u) => u.includes("icons-arrow"))).toBe(false);
});

test("verifyItems: a soft-404 site's look-alike page is a miss, robots-disallowed candidates are never fetched", async () => {
  const probe = `https://x.dev/docs/${PROBE_NAME}`;
  const f = fakeFetcher(
    {
      [probe]: html(200, probe, "X Kit"),
      "https://x.dev/docs/ghost": html(200, "https://x.dev/docs/ghost", "X Kit"),
      "https://x.dev/docs/real": html(200, "https://x.dev/docs/real", "Real — X Kit"),
    },
    { robots: parseRobots("User-agent: *\nDisallow: /docs/private") },
  );
  const c = cfg({ templates: ["https://x.dev/docs/{name}"] });
  const { results, stats } = await verifyItems([{ id: "e/ghost" }, { id: "e/real" }, { id: "e/private-x" }], c, { fetcher: f });
  expect(results).toEqual({ "e/ghost": null, "e/real": "https://x.dev/docs/real", "e/private-x": null });
  expect(stats.soft404).toBe(1);
  expect(f.asked).not.toContain("https://x.dev/docs/private-x");
});

test("createFetcher: paced per host, robots read once, a host stopped after 3× 403/429 in a row", async () => {
  let clock = 0;
  const waits = [];
  const calls = [];
  const f = createFetcher({
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    get: async (url) => {
      calls.push(url);
      if (url.endsWith("/robots.txt")) return { status: 200, type: "text/plain", finalUrl: url, title: "", text: "User-agent: *\nDisallow: /secret" };
      return { status: url.includes("/busy/") ? 429 : 200, type: "text/html", finalUrl: url, title: "" };
    },
  });
  expect(await f.allowed("https://a.dev/secret/x")).toBe(false);
  expect(await f.allowed("https://a.dev/docs/x")).toBe(true);
  expect(calls.filter((u) => u.endsWith("/robots.txt"))).toHaveLength(1);
  for (const n of [1, 2, 3, 4]) await f.request(`https://a.dev/busy/${n}`);
  expect(calls.filter((u) => u.includes("/busy/"))).toHaveLength(3); // the 4th never left
  expect(f.stopped()).toEqual(["a.dev: 3× 429 in a row"]);
  expect(waits).toEqual([500, 500, 500]); // robots goes at once, then one request per 500 ms
  expect((await f.request("https://b.dev/x")).status).toBe(200); // another host is not affected
});

test("createFetcher: an unreadable robots.txt stops the host; an html or 404 robots.txt allows everything", async () => {
  const mk = (robots) =>
    createFetcher({ wait: async () => {}, get: async (url) => (url.endsWith("/robots.txt") ? robots : { status: 200, type: "text/html", finalUrl: url, title: "" }) });
  expect(await mk({ status: 503, type: "", finalUrl: "", title: "" }).allowed("https://a.dev/x")).toBe("retry");
  expect(await mk({ status: 404, type: "text/html", finalUrl: "", title: "" }).allowed("https://a.dev/x")).toBe(true);
  expect(await mk({ status: 200, type: "text/html", finalUrl: "", title: "", text: "<html>Disallow: /</html>" }).allowed("https://a.dev/x")).toBe(true);
});

// ---------------------------------------------------------------- build fill

test("a cached url fills a url-less registry item, never one with a url, never a non-registry item", () => {
  const items = [
    { id: "e/a", from: "registry" },
    { id: "e/b", from: "registry", url: "https://x.dev/sitemap/b" },
    { id: "e/c", from: "llms" },
    { id: "e/d", from: "registry" },
    { id: "e/e", from: "registry" },
  ];
  const results = { "e/a": "https://x.dev/docs/a", "e/b": "https://x.dev/docs/b", "e/c": "https://x.dev/docs/c", "e/d": null, "e/e": "javascript:alert(1)" };
  expect(applyTemplateUrls(items, results)).toBe(1);
  expect(items.map((i) => i.url ?? null)).toEqual(["https://x.dev/docs/a", "https://x.dev/sitemap/b", null, null, null]);
  expect(applyTemplateUrls(items, null)).toBe(0);
});

test("a missing or broken cache file is a warning, never an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-urls-"));
  const warns = [];
  const warn = (m) => warns.push(m);
  expect(loadTemplateUrls("x.dev", { file: join(dir, "none.json"), warn })).toBeNull();
  writeFileSync(join(dir, "broken.json"), "{ not json");
  expect(loadTemplateUrls("x.dev", { file: join(dir, "broken.json"), warn })).toBeNull();
  writeFileSync(join(dir, "shape.json"), JSON.stringify({ results: [] }));
  expect(loadTemplateUrls("x.dev", { file: join(dir, "shape.json"), warn })).toBeNull();
  writeFileSync(join(dir, "ok.json"), JSON.stringify({ results: { "e/a": "https://x.dev/a" } }));
  expect(loadTemplateUrls("x.dev", { file: join(dir, "ok.json"), warn })).toEqual({ "e/a": "https://x.dev/a" });
  expect(warns).toHaveLength(2);
});

test("createFetcher: a scope counts only its own requests (robots included) and reports only its own stopped hosts", async () => {
  const f = createFetcher({ wait: async () => {}, get: async (url) => ({ status: url.includes("a.dev") ? 403 : 200, type: "text/html", finalUrl: url, title: "" }) });
  const a = f.scope();
  const b = f.scope();
  for (const n of [1, 2, 3]) await a.request(`https://a.dev/${n}`);
  expect(await b.allowed("https://b.dev/x")).toBe(true); // robots.txt answered 200 html: no rules
  await b.request("https://b.dev/x");
  expect([a.requests(), b.requests(), f.requests()]).toEqual([3, 2, 5]);
  expect(a.stopped()).toEqual(["a.dev: 3× 403 in a row"]);
  expect(b.stopped()).toEqual([]);
});

#!/usr/bin/env bun
// Scrapling backend (brief 11): the opt-in host list, the `fetch.py --stdin` protocol and the fallback to
// plain `fetch`. No network and no Python: the child process, the venv check and `fetch` are fakes.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScraplingClient, loadHosts, modeFor } from "./scrapling-backend.mjs";
import { get } from "./patterns.mjs";

const tmp = (name = "") => mkdtempSync(join(tmpdir(), `t11-${name}`));

function hostsFile(text) {
  const file = join(tmp("hosts"), "scrapling-hosts.json");
  writeFileSync(file, text);
  return file;
}

const HOSTS = `{
  "uiverse.io": { "mode": "http", "enabled": true, "note": "open-source library" },
  "land-book.com": { "mode": "http", "enabled": false, "note": "owner decision" },
  "www.saasframe.io": { "mode": "stealth", "enabled": true },
  "ui8.net": { "mode": "browser", "enabled": true },
  "broken": 7
}`;

// ---------------------------------------------------------------- host list

test("hosts: enabled/disabled, the www form, a bad mode dropped with one warning", () => {
  const warnings = [];
  const hosts = loadHosts(hostsFile(HOSTS), { warn: (m) => warnings.push(m) });
  expect([...hosts.keys()].sort()).toEqual(["land-book.com", "saasframe.io", "uiverse.io"]);
  expect(modeFor(hosts, "https://uiverse.io/buttons")).toBe("http");
  expect(modeFor(hosts, "https://www.uiverse.io/buttons")).toBe("http");
  expect(modeFor(hosts, "https://uiverse.io.evil.com/buttons")).toBeNull();
  expect(modeFor(hosts, "https://land-book.com/websites/1")).toBeNull(); // disabled
  expect(modeFor(hosts, "https://ui8.net/x")).toBeNull(); // bad mode
  expect(modeFor(hosts, "https://www.saasframe.io/sitemap.xml")).toBe("stealth");
  expect(modeFor(hosts, "https://saasframe.io/sitemap.xml")).toBe("stealth");
  expect(modeFor(hosts, "https://other.dev/x")).toBeNull(); // unlisted
  expect(modeFor(hosts, "not a url")).toBeNull();
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toMatch(/ui8\.net.*mode/);
  expect(loadHosts(join(tmp("none"), "missing.json")).size).toBe(0); // no file: nothing is opted in
});

// ---------------------------------------------------------------- the child protocol

/** A fake `fetch.py --stdin`: one JSON line and one body file per URL written to stdin. */
function fakeFetch({ records = [], stdout = null, stderr = "" } = {}) {
  const spawned = [];
  const stdins = [];
  const spawn = (cmd) => {
    spawned.push(cmd);
    const dir = cmd[cmd.indexOf("--out-dir") + 1];
    mkdirSync(dir, { recursive: true });
    const lines = records.map((r, i) => {
      if (r.error !== undefined || r.too_large) return JSON.stringify({ url: r.url, status: r.status, file: null, ...r });
      const file = join(dir, `${i + 1}.body`);
      writeFileSync(file, r.content ?? `<html>body ${i + 1}</html>`);
      return JSON.stringify({ ...r, file });
    });
    const stdin = {
      text: "",
      write(s) {
        this.text += s;
        return s.length;
      },
      flush() {},
      end() {},
    };
    stdins.push(stdin);
    return {
      stdin,
      stdout: new Response(stdout ?? (lines.length ? `${lines.join("\n")}\n` : "")).body,
      stderr: new Response(stderr).body,
      exited: Promise.resolve(0),
      kill() {},
    };
  };
  return { spawn, spawned, stdins };
}

test("client: one child per host, www is the same host, bodies come back from the cache dir", async () => {
  const records = [
    { url: "https://uiverse.io/buttons", status: 200, bytes: 18, content_type: "text/html", challenge: false, content: "<html>scraped 1</html>" },
    { url: "https://www.uiverse.io/cards", status: 200, bytes: 18, content_type: "text/html", challenge: false, content: "<html>scraped 2</html>" },
    { url: "https://uiverse.io/admin", status: 0, error: "robots" },
  ];
  const { spawn, spawned, stdins } = fakeFetch({ records });
  const hosts = loadHosts(hostsFile(HOSTS), { warn: () => {} });
  const client = createScraplingClient({ hosts, spawn, outDir: tmp("out"), warn: () => {} });
  const first = await client.get("https://uiverse.io/buttons");
  expect(first.status).toBe(200);
  expect(first.body.toString()).toBe("<html>scraped 1</html>"); // the body is read from `file`
  expect(first.content_type).toBe("text/html");
  expect((await client.get("https://www.uiverse.io/cards")).body.toString()).toBe("<html>scraped 2</html>");
  expect(spawned.length).toBe(1); // one interpreter for the whole host, not one per page
  expect(spawned[0]).toContain("--stdin");
  expect(spawned[0]).toContain("http");
  expect(await client.get("https://uiverse.io/admin")).toEqual({ url: "https://uiverse.io/admin", status: 0, error: "robots", file: null });
  expect(stdins[0].text).toBe("https://uiverse.io/buttons\nhttps://www.uiverse.io/cards\nhttps://uiverse.io/admin\n");
  await client.close();
});

test("client: disabled and unlisted hosts never spawn; a missing venv warns once, not per url", async () => {
  const { spawn, spawned } = fakeFetch({ records: [] });
  const hosts = loadHosts(hostsFile(HOSTS), { warn: () => {} });
  const warnings = [];
  const client = createScraplingClient({ hosts, spawn, outDir: tmp("out2"), exists: () => false, warn: (m) => warnings.push(m) });
  expect(await client.get("https://land-book.com/websites/1")).toBeNull(); // disabled
  expect(await client.get("https://other.dev/x")).toBeNull(); // unlisted
  expect(spawned).toEqual([]);
  expect(warnings).toEqual([]);
  expect(await client.get("https://uiverse.io/buttons")).toBeNull(); // enabled, backend unusable
  expect(await client.get("https://uiverse.io/cards")).toBeNull();
  expect(spawned).toEqual([]);
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toMatch(/falling back to fetch/);
  await client.close();
});

test("client: a child that dies falls back to fetch with one warning", async () => {
  const hosts = loadHosts(hostsFile(`{"uiverse.io": {"mode": "http", "enabled": true}}`), { warn: () => {} });
  const warnings = [];
  const { spawn, stdins } = fakeFetch({ records: [], stderr: "python: boom" }); // no answer, then EOF
  const client = createScraplingClient({ hosts, spawn, outDir: tmp("out3"), warn: (m) => warnings.push(m), timeout: 500 });
  expect(await client.get("https://uiverse.io/buttons")).toBeNull();
  expect(await client.get("https://uiverse.io/cards")).toBeNull(); // the host stays dropped
  expect(warnings.length).toBe(1);
  expect(stdins[0].text).toBe("https://uiverse.io/buttons\n"); // the second url is not sent to a dead child
  await client.close();
});

// ---------------------------------------------------------------- the pattern-side seam

test("get: the filter fetcher takes Scrapling's answer, and fetch's when Scrapling has none", async () => {
  const scraped = await get("https://uiverse.io/buttons", { get: async () => ({ status: 200, body: Buffer.from("<html>scraped</html>"), content_type: "text/html" }) });
  expect(scraped).toEqual({ ok: true, status: 200, type: "text/html", body: "<html>scraped</html>" });
  const refused = await get("https://uiverse.io/admin", { get: async () => ({ status: 0, error: "robots" }) });
  expect(refused).toEqual({ ok: false, status: 0, type: "", body: "", error: "robots" });

  const real = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response("<html>plain</html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
  try {
    const plain = await get("https://x.dev/cards", { get: async () => null });
    expect(plain).toEqual({ ok: true, status: 200, type: "text/html; charset=utf-8", body: "<html>plain</html>" });
    expect(fetched).toEqual(["https://x.dev/cards"]);
    const broken = await get("https://uiverse.io/buttons", {
      get: async () => {
        throw new Error("boom");
      },
    });
    expect(broken.ok).toBe(true); // warn, then fetch — never crash the run
    expect(fetched.length).toBe(2);
  } finally {
    globalThis.fetch = real;
  }
});

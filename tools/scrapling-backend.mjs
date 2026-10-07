// Scrapling as an opt-in fetch backend (brief 11). A host uses it only when
// `catalog/scrapling-hosts.json` lists it with `enabled: true`; every other host (and every `www.` variant
// of a disabled one) keeps the plain Bun `fetch` path.
//
//   loadHosts()          catalog/scrapling-hosts.json → Map(host → {mode, enabled, note})
//   modeFor(hosts, url)  "http" | "stealth" | "dynamic" | null   (the host itself or its www. form)
//   createScraplingClient()  one `fetch.py` child per host, spoken to over stdin/stdout JSON lines:
//                        one interpreter, one session, one robots.txt cache and one pace clock per host run.
//
// Failure policy: a host that is not enabled (or whose backend was already declared broken) yields `null`,
// never a throw — the caller falls back to `fetch`. A missing venv, a missing script, a spawn error or a
// child that dies/stops answering prints **one** warning and then behaves the same way. A JSON line that
// comes back — including `{status: 0, error: "robots"}` — is an answer, not a failure: the caller keeps it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

export const HOSTS_FILE = join(ROOT, "catalog", "scrapling-hosts.json");
export const SCRIPT = join(ROOT, "tools", "scrapling", "fetch.py");
export const PYTHON = join(homedir(), ".venvs", "scrapling", "bin", "python");
export const MODES = new Set(["http", "stealth", "dynamic"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `Promise.race` without the timer leak: the timeout handle is always cleared, so the process can exit. */
async function withTimeout(promise, ms, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(onTimeout), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `{ "<host>": { "mode": "http"|"stealth"|"dynamic", "enabled": bool, "note": string } }` → Map keyed by the
 * www-less host. A missing file, unparsable JSON or an unknown mode drops the entry (an enabled entry with a
 * bad mode warns) — a broken config never crashes a run.
 */
export function loadHosts(file = HOSTS_FILE, { warn = (m) => console.error(m) } = {}) {
  const hosts = new Map();
  if (!existsSync(file)) return hosts;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    warn(`scrapling: ${file}: ${e.message} — no host uses Scrapling`);
    return hosts;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warn(`scrapling: ${file}: expected a {"<host>": {mode, enabled}} object — no host uses Scrapling`);
    return hosts;
  }
  for (const [host, cfg] of Object.entries(raw)) {
    const key = String(host).trim().toLowerCase().replace(/^www\./, "");
    if (!key || !cfg || typeof cfg !== "object") continue;
    const mode = String(cfg.mode ?? "").toLowerCase();
    if (!MODES.has(mode)) {
      if (cfg.enabled === true) warn(`scrapling: ${file}: ${host} has mode ${JSON.stringify(cfg.mode)} (want ${[...MODES].join(", ")}) — host ignored`);
      continue;
    }
    hosts.set(key, { mode, enabled: cfg.enabled === true, note: typeof cfg.note === "string" ? cfg.note : "" });
  }
  return hosts;
}

/** The mode to use for `url`, or null: a host matches itself and its `www.` form, and only when enabled. */
export function modeFor(hosts, url) {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
  const entry = hosts?.get?.(host.replace(/^www\./, ""));
  return entry?.enabled ? entry.mode : null;
}

/** One `fetch.py --stdin` child: writes one URL, reads one JSON line, keeps the process for the next URL. */
function startSession({ host, mode, python, script, outDir, maxBytes, spawn, timeout, readBody }) {
  const dir = join(outDir, host.replace(/[^\w.-]+/g, "_"));
  mkdirSync(dir, { recursive: true });
  const child = spawn([python, "-I", script, "--mode", mode, "--out-dir", dir, "--max-bytes", String(maxBytes), "--stdin"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let stderr = "";
  Promise.resolve(new Response(child.stderr).text())
    .then((t) => {
      const line = String(t || "").trim().split("\n").find((l) => l.trim()) || "";
      if (line) stderr = line;
    })
    .catch(() => {});

  const decoder = new TextDecoder();
  const lines = [];
  const waiters = [];
  let rest = "";
  let eof = false;
  (async () => {
    try {
      for await (const chunk of child.stdout) {
        rest += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = rest.indexOf("\n")) >= 0) {
          const line = rest.slice(0, i);
          rest = rest.slice(i + 1);
          const w = waiters.shift();
          if (w) w(line);
          else lines.push(line);
        }
      }
    } catch {
      /* a broken stream is an EOF: the pending request below fails and the host is dropped */
    }
    eof = true;
    while (waiters.length) waiters.shift()(null);
  })();

  const nextLine = () => (lines.length ? Promise.resolve(lines.shift()) : eof ? Promise.resolve(null) : new Promise((r) => waiters.push(r)));

  async function send(url) {
    try {
      child.stdin.write(`${url}\n`);
      const flushed = child.stdin.flush?.();
      if (flushed && typeof flushed.then === "function") await flushed;
    } catch (e) {
      throw new Error(stderr || String(e?.message || e));
    }
    const line = await withTimeout(nextLine(), timeout, "timeout");
    if (line === "timeout") throw new Error(`no answer within ${Math.round(timeout / 1000)}s${stderr ? ` (${stderr})` : ""}`);
    if (line == null) throw new Error(stderr || "fetch.py exited");
    const rec = JSON.parse(line);
    if (rec?.file) {
      try {
        rec.body = readBody(rec.file);
      } catch (e) {
        rec.error = `body: ${String(e?.message || e)}`;
      }
    }
    return rec;
  }

  return { send, child, stop: () => child.kill?.() };
}

/**
 * The opt-in backend. `get(url)` answers with the `fetch.py` record plus a `body` Buffer, or `null` when the
 * caller must use plain `fetch` (host not enabled, venv/script missing, child dead, or already warned).
 */
export function createScraplingClient({
  hosts = loadHosts(),
  python = PYTHON,
  script = SCRIPT,
  spawn = Bun.spawn,
  exists = existsSync,
  readBody = readFileSync,
  warn = (m) => console.error(m),
  timeout = 120_000,
  maxBytes = 64e6,
  outDir = null, // created on the first enabled URL
} = {}) {
  const sessions = new Map(); // host → session
  const dead = new Map(); // host → why
  let broken = ""; // backend-wide failure: missing venv/script, unusable spawn
  let warned = false;
  let root = outDir;

  const warnOnce = (msg) => {
    if (warned) return;
    warned = true;
    warn(msg);
  };

  async function stop(session) {
    try {
      session.child.stdin?.end?.();
    } catch {
      /* already gone */
    }
    const done = await withTimeout(Promise.resolve(session.child.exited).catch(() => "dead"), 5000, "timeout");
    if (done === "timeout") session.stop();
  }

  return {
    hosts,
    modeFor: (url) => modeFor(hosts, url),
    async get(url) {
      const mode = modeFor(hosts, url);
      if (!mode || broken) return null;
      if (!exists(python) || !exists(script)) {
        broken = `missing ${exists(python) ? script : python}`;
        warnOnce(`scrapling: ${broken} — falling back to fetch`);
        return null;
      }
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      if (dead.has(host)) return null;
      let session = sessions.get(host);
      if (!session) {
        try {
          root ||= mkdtempSync(join(tmpdir(), "design-tools-scrapling-"));
          session = startSession({ host, mode, python, script, outDir: root, maxBytes, spawn, timeout, readBody });
        } catch (e) {
          broken = String(e?.message || e);
          warnOnce(`scrapling: ${broken} — falling back to fetch`);
          return null;
        }
        sessions.set(host, session);
      }
      try {
        return await session.send(url);
      } catch (e) {
        dead.set(host, String(e?.message || e));
        sessions.delete(host);
        await stop(session);
        warnOnce(`scrapling: ${host}: ${dead.get(host)} — falling back to fetch`);
        return null;
      }
    },
    /** EOF for every child: python closes its sessions (and any browser) itself. */
    async close() {
      const open = [...sessions.values()];
      sessions.clear();
      for (const s of open) await stop(s);
    },
  };
}

/** The client both fetchers use; nothing is spawned until an enabled host is actually fetched. */
export const scraplingClient = createScraplingClient();

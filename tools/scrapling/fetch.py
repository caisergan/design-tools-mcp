"""Fetch URLs through Scrapling and cache the raw body of each one (brief 11).

Run with the shared venv (Python 3.12, scrapling 0.4.15):
  ~/.venvs/scrapling/bin/python -I tools/scrapling/fetch.py --mode http --out-dir DIR URL [URL ...]
  ~/.venvs/scrapling/bin/python -I tools/scrapling/fetch.py --mode stealth --out-dir DIR --stdin < urls.txt

Modes: http (TLS-impersonated Chrome request), dynamic (Playwright Chromium), stealth (patched browser +
Cloudflare solver, `solve_cloudflare=True`). All browser modes run `headless=True`. `--stdin` keeps one
session, one robots.txt cache and one pace clock for the whole stream: the caller writes one URL per line
and reads one JSON line back per URL, which is what the Bun side (`tools/scrapling-backend.mjs`) uses so a
multi-page crawl costs one interpreter, not one per page.

One JSON line per URL, in the order the URLs came in:
  {url, final_url, status, bytes, file, challenge, content_type, error?, too_large?}
`file` is `<out-dir>/<n>.body` (n counts from 1 within this process; null for an empty body). robots.txt
for `User-agent: *` is honoured — a disallowed URL is reported, never fetched: {url, status: 0,
error: "robots"}. At least 1 s between two requests to one host (the caller paces too).
"""
import argparse
import json
import os
import sys
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe import allowed, is_challenge, pace  # noqa: E402 — same rules as the probe
from scrapling.fetchers import DynamicSession, Fetcher, StealthySession  # noqa: E402

MODES = ("http", "stealth", "dynamic")


class Fetcher1:
    """One mode, one out-dir, one session per browser mode; every result is a record dict, never an exception."""

    def __init__(self, mode, out_dir, max_bytes=0):
        self.mode = mode
        self.out_dir = out_dir
        self.max_bytes = max_bytes
        self.sessions = {}
        self.n = 0

    def get(self, url):
        self.n += 1
        rec = {"url": url, "final_url": url, "status": 0, "bytes": 0, "file": None, "challenge": False, "content_type": ""}
        try:
            if not allowed(url):
                rec["error"] = "robots"
                return rec
            pace(urlparse(url).netloc)
            if self.mode == "http":
                try:
                    page = Fetcher.get(url, impersonate="chrome", stealthy_headers=True, timeout=30)
                except Exception as e:
                    if "Certificate" not in type(e).__name__:
                        raise
                    page = Fetcher.get(url, impersonate="chrome", stealthy_headers=True, timeout=30, verify=False)
            else:
                if self.mode not in self.sessions:
                    cls, kw = (StealthySession, {"solve_cloudflare": True}) if self.mode == "stealth" else (DynamicSession, {})
                    self.sessions[self.mode] = cls(headless=True, timeout=90000, **kw).__enter__()
                page = self.sessions[self.mode].fetch(url, network_idle=True, wait=2000)
            body = page.body if isinstance(page.body, bytes) else str(page.body).encode()
            rec["status"] = int(getattr(page, "status", 0) or 0)
            rec["final_url"] = str(getattr(page, "url", "") or url)
            rec["challenge"] = is_challenge(body, rec["status"])
            rec["bytes"] = len(body)
            try:
                rec["content_type"] = str(page.headers.get("content-type", "") or "")
            except Exception:
                rec["content_type"] = ""
            if self.max_bytes and len(body) > self.max_bytes:
                rec["too_large"] = True
                return rec
            if body:
                rec["file"] = os.path.join(self.out_dir, f"{self.n}.body")
                with open(rec["file"], "wb") as f:
                    f.write(body)
        except Exception as e:
            rec["error"] = f"{type(e).__name__}: {str(e)[:300]}"
        return rec

    def close(self):
        for s in self.sessions.values():
            s.__exit__(None, None, None)
        self.sessions = {}


def run(urls, fetcher):
    for url in urls:
        print(json.dumps(fetcher.get(url), ensure_ascii=False), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("urls", nargs="*")
    ap.add_argument("--mode", default="http", choices=MODES)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--stdin", action="store_true", help="read urls from stdin, one per line, until EOF")
    ap.add_argument("--max-bytes", type=int, default=0, help="report `too_large` instead of writing a bigger body")
    a = ap.parse_args()
    if not a.urls and not a.stdin:
        sys.exit("no urls")
    os.makedirs(a.out_dir, exist_ok=True)
    fetcher = Fetcher1(a.mode, a.out_dir, a.max_bytes)
    try:
        run(a.urls, fetcher)
        if a.stdin:
            # one line in, one line out: iterate the stream, never materialise it — the caller keeps stdin
            # open and waits for each answer, so a `list(sys.stdin)` here would deadlock both sides.
            for line in sys.stdin:
                url = line.strip()
                if url:
                    print(json.dumps(fetcher.get(url), ensure_ascii=False), flush=True)
    except BrokenPipeError:
        pass
    finally:
        fetcher.close()


if __name__ == "__main__":
    main()

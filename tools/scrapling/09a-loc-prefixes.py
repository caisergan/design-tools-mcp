"""Fetch sitemap XML files and count <loc> per first path segment (brief 09a follow-up).

Same rules as tools/scrapling/probe.py: Scrapling fetchers only, robots.txt honoured for User-agent *,
>= 1 s between two requests to one host, headless browsers, `solve_cloudflare=True` only for `stealth`.
`pace()`, `allowed()` and `base()` below are copied from probe.py (which lives in the main checkout,
not in this worktree).

  ~/.venvs/scrapling/bin/python -I tools/scrapling/09a-loc-prefixes.py --mode stealth \
      --cache ~/.cache/design-tools-scrapling/t09a URL [URL ...]

Prints one JSON line per url: status, final_url, ms, bytes, xml_locs, loc_prefixes (first path segment
-> count), sample_locs (first 5), challenge, cached (raw body path, same scheme as probe.py).
"""
import argparse, hashlib, json, os, re, sys, time
from collections import Counter
from urllib.parse import urlparse
from urllib import robotparser

from scrapling.fetchers import Fetcher, DynamicSession, StealthySession

CHALLENGE = re.compile(rb"Just a moment\.\.\.|cf-chl-|challenge-platform|Attention Required|cf-turnstile|captcha-delivery|px-captcha|Access denied", re.I)
GAP = 1.0
last_hit, robots = {}, {}


def pace(host):  # copied from probe.py
    wait = last_hit.get(host, 0) + GAP - time.time()
    if wait > 0:
        time.sleep(wait)
    last_hit[host] = time.time()


def allowed(url):  # copied from probe.py
    p = urlparse(url)
    if p.netloc not in robots:
        rp = robotparser.RobotFileParser()
        try:
            pace(p.netloc)
            r = Fetcher.get(f"{p.scheme}://{p.netloc}/robots.txt", impersonate="chrome", stealthy_headers=True, timeout=20)
            text = r.body.decode("utf-8", "replace") if isinstance(r.body, bytes) else str(r.body)
            rp.parse(text.splitlines() if r.status == 200 and "<html" not in text[:500].lower() else [])
        except Exception:
            rp.parse([])
        robots[p.netloc] = rp
    return robots[p.netloc].can_fetch("*", url)


def base(host):  # copied from probe.py
    parts = (host or "").lower().removeprefix("www.").split(".")
    return ".".join(parts[-3:] if len(parts) > 2 and len(parts[-1]) == 2 and len(parts[-2]) <= 3 else parts[-2:])


def fetch(url, mode, sessions):
    if mode == "http":
        try:
            return Fetcher.get(url, impersonate="chrome", stealthy_headers=True, timeout=30)
        except Exception as e:
            if "Certificate" not in type(e).__name__:
                raise
            return Fetcher.get(url, impersonate="chrome", stealthy_headers=True, timeout=30, verify=False)
    if mode not in sessions:
        cls, kw = (StealthySession, {"solve_cloudflare": True}) if mode == "stealth" else (DynamicSession, {})
        sessions[mode] = cls(headless=True, timeout=90000, **kw).__enter__()
    return sessions[mode].fetch(url, network_idle=True, wait=2000)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("urls", nargs="+")
    ap.add_argument("--mode", default="http", choices=["http", "dynamic", "stealth"])
    ap.add_argument("--cache")
    ap.add_argument("--out")
    a = ap.parse_args()
    sessions = {}
    try:
        for url in a.urls:
            if not allowed(url):
                rec = {"url": url, "mode": a.mode, "robots": "disallowed"}
            else:
                pace(urlparse(url).netloc)
                t = time.time()
                try:
                    page = fetch(url, a.mode, sessions)
                    body = page.body if isinstance(page.body, bytes) else str(page.body).encode()
                    final = str(getattr(page, "url", "") or url)
                    locs = [m.decode() for m in re.findall(rb"<loc>\s*([^<\s]+)\s*</loc>", body)]
                    prefixes = Counter()
                    for l in locs:
                        seg = urlparse(l).path.strip("/").split("/")[0]
                        prefixes[seg or "/"] += 1
                    rec = {
                        "url": url, "mode": a.mode, "status": page.status, "final_url": final,
                        "ms": int((time.time() - t) * 1000), "bytes": len(body),
                        "challenge": bool(CHALLENGE.search(body[:200000])),
                        "xml_locs": len(locs),
                        "loc_prefixes": dict(prefixes.most_common(20)),
                        "sample_locs": locs[:5],
                    }
                    if a.cache:
                        d = os.path.join(a.cache, urlparse(url).netloc)
                        os.makedirs(d, exist_ok=True)
                        rec["cached"] = os.path.join(d, f"{a.mode}-{hashlib.sha1(url.encode()).hexdigest()[:10]}.html")
                        with open(rec["cached"], "wb") as f:
                            f.write(body)
                except Exception as e:
                    rec = {"url": url, "mode": a.mode, "error": f"{type(e).__name__}: {str(e)[:300]}", "ms": int((time.time() - t) * 1000)}
            line = json.dumps(rec, ensure_ascii=False)
            print(line, flush=True)
            if a.out:
                with open(a.out, "a") as f:
                    f.write(line + "\n")
    finally:
        for s in sessions.values():
            s.__exit__(None, None, None)


if __name__ == "__main__":
    main()

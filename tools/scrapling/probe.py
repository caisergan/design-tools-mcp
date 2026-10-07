"""Probe pages with Scrapling and print one JSON line per (url, mode).

Run with the shared venv (Python 3.12, scrapling 0.4.15):
  ~/.venvs/scrapling/bin/python -I tools/scrapling/probe.py --modes http,stealth --cache DIR URL [URL ...]
  ~/.venvs/scrapling/bin/python -I tools/scrapling/probe.py --modes dynamic --file urls.txt --out results.jsonl

Modes: http (TLS-impersonated Chrome request), dynamic (Playwright Chromium), stealth (patched
browser + Cloudflare solver). robots.txt is honoured for User-agent *; a disallowed url is reported,
not fetched. At least 1 s between two requests to one host.
"""
import argparse, hashlib, json, os, re, sys, time
from collections import Counter
from urllib.parse import urljoin, urlparse
from urllib import robotparser

from scrapling.fetchers import Fetcher, DynamicSession, StealthySession

# A wall, not a real page: the challenge `<title>`, or a 403/503 that carries a challenge marker. The marker
# alone is not enough — real Cloudflare-fronted pages embed the `/cdn-cgi/challenge-platform/scripts/jsd/main.js`
# beacon and i18n strings like "Access Denied" (brief 09's false positive on ui8.net and colorkit.co).
CHALLENGE_TITLE = re.compile(rb"<title[^>]*>\s*(?:just a moment|attention required)[^<]*</title>", re.I)
CHALLENGE_MARK = re.compile(
    rb"cf-chl-|challenge-platform|cf-turnstile|captcha-delivery|px-captcha|just a moment|checking your browser"
    rb"|verify (?:you are|that you are) human|enable javascript and cookies|access denied|attention required",
    re.I,
)
GAP = 1.0
last_hit, robots = {}, {}


def is_challenge(body: bytes, status: int) -> bool:
    head = body[:200_000]
    if CHALLENGE_TITLE.search(head):
        return True
    return status in (403, 503) and bool(CHALLENGE_MARK.search(head))


def pace(host):
    wait = last_hit.get(host, 0) + GAP - time.time()
    if wait > 0:
        time.sleep(wait)
    last_hit[host] = time.time()


def allowed(url):
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


def base(host):
    parts = (host or "").lower().removeprefix("www.").split(".")
    return ".".join(parts[-3:] if len(parts) > 2 and len(parts[-1]) == 2 and len(parts[-2]) <= 3 else parts[-2:])


def summarise(url, mode, page, ms, cache):
    body = page.body if isinstance(page.body, bytes) else str(page.body).encode()
    final = str(getattr(page, "url", "") or url)
    host = base(urlparse(final).hostname)
    hrefs = []
    for a in page.css("a[href]"):
        h = urljoin(final, a.attrib.get("href", "").strip())
        if h.startswith("http"):
            hrefs.append(h.split("#")[0])
    own = sorted({h for h in hrefs if base(urlparse(h).hostname) == host})
    prefixes = Counter("/".join(urlparse(h).path.strip("/").split("/")[:2]) or "/" for h in own)
    ids = [e.attrib.get("id") for e in page.css("section[id], article[id], h2[id], h3[id], [id] > h2, [id] > h3") if e.attrib.get("id")]
    rec = {
        "url": url, "mode": mode, "status": page.status, "final_url": final, "ms": ms, "bytes": len(body),
        "title": (page.css("title::text").get() or "").strip()[:120],
        "challenge": is_challenge(body, page.status),
        "xml_locs": body.count(b"<loc>"),
        "links": len(set(hrefs)), "own_links": len(own),
        "own_prefixes": dict(prefixes.most_common(12)),
        "id_sections": len(set(ids)), "sample_ids": sorted(set(ids))[:15],
        "sample_own": own[:25],
    }
    if cache:
        d = os.path.join(cache, urlparse(url).netloc)
        os.makedirs(d, exist_ok=True)
        rec["cached"] = os.path.join(d, f"{mode}-{hashlib.sha1(url.encode()).hexdigest()[:10]}.html")
        with open(rec["cached"], "wb") as f:
            f.write(body)
    return rec


def run(urls, modes, cache, out):
    sessions = {}
    try:
        for mode in modes:
            for url in urls:
                if not allowed(url):
                    rec = {"url": url, "mode": mode, "robots": "disallowed"}
                else:
                    pace(urlparse(url).netloc)
                    t = time.time()
                    try:
                        if mode == "http":
                            try:
                                page = Fetcher.get(url, impersonate="chrome", stealthy_headers=True, timeout=30)
                            except Exception as e:
                                if "Certificate" not in type(e).__name__:
                                    raise
                                page = Fetcher.get(url, impersonate="chrome", stealthy_headers=True, timeout=30, verify=False)
                        else:
                            if mode not in sessions:
                                cls, kw = (StealthySession, {"solve_cloudflare": True}) if mode == "stealth" else (DynamicSession, {})
                                sessions[mode] = cls(headless=True, timeout=90000, **kw).__enter__()
                            page = sessions[mode].fetch(url, network_idle=True, wait=2000)
                        rec = summarise(url, mode, page, int((time.time() - t) * 1000), cache)
                    except Exception as e:
                        rec = {"url": url, "mode": mode, "error": f"{type(e).__name__}: {str(e)[:300]}", "ms": int((time.time() - t) * 1000)}
                line = json.dumps(rec, ensure_ascii=False)
                print(line, flush=True)
                if out:
                    with open(out, "a") as f:
                        f.write(line + "\n")
    finally:
        for s in sessions.values():
            s.__exit__(None, None, None)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("urls", nargs="*")
    ap.add_argument("--file")
    ap.add_argument("--modes", default="http")
    ap.add_argument("--cache")
    ap.add_argument("--out")
    a = ap.parse_args()
    urls = a.urls + ([l.strip() for l in open(a.file) if l.strip() and not l.startswith("#")] if a.file else [])
    if not urls:
        sys.exit("no urls")
    run(urls, [m.strip() for m in a.modes.split(",")], a.cache, a.out)

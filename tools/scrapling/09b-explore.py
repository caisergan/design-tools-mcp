"""Brief 09 / set B follow-up probes the shared probe.py cannot do.

Two subcommands, same rules as probe.py (Scrapling fetchers only, robots.txt honoured,
>= 1 s between two requests to one host, headless browsers, solve_cloudflare only for stealth):

  locs    fetch a sitemap (http) and count <loc> per first path segment
  scroll  open a page with dynamic/stealth, optionally click "load more" and scroll it,
          then report own links / id sections / custom selector counts

Both print one JSON line per url; --out appends to a jsonl file, --cache stores the raw HTML.

  ~/.venvs/scrapling/bin/python -I tools/scrapling/09b-explore.py scroll --mode dynamic \
      --scrolls 10 --count 'style[id]' --cache ~/.cache/design-tools-scrapling/t09b \
      --out briefs/phase-6/reports/09b-probe.jsonl https://example.com/gallery
  ~/.venvs/scrapling/bin/python -I tools/scrapling/09b-explore.py locs https://example.com/sitemap.xml
"""
import argparse, hashlib, importlib.util, json, os, re, sys, time
from collections import Counter
from urllib.parse import urljoin, urlparse

PROBE_CANDIDATES = [
    os.environ.get("PROBE_PY"),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "probe.py"),
    "/Users/egeayyildiz/Desktop/personal-projects/design-tools/tools/scrapling/probe.py",
]


def load_probe():
    for path in PROBE_CANDIDATES:
        if path and os.path.exists(path):
            spec = importlib.util.spec_from_file_location("probe09", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    sys.exit("probe.py not found (set PROBE_PY)")


probe = load_probe()
from scrapling.fetchers import Fetcher, DynamicSession, StealthySession  # noqa: E402

LOC_RE = re.compile(r"<loc(?:\s[^>]*)?>([\s\S]*?)</loc\s*>", re.I)


def emit(rec, out):
    line = json.dumps(rec, ensure_ascii=False)
    print(line, flush=True)
    if out:
        with open(out, "a") as f:
            f.write(line + "\n")


def save(cache, url, mode, body):
    if not cache:
        return None
    d = os.path.join(cache, urlparse(url).netloc)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"{mode}-scroll-{hashlib.sha1(url.encode()).hexdigest()[:10]}.html")
    with open(path, "wb") as f:
        f.write(body)
    return path


def cmd_locs(urls, out, cache):
    for url in urls:
        if not probe.allowed(url):
            emit({"url": url, "mode": "locs", "robots": "disallowed"}, out)
            continue
        probe.pace(urlparse(url).netloc)
        t = time.time()
        try:
            page = Fetcher.get(url, impersonate="chrome", stealthy_headers=True, timeout=30)
            body = page.body if isinstance(page.body, bytes) else str(page.body).encode()
            locs = [m.strip() for m in LOC_RE.findall(body.decode("utf-8", "replace"))]
            prefixes = Counter("/".join(urlparse(l).path.strip("/").split("/")[:1]) or "/" for l in locs)
            rec = {
                "url": url, "mode": "locs", "status": page.status, "bytes": len(body),
                "xml_locs": len(locs), "prefixes": dict(prefixes.most_common(20)),
                "sample_locs": locs[:10], "ms": int((time.time() - t) * 1000),
            }
            if cache:
                d = os.path.join(cache, urlparse(url).netloc)
                os.makedirs(d, exist_ok=True)
                rec["cached"] = os.path.join(d, f"locs-{hashlib.sha1(url.encode()).hexdigest()[:10]}.xml")
                with open(rec["cached"], "wb") as f:
                    f.write(body)
        except Exception as e:
            rec = {"url": url, "mode": "locs", "error": f"{type(e).__name__}: {str(e)[:300]}", "ms": int((time.time() - t) * 1000)}
        emit(rec, out)


def scroll_action(scrolls, pause, click, clicks, click_pause):
    def action(page):
        for _ in range(clicks):
            if not click:
                break
            try:
                el = page.locator(click).first
                if el.count() == 0:
                    break
                el.click(timeout=5000)
                page.wait_for_timeout(click_pause)
            except Exception:
                break
        for _ in range(scrolls):
            try:
                page.mouse.wheel(0, 4000)
            except Exception:
                break
            page.wait_for_timeout(pause)
        try:
            page.wait_for_load_state("networkidle", timeout=10000)
        except Exception:
            pass
    return action


def cmd_scroll(urls, a):
    cls, kw = (StealthySession, {"solve_cloudflare": True}) if a.mode == "stealth" else (DynamicSession, {})
    if a.mode == "http":
        sys.exit("scroll needs --mode dynamic or stealth")
    action = scroll_action(a.scrolls, a.pause, a.click, a.clicks, a.click_pause)
    with cls(headless=True, timeout=90000, **kw) as session:
        for url in urls:
            if not probe.allowed(url):
                emit({"url": url, "mode": a.mode, "robots": "disallowed"}, a.out)
                continue
            probe.pace(urlparse(url).netloc)
            t = time.time()
            try:
                page = session.fetch(url, network_idle=True, wait=2000, page_action=action)
                body = page.body if isinstance(page.body, bytes) else str(page.body).encode()
                final = str(getattr(page, "url", "") or url)
                host = probe.base(urlparse(final).hostname)
                hrefs = []
                for el in page.css("a[href]"):
                    h = urljoin(final, el.attrib.get("href", "").strip())
                    if h.startswith("http"):
                        hrefs.append(h.split("#")[0])
                own = sorted({h for h in hrefs if probe.base(urlparse(h).hostname) == host})
                ids = [e.attrib.get("id") for e in page.css("section[id], article[id], h2[id], h3[id], [id] > h2, [id] > h3") if e.attrib.get("id")]
                rec = {
                    "url": url, "mode": a.mode, "status": page.status, "final_url": final,
                    "title": (page.css("title::text").get() or "").strip()[:120],
                    "challenge": bool(probe.CHALLENGE.search(body[:200000])),
                    "links": len(set(hrefs)), "own_links": len(own),
                    "own_prefixes": dict(Counter("/".join(urlparse(h).path.strip("/").split("/")[:2]) or "/" for h in own).most_common(15)),
                    "id_sections": len(set(ids)), "sample_ids": sorted(set(ids))[:20],
                    "sample_own": own[:30], "scrolls": a.scrolls, "clicks": a.clicks if a.click else 0,
                    "ms": int((time.time() - t) * 1000), "bytes": len(body),
                }
                counts = {}
                for sel in a.count:
                    try:
                        counts[sel] = len(page.css(sel))
                    except Exception as e:
                        counts[sel] = f"error: {type(e).__name__}"
                if counts:
                    rec["counts"] = counts
                rec["cached"] = save(a.cache, url, a.mode, body)
            except Exception as e:
                rec = {"url": url, "mode": a.mode, "error": f"{type(e).__name__}: {str(e)[:300]}", "ms": int((time.time() - t) * 1000)}
            emit(rec, a.out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("locs", "scroll"):
        s = sub.add_parser(name)
        s.add_argument("urls", nargs="*")
        s.add_argument("--out")
        s.add_argument("--cache")
        if name == "scroll":
            s.add_argument("--mode", default="dynamic")
            s.add_argument("--scrolls", type=int, default=8)
            s.add_argument("--pause", type=int, default=400, help="ms between scroll steps")
            s.add_argument("--click", help="selector clicked up to --clicks times (load more)")
            s.add_argument("--clicks", type=int, default=3)
            s.add_argument("--click-pause", type=int, default=800, help="ms after each click")
            s.add_argument("--count", action="append", default=[], help="extra css selector count, repeatable")
    a = ap.parse_args()
    if not a.urls:
        sys.exit("no urls")
    cmd_locs(a.urls, a.out, a.cache) if a.cmd == "locs" else cmd_scroll(a.urls, a)

"""Does uiverse.io load more cards on scroll? (brief 09a follow-up)

Opens a category page in a headless browser, snapshots the item links, scrolls to the bottom
N times, snapshots again, and reports both counts plus the links that appeared only after
scrolling.

Same rules as tools/scrapling/probe.py: Scrapling fetchers only, robots.txt honoured for
User-agent *, >= 1 s between two requests to one host, headless=True; `stealth` only with
`solve_cloudflare=True`. `pace()`, `allowed()` and `base()` are copied from probe.py.

  ~/.venvs/scrapling/bin/python -I tools/scrapling/09a-uiverse-scroll.py --mode dynamic \
      --cache ~/.cache/design-tools-scrapling/t09a https://uiverse.io/buttons https://uiverse.io/cards
"""
import argparse, hashlib, json, os, re, time
from collections import Counter
from urllib.parse import urlparse
from urllib import robotparser

from scrapling.fetchers import DynamicSession, StealthySession

GAP = 1.0
last_hit, robots = {}, {}
ITEM_SLUG = re.compile(r"^/[^/]+/[a-z0-9-]+-\d+/?$")


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
            from scrapling.fetchers import Fetcher
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


SNAPSHOT_JS = """() => ({
  hrefs: Array.from(document.querySelectorAll('a[href]')).map(a => a.href.split('#')[0]),
  loadMore: Array.from(document.querySelectorAll('button,a[role=button]')).filter(
      e => /load more|show more|daha fazla/i.test(e.textContent || '')).length,
  height: document.body.scrollHeight,
})"""


def make_action(store, steps, pause_ms):
    def action(page):
        store["before"] = page.evaluate(SNAPSHOT_JS)
        for _ in range(steps):
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(pause_ms)
        store["after"] = page.evaluate(SNAPSHOT_JS)
        return None
    return action


def summarise(url, snap, host):
    own = sorted({h for h in snap["hrefs"] if h.startswith("http") and base(urlparse(h).hostname) == host})
    items = sorted(h for h in own if ITEM_SLUG.match(urlparse(h).path))
    prefixes = Counter(urlparse(h).path.strip("/").split("/")[0] for h in own)
    return {"own": len(own), "items": len(items), "prefixes": dict(prefixes.most_common(15)),
            "height": snap["height"], "load_more_buttons": snap["loadMore"], "item_urls": items}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("urls", nargs="+")
    ap.add_argument("--mode", default="dynamic", choices=["dynamic", "stealth"])
    ap.add_argument("--steps", type=int, default=6)
    ap.add_argument("--pause", type=int, default=1500)
    ap.add_argument("--cache")
    ap.add_argument("--out")
    a = ap.parse_args()
    cls, kw = (StealthySession, {"solve_cloudflare": True}) if a.mode == "stealth" else (DynamicSession, {})
    session = cls(headless=True, timeout=90000, **kw).__enter__()
    try:
        for url in a.urls:
            if not allowed(url):
                rec = {"url": url, "mode": a.mode, "robots": "disallowed"}
            else:
                pace(urlparse(url).netloc)
                store = {}
                t = time.time()
                try:
                    page = session.fetch(url, network_idle=True, wait=2000,
                                         page_action=make_action(store, a.steps, a.pause))
                    host = base(urlparse(str(getattr(page, "url", "") or url)).hostname)
                    before = summarise(url, store["before"], host)
                    after = summarise(url, store["after"], host)
                    appeared = sorted(set(after["item_urls"]) - set(before["item_urls"]))
                    rec = {"url": url, "mode": a.mode, "ms": int((time.time() - t) * 1000),
                           "before": before, "after": after, "appeared_after_scroll": len(appeared),
                           "sample_appeared": appeared[:5]}
                    body = page.body if isinstance(page.body, bytes) else str(page.body).encode()
                    if a.cache:
                        d = os.path.join(a.cache, urlparse(url).netloc)
                        os.makedirs(d, exist_ok=True)
                        rec["cached"] = os.path.join(d, f"{a.mode}-scroll-{hashlib.sha1(url.encode()).hexdigest()[:10]}.html")
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
        session.__exit__(None, None, None)


if __name__ == "__main__":
    main()

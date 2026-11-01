#!/usr/bin/env python3
"""Check which stores answer a polite script, and whether their product pages carry readable prices.

For each store: fetch robots.txt, see whether a laptop page is allowed, then fetch that page once and
note the status, response time, size, whether it carries schema.org Product data, and whether it looks
like a bot-check page. Writes scraper/probe-results.json. Run: python3 scraper/probe.py
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scrape import NEXT_RE, PoliteFetcher, http_get, jsonld_products, now_iso, parse_product_page  # noqa: E402

# Stores that answered the first probe (Oct 31, 2026), plus pages to start from.
STORES = {
    "walmart": ["https://www.walmart.com/ip/17849219077", "https://www.walmart.com/ip/17967461396"],
}
LAPTOP_WORDS = re.compile(r"(rog|strix|zephyrus|tuf|legion|loq|omen|victus|predator|helios|nitro|alienware|katana|"
                          r"stealth|raider|vector|crosshair|cyborg|aorus|blade|gaming-laptop|gaming_laptop)", re.I)
BOT_MARKERS = ("px-captcha", "are you a human", "robot or human", "cf-chl", "challenge-platform", "access denied",
               "unusual traffic", "pardon our interruption", "request unsuccessful", "verify you are human")


def summarize(html: str) -> dict:
    low = html.lower()
    prods = jsonld_products(html)
    offers = []
    for pr in prods[:1]:
        raw = pr.get("offers") or []
        for o in (raw if isinstance(raw, list) else [raw])[:4]:
            offers.append({k: (o.get(k) if k != "seller" else (o.get("seller") or {}).get("name"))
                           for k in ("price", "lowPrice", "availability", "seller")})
    return {"kb": len(html) // 1024, "jsonld_products": len(prods), "name": (prods[0].get("name") if prods else None),
            "offers": offers, "next_data": "__next_data__" in low, "bot_check": [m for m in BOT_MARKERS if m in low][:3],
            "title": (re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I) or [None, None])[1]}


def links(html: str, base: str) -> list[str]:
    host = urlparse(base).netloc
    out = []
    for href in re.findall(r'href="([^"#]+)"', html):
        url = urljoin(base, href.replace("&amp;", "&"))
        if urlparse(url).netloc == host and LAPTOP_WORDS.search(url) and url not in out and url != base:
            out.append(url)
    return out[:12]


def get(f: PoliteFetcher, url: str) -> tuple[dict, str]:
    rules = f._robots(url)
    if rules is None:
        return {"url": url, "error": f"robots.txt unreachable ({f.robots_error.get(urlparse(url).netloc)})"}, ""
    if not rules.allowed(url):
        return {"url": url, "error": "disallowed by robots.txt"}, ""
    t = time.time()
    try:
        status, html, final = http_get(f.opener, url, f.headers, f.timeout)
    except Exception as e:
        return {"url": url, "error": f"{e.__class__.__name__}: {str(e)[:160]}", "seconds": round(time.time() - t, 1)}, ""
    info = {"url": url, "final_url": final, "status": status, "seconds": round(time.time() - t, 1), **summarize(html)}
    store = urlparse(url).netloc.split(".")[-2]  # walmart, lenovo, costco, asus, razer
    try:
        info["parsed"] = parse_product_page(html, store)
    except Exception as e:
        info["parsed"] = f"{e.__class__.__name__}: {str(e)[:120]}"
    m = NEXT_RE.search(html)
    if m and not isinstance(info["parsed"], dict):
        try:  # leave a trail of where the data lives, for writing a parser
            nd = json.loads(m.group(1))
            info["next_data_keys"] = list(((((nd.get("props") or {}).get("pageProps") or {}).get("initialData") or {}).get("data") or {}).keys())[:20]
            paths = []

            def walk(node, path, depth=0):  # where do price-like fields live?
                if depth > 12 or len(paths) >= 25:
                    return
                if isinstance(node, dict):
                    for k, v in node.items():
                        if re.search(r"price|seller|availab", k, re.I) and not isinstance(v, (dict, list)):
                            paths.append([f"{path}.{k}", str(v)[:60]])
                        walk(v, f"{path}.{k}", depth + 1)
                elif isinstance(node, list):
                    for i, v in enumerate(node[:3]):
                        walk(v, f"{path}[{i}]", depth + 1)
            walk(nd, "")
            info["price_paths"] = paths
        except ValueError:
            pass
    return info, html


def probe_store(name: str, starts: list[str], f: PoliteFetcher) -> dict:
    pages, found = [], []
    for url in starts:
        info, html = get(f, url)
        if html:
            info["laptop_links"] = links(html, url)
            found += [u for u in info["laptop_links"] if u not in found]
        pages.append(info)
        time.sleep(3)
    # Open the first two product-looking links we found, to see whether product pages carry prices.
    product_like = [u for u in found if re.search(r"/ip/|/p/|/product|\.html$|/products/", u)][:2]
    for url in product_like:
        info, _ = get(f, url)
        info["from_listing"] = True
        pages.append(info)
        time.sleep(3)
    return {"store": name, "pages": pages}


def main():
    f = PoliteFetcher(timeout=20)
    results = []
    for name, starts in STORES.items():
        r = probe_store(name, starts, f)
        print(json.dumps(r)[:3000], flush=True)
        results.append(r)
    path = Path(__file__).resolve().parent / "probe-results.json"
    path.write_text(json.dumps({"checked_at": now_iso(), "results": results}, indent=1))
    print(f"wrote {path.name}")


if __name__ == "__main__":
    main()

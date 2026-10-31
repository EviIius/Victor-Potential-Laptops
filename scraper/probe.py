#!/usr/bin/env python3
"""Check which stores answer a polite script before we add them to the catalog.

For each store: fetch robots.txt, see whether a laptop page is allowed, then fetch that page once and
note the status, response time, size, whether it carries schema.org Product data, and whether it looks
like a bot-check page. Writes scraper/probe-results.json. Run: python3 scraper/probe.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scrape import PoliteFetcher, http_get, jsonld_products, now_iso  # noqa: E402

# One public laptop page per store (a category or search page is enough to see whether scripts get answers).
STORES = {
    "newegg": "https://www.newegg.com/p/pl?N=100167748",
    "bhphoto": "https://www.bhphotovideo.com/c/buy/gaming-laptops/ci/40227",
    "microcenter": "https://www.microcenter.com/category/4294964290/gaming-laptops",
    "costco": "https://www.costco.com/gaming-laptops.html",
    "walmart": "https://www.walmart.com/browse/electronics/gaming-laptops/3944_3951_1089430_1230091_8835131",
    "amazon": "https://www.amazon.com/s?k=gaming+laptop",
    "lenovo": "https://www.lenovo.com/us/en/c/laptops/legion-laptops/",
    "hp": "https://www.hp.com/us-en/shop/vwa/laptops/segm=Gaming",
    "dell": "https://www.dell.com/en-us/shop/gaming-laptops/ar/8212",
    "asus": "https://shop.asus.com/us/rog-laptops.html",
    "msi": "https://us-store.msi.com/Gaming-Laptops",
    "acer": "https://store.acer.com/en-us/laptops/gaming",
    "alienware": "https://www.dell.com/en-us/shop/alienware-laptops/ar/8209",
    "gigabyte": "https://www.gigabyte.com/us/Laptop",
    "razer": "https://www.razer.com/gaming-laptops/razer-blade-16",
    "framework": "https://frame.work/products/laptop16-amd-ai300/configuration/new",
    "bestbuy": "https://www.bestbuy.com/site/laptop-computers/gaming-laptops/pcmcat287600050003.c?id=pcmcat287600050003",
}
BOT_MARKERS = ("captcha", "px-captcha", "access denied", "are you a human", "cf-chl", "challenge-platform",
               "robot check", "unusual traffic", "pardon our interruption", "request unsuccessful")


def probe(name: str, url: str, f: PoliteFetcher) -> dict:
    out: dict = {"store": name, "url": url}
    t = time.time()
    try:
        allowed = f._robots(url)
        out["robots"] = "ok" if allowed is not None else f"unreachable ({f.robots_error.get(url.split('/')[2], '?')})"
        if allowed is None:
            return out
        if not allowed.allowed(url):
            out["page"] = "disallowed by robots.txt"
            return out
        t = time.time()
        status, html, final = http_get(f.opener, url, f.headers, f.timeout)
        low = html.lower()
        out.update(status=status, seconds=round(time.time() - t, 1), kb=len(html) // 1024, final_url=final,
                   jsonld_products=len(jsonld_products(html)), has_dollar_prices=low.count("$") > 5,
                   bot_check=[m for m in BOT_MARKERS if m in low][:3])
    except Exception as e:
        out["error"] = f"{e.__class__.__name__}: {str(e)[:160]}"
        out["seconds"] = round(time.time() - t, 1)
    return out


def main():
    f = PoliteFetcher(timeout=20)
    results = []
    for name, url in STORES.items():
        r = probe(name, url, f)
        print(json.dumps(r), flush=True)
        results.append(r)
        time.sleep(2)
    path = Path(__file__).resolve().parent / "probe-results.json"
    path.write_text(json.dumps({"checked_at": now_iso(), "results": results}, indent=1))
    print(f"wrote {path.name}")


if __name__ == "__main__":
    main()

"""Offline checks for the page parsers: python scraper/test_parse.py"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scrape import Robots, merge, parse_product_page  # noqa: E402
import normalize as N  # noqa: E402

BESTBUY = """<html><head><script type="application/ld+json">%s</script></head><body></body></html>""" % json.dumps([
    {"@type": "BreadcrumbList"},
    {"@type": "Product", "name": "Lenovo - Legion Pro 5", "sku": "6619247",
     "aggregateRating": {"@type": "AggregateRating", "ratingValue": 4.6, "reviewCount": 172},
     "additionalProperty": [{"@type": "PropertyValue", "name": "Graphics", "value": "NVIDIA GeForce RTX 5060"}],
     "offers": [
         {"@type": "Offer", "price": 1789.99, "availability": "https://schema.org/InStock", "itemCondition": "https://schema.org/NewCondition", "seller": {"name": "Velztorm"}},
         {"@type": "Offer", "price": 2249.99, "availability": "https://schema.org/InStock", "itemCondition": "https://schema.org/NewCondition", "seller": {"name": "Best Buy"}},
         {"@type": "Offer", "price": 1580.99, "availability": "https://schema.org/InStock", "itemCondition": "https://schema.org/UsedCondition", "seller": {"name": "Best Buy"}},
     ]},
])

RAZER = ('<button id="mm-add-to-cart_RZ09-05817EN3-R3U1" data-product-sku="RZ09-05817EN3-R3U1" data-product-base-code="x" '
         'data-product-was-price="3499.99" data-product-now-price="3299.99" data-product-currency="USD">Add to cart</button>'
         '<script>{"value":{"code":"RZ09-05817EN3-R3U1","purchasable":true}}</script>')


def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    return cond


ok = True
r = parse_product_page(BESTBUY, "bestbuy", "6619247")
ok &= check(r["price"] == 2249.99, "Best Buy first-party price beats a cheaper marketplace seller")
ok &= check(r["marketplace"] == {"price": 1789.99, "seller": "Velztorm"}, "marketplace offer recorded separately")
ok &= check(r["open_box"] == 1580.99 and r["in_stock"] is True, "open-box price and stock")
ok &= check(r["rating"] == 4.6 and r["reviews"] == 172, "rating")
r = parse_product_page(RAZER, "razer", "RZ09-05817EN3-R3U1")
ok &= check(r["price"] == 3299.99 and r["regular"] == 3499.99 and r["in_stock"] is True, "Razer markup fallback")
ok &= check(N.cpu_key("Intel Core Ultra 9 Series 2 290HX Plus") == "Core Ultra 9 290HX Plus", "CPU normalize (Plus)")
ok &= check(N.cpu_key("AMD Ryzen 200 Series 260") == "Ryzen 7 260", "CPU normalize (Ryzen bare number)")
ok &= check(N.cpu_key("Intel Core 7 Series 2 240H") == "Core 7 240H", "CPU normalize (Core 7 240H, not Ryzen 5 240)")
ok &= check(N.gpu_key("AMD Radeon", "Ryzen AI Max+ 395") == "Radeon 8060S", "GPU normalize (Strix Halo)")

# robots.txt: wildcards, longest match, the right group for our agent (excerpt in the shape of Best Buy's file)
ROBOTS = """User-agent: GPTBot
Allow: /site/
Disallow: /cart

User-agent: Googlebot
User-agent: *
Allow: /~assets/
Disallow: /cart
Disallow: /site/compare?skus=*
Disallow: *cp=1*
Disallow: */product/list/*
Crawl-delay: 2

User-agent: MJ12bot
Disallow: /
"""
rb = Robots(ROBOTS)
ok &= check(rb.allowed("https://www.bestbuy.com/product/hp-victus-15/JJGH2L8JVV"), "robots: product page allowed")
ok &= check(rb.allowed("https://www.bestbuy.com/site/6613956.p?skuId=6613956"), "robots: legacy product URL allowed")
ok &= check(not rb.allowed("https://www.bestbuy.com/site/searchpage.jsp?cp=1&st=laptop"), "robots: leading-wildcard rule blocks")
ok &= check(not rb.allowed("https://www.bestbuy.com/product/list/abc") and not rb.allowed("https://www.bestbuy.com/cart"), "robots: plain and wildcard disallows")
ok &= check(rb.crawl_delay == 2, "robots: crawl-delay honoured")
ok &= check(not Robots(ROBOTS, agent="MJ12bot").allowed("https://x.com/anything"), "robots: agent-specific group")
ok &= check(Robots("").allowed("https://x.com/a") and not Robots("User-agent: *\nDisallow: /").allowed("https://x.com/a"), "robots: empty file vs disallow-all")

# merge: failures keep the old price and flag it; untouched offers carry over; prices_as_of only moves on real refreshes
REF = {"gpus": {"RTX 5060": {"ref_tgp": 100, "vram": 8}}}
CAT = {"retailers": {"bb": {"name": "Best Buy"}}, "families": {"f": {"brand": "X", "name": "One", "tgp": {"RTX 5060": 100}}},
       "laptops": [{"id": f"f-{i}", "family": "f", "offers": [{"retailer": "bb", "sku": str(i), "url": f"https://bb/{i}"}],
                    "specs": {"gpu_key": "RTX 5060"}} for i in (1, 2)]}
meta = lambda t: {"finished": t, "started": t}
obs1 = [{"laptop_id": f"f-{i}", "retailer": "bb", "ok": True, "price": 1000.0 + i, "in_stock": True, "checked_at": "2026-10-31T10:00:00Z"} for i in (1, 2)]
d1 = merge(CAT, None, obs1, REF, meta("2026-10-31T10:05:00Z"), None)
fail = [{"laptop_id": f"f-{i}", "retailer": "bb", "ok": False, "error": "HTTP 403"} for i in (1, 2)]
d2 = merge(CAT, d1, fail, REF, meta("2026-11-01T10:05:00Z"), None)
ok &= check(all(l["price_status"] == "stale" and l["price"] == 1000.0 + i for i, l in zip((1, 2), d2["laptops"])), "merge: failed run keeps last price, flags stale")
ok &= check(d2["prices_as_of"] == "2026-10-31T10:00:00Z" and len(d2["laptops"][0]["history"]) == 1, "merge: failed run doesn't move prices_as_of or history")
part = [{"laptop_id": "f-1", "retailer": "bb", "ok": True, "price": 950.0, "in_stock": True, "checked_at": "2026-11-02T10:00:00Z"}]
d3 = merge(CAT, d1, part, REF, meta("2026-11-02T10:05:00Z"), None)
ok &= check(d3["laptops"][0]["price"] == 950.0 and d3["laptops"][0]["history"][-1] == ["2026-11-02", 950.0], "merge: refreshed price lands in history")
ok &= check(d3["laptops"][1]["price_status"] == "live" and len(d3["laptops"][1]["history"]) == 1, "merge: untouched offer carried over, no fake history point")
ok &= check(d3["prices_as_of"] == "2026-11-02T10:00:00Z" and "_fresh" not in d3["laptops"][0]["offers"][0], "merge: prices_as_of advances, internals stripped")
sys.exit(0 if ok else 1)

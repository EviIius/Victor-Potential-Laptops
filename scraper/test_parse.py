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

WALMART = '<html><script id="__NEXT_DATA__" type="application/json">%s</script></html>' % json.dumps({"props": {"pageProps": {"initialData": {"data": {"product": {
    "usItemId": "17849219077", "name": "ASUS ROG Strix G16", "sellerDisplayName": "Walmart.com", "availabilityStatus": "IN_STOCK",
    "averageRating": 4.44, "numberOfReviews": 240, "priceInfo": {"currentPrice": {"price": 1949.99}, "wasPrice": {"price": 2399.99}}}}}}}})
r = parse_product_page(WALMART, "walmart")
ok &= check(r["price"] == 1949.99 and r["regular"] == 2399.99 and r["in_stock"] and r["seller"] == "Walmart.com" and not r.get("marketplace_only"), "Walmart page data")
r = parse_product_page(WALMART.replace("Walmart.com", "antonline"), "walmart")
ok &= check(r.get("marketplace_only") and r["seller"] == "antonline", "Walmart outside seller flagged")

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
ok &= check(d3["prices_as_of"] == "2026-10-31T10:00:00Z" and "_fresh" not in d3["laptops"][0]["offers"][0], "merge: prices_as_of is the oldest price shown, internals stripped")
full = [{"laptop_id": f"f-{i}", "retailer": "bb", "ok": True, "price": 900.0, "in_stock": True, "checked_at": "2026-11-03T10:00:00Z"} for i in (1, 2)]
d4 = merge(CAT, d3, full, REF, meta("2026-11-03T10:05:00Z"), None)
ok &= check(d4["prices_as_of"] == "2026-11-03T10:00:00Z", "merge: prices_as_of advances when everything refreshes")

# SKU selection must survive unrelated products appearing before or after the target.
products = [{"@type": "Product", "sku": "target", "offers": {"price": 1000}},
            {"@type": "Product", "sku": "other", "offers": {"price": 2000}}]
for order in (products, products[::-1]):
    html = '<script type="application/ld+json">' + json.dumps(order) + '</script>'
    ok &= check(parse_product_page(html, "asus", "target")["price"] == 1000, "SKU match is independent of product order")
try:
    parse_product_page(html, "asus", "missing")
    ok &= check(False, "mismatched SKU rejected")
except ValueError:
    ok &= check(True, "mismatched SKU rejected")
try:
    parse_product_page(RAZER, "razer", "missing")
    ok &= check(False, "fallback cannot take another variant's price")
except ValueError:
    ok &= check(True, "fallback cannot take another variant's price")
r = parse_product_page('<script type="application/ld+json">' + json.dumps(products[0]) + '</script>', "asus", "target")
ok &= check(r["in_stock"] is None, "missing stock stays unknown")

multi = json.loads(json.dumps(CAT))
multi["laptops"] = multi["laptops"][:1]
multi["laptops"][0]["offers"].append({"retailer": "other", "sku": "x", "url": "https://other/x"})
observations = [dict(obs1[0], price=900, in_stock=False, checked_at="2026-11-08T10:00:00Z"),
                dict(obs1[0], retailer="other", price=1000)]
dm = merge(multi, None, observations, REF, meta("2026-11-08T10:05:00Z"), None)
ok &= check(dm["laptops"][0]["price"] == 1000 and dm["prices_as_of"] == "2026-10-31T10:00:00Z", "freshness follows the selected in-stock offer")
stock_only = [dict(obs1[0], price=None, in_stock=False, checked_at="2026-11-08T10:00:00Z")]
ds = merge(CAT, d1, stock_only, REF, meta("2026-11-08T10:05:00Z"), None)
ok &= check(ds["laptops"][0]["price"] == 1001 and ds["laptops"][0]["price_status"] == "unavailable" and ds["laptops"][0]["offers"][0]["checked_at"] == obs1[0]["checked_at"], "stock-only check retains the old price and its confirmation date")
before = json.dumps(d1)
merge(CAT, d1, [dict(obs1[0], price=800)], REF, meta("2026-10-31T12:00:00Z"), None)
ok &= check(json.dumps(d1) == before, "merge does not mutate the previous history")
old = json.loads(json.dumps(d1))
old["laptops"][0]["history"] = [["2025-10-01", 900], ["2026-10-31", 1001]]
dh = merge(CAT, old, [], REF, meta("2026-11-08T10:05:00Z"), None)
ok &= check(dh["laptops"][0]["history"] == [["2026-10-31", 1001]], "history expires by calendar date")
snapshot = [dict(obs1[0], price=500, verification_method="page-reader", checked_at="2026-11-11T10:00:00Z")]
dp = merge(CAT, d1, snapshot, REF, meta("2026-11-11T10:05:00Z"), None)
ok &= check(dp["laptops"][0]["price"] == 1001 and dp["laptops"][0]["offers"][0]["checked_at"] == obs1[0]["checked_at"] and len(dp["laptops"][0]["history"]) == 1, "page snapshots cannot replace a price, confirmation date or history")
correction = [dict(obs1[0], price=2849.99, on_sale=False, verification_method="user-report", checked_at="2026-10-31T12:00:00Z", discard_history_dates=["2026-10-31"])]
dc = merge(CAT, d1, correction, REF, meta("2026-10-31T12:00:00Z"), None)
ok &= check(dc["laptops"][0]["history"] == [["2026-10-31", 2849.99]] and dc["laptops"][0]["offers"][0]["on_sale"] is False, "price corrections remove a false daily low and preserve explicit no-sale status")
two = [dict(obs1[0], retailer="bb", price=800, verification_method="page-reader"), dict(obs1[0], retailer="other", price=1200, source="retailer product page")]
dv = merge(multi, dm, two, REF, meta("2026-11-11T10:05:00Z"), None)
ok &= check(dv["laptops"][0]["price"] == 1200, "direct retailer price takes priority over an unconfirmed cheaper snapshot")
sys.exit(0 if ok else 1)

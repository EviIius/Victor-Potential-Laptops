#!/usr/bin/env python3
"""Refresh prices for the laptops in site/data/catalog.json and write site/data/laptops.json.

Sources, in order of preference:
  1. Best Buy's official Products API, when BESTBUY_API_KEY is set (most reliable; also refreshes the market scan).
  2. Public product pages: the schema.org Product data (JSON-LD) that retailers publish for search engines.
     Requests are slow and polite (one at a time, several seconds apart) and robots.txt is respected.
If a page can't be read, the last known price is kept and marked stale, so the site never goes blank.

Usage:
  python3 scraper/scrape.py                     # live run (standard library only, nothing to install)
  python3 scraper/scrape.py --limit 3 --dry-run # quick test: read 3 pages, print, write nothing
  python3 scraper/scrape.py --offline           # rebuild laptops.json from catalog + previous data only
  python3 scraper/scrape.py --offline --observations scraper/seed/observations-2026-10-31.json \
                           --market scraper/seed/market-2026-10-31.json
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import http.cookiejar
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote, urlencode, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import normalize as N  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "data"
CATALOG = DATA / "catalog.json"
OUTPUT = DATA / "laptops.json"
REFERENCE = DATA / "reference.json"
HISTORY_DAYS = 365
DEFAULT_UA = "Mozilla/5.0 (compatible; VictorLaptopFinder/1.0; +https://github.com/EviIius/Victor-Potential-Laptops)"
UA = os.environ.get("SCRAPER_USER_AGENT", DEFAULT_UA)
ROBOTS_AGENT = "VictorLaptopFinder"  # the product token robots.txt rules are matched against
BESTBUY_CATEGORY = "pcmcat287600050003"  # Best Buy "Gaming Laptops"


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return default


# --------------------------------------------------------------------------- fetching

class Robots:
    """robots.txt rules, including the * and $ wildcards most retailers use (urllib.robotparser ignores those)."""

    def __init__(self, text: str, agent: str = ROBOTS_AGENT):
        groups: list[dict] = []
        cur = None
        in_agents = False
        for line in text.splitlines():
            line = line.split("#", 1)[0].strip()
            if ":" not in line:
                continue
            key, val = (x.strip() for x in line.split(":", 1))
            key = key.lower()
            if key == "user-agent":
                if not in_agents:
                    cur = {"agents": [], "rules": [], "delay": None}
                    groups.append(cur)
                cur["agents"].append(val.lower())
                in_agents = True
            elif cur is not None and key in ("allow", "disallow"):
                cur["rules"].append((key == "allow", val.split()[0] if val else ""))
                in_agents = False
            elif cur is not None and key == "crawl-delay":
                try:
                    cur["delay"] = float(val)
                except ValueError:
                    pass
                in_agents = False
        name = agent.lower()
        mine = [g for g in groups if any(a != "*" and a in name for a in g["agents"])]
        chosen = mine or [g for g in groups if "*" in g["agents"]]
        self.rules = [r for g in chosen for r in g["rules"]]
        delays = [g["delay"] for g in chosen if g["delay"]]
        self.crawl_delay = max(delays) if delays else None

    @staticmethod
    def _matches(pattern: str, path: str) -> bool:
        rx = "".join(".*" if c == "*" else ("$" if c == "$" and i == len(pattern) - 1 else re.escape(c))
                     for i, c in enumerate(pattern))
        return re.match(rx, path) is not None

    def allowed(self, url: str) -> bool:
        u = urlparse(url)
        path = (u.path or "/") + ("?" + u.query if u.query else "")
        best = None  # (pattern length, allow): the longest matching rule wins, Allow wins ties
        for allow, pattern in self.rules:
            if pattern and self._matches(pattern, path):
                if best is None or len(pattern) > best[0] or (len(pattern) == best[0] and allow):
                    best = (len(pattern), allow)
        return True if best is None else best[1]


def http_get(opener, url: str, headers: dict, timeout: float) -> tuple[int, str, str]:
    """GET with the standard library. Returns (status, text, final_url); HTTP errors come back as a status, not an exception."""
    req = urllib.request.Request(url, headers=headers)
    try:
        resp = opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        resp = e
    with resp:
        try:
            body = resp.read()
        except Exception:
            body = b""
        if (resp.headers.get("Content-Encoding") or "").lower() == "gzip" and body:
            body = gzip.decompress(body)
        charset = resp.headers.get_content_charset() or "utf-8"
        return resp.getcode(), body.decode(charset, "replace"), resp.geturl() or url


class PoliteFetcher:
    """One request at a time, a few seconds apart per host, robots.txt respected, gives up on a host after repeated failures."""

    def __init__(self, delay=(3.0, 6.0), timeout=25, max_host_failures=3):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.headers = {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip",
        }
        self.delay, self.timeout = delay, timeout
        self.max_host_failures = max_host_failures
        self.last_hit: dict[str, float] = {}
        self.failures: dict[str, int] = {}
        self.robots: dict[str, Robots | None] = {}
        self.robots_error: dict[str, str] = {}

    def _robots(self, url: str) -> Robots | None:
        u = urlparse(url)
        if u.netloc not in self.robots:
            try:
                status, text, _ = http_get(self.opener, f"{u.scheme}://{u.netloc}/robots.txt", self.headers, self.timeout)
                # RFC 9309: a missing robots.txt (4xx) allows everything; a server error means "assume disallowed".
                self.robots[u.netloc] = Robots(text) if status == 200 else (Robots("") if 400 <= status < 500 else None)
                if self.robots[u.netloc] is None:
                    self.robots_error[u.netloc] = f"HTTP {status}"
            except Exception as e:
                self.robots[u.netloc] = None
                reason = getattr(e, "reason", None) or e
                self.robots_error[u.netloc] = f"{reason.__class__.__name__}: {str(reason)[:140]}"
                if "CERTIFICATE_VERIFY_FAILED" in str(reason) and sys.platform == "darwin":
                    self.robots_error[u.netloc] += " (on a Mac, run 'Install Certificates.command' in your Python folder under Applications)"
        return self.robots[u.netloc]

    def host_blocked(self, url: str) -> bool:
        return self.failures.get(urlparse(url).netloc, 0) >= self.max_host_failures

    def get(self, url: str) -> tuple[int, str, str]:
        host = urlparse(url).netloc
        rules = self._robots(url)
        if rules is None:
            self.failures[host] = self.max_host_failures
            raise PermissionError(f"robots.txt unreachable ({self.robots_error.get(host, 'no response')}), so the site is skipped this run")
        if not rules.allowed(url):
            raise PermissionError("robots.txt disallows this page")
        low, high = self.delay
        floor = rules.crawl_delay or 0
        wait = max(random.uniform(low, high), floor) - (time.time() - self.last_hit.get(host, 0))
        if wait > 0:
            time.sleep(wait)
        self.last_hit[host] = time.time()
        try:
            status, text, final = http_get(self.opener, url, self.headers, self.timeout)
        except Exception:
            self.failures[host] = self.failures.get(host, 0) + 1
            raise
        self.failures[host] = self.failures.get(host, 0) + 1 if status >= 400 else 0
        return status, text, final


# --------------------------------------------------------------------------- parsing

LD_RE = re.compile(r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.S | re.I)


def jsonld_products(html: str) -> list[dict]:
    found = []
    for raw in LD_RE.findall(html):
        try:
            data = json.loads(raw.strip())
        except Exception:
            continue
        stack = data if isinstance(data, list) else [data]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                if node.get("@graph"):
                    stack.extend(node["@graph"])
                t = node.get("@type")
                if t == "Product" or (isinstance(t, list) and "Product" in t):
                    found.append(node)
            elif isinstance(node, list):
                stack.extend(node)
    return found


def _cond(o: dict) -> str:
    c = str(o.get("itemCondition", "")).lower()
    return "used" if "used" in c else "refurbished" if "refurb" in c else "new"


def _avail(o: dict) -> bool | None:
    a = str(o.get("availability", "")).lower()
    if not a:
        return None
    return "instock" in a or "limitedavailability" in a or "preorder" in a


def parse_fallback(html: str, sku: str | None) -> dict | None:
    """Pages that render their Product data client-side (e.g. Razer) still print the price in markup."""
    if sku:
        m = re.search(r'data-product-sku="%s"[^>]*?data-product-was-price="([\d.]+)"[^>]*?data-product-now-price="([\d.]+)"' % re.escape(sku), html)
        if m:
            purchasable = re.search(r'"code":"%s","purchasable":(true|false)' % re.escape(sku), html)
            return {"price": float(m.group(2)), "regular": float(m.group(1)),
                    "in_stock": (purchasable.group(1) == "true") if purchasable else None}
    m = re.search(r'data-product-now-price="([\d.]+)"', html)
    if m:
        return {"price": float(m.group(1)), "in_stock": None}
    meta = re.search(r'<meta[^>]+(?:property|itemprop)=["\'](?:product:price:amount|price)["\'][^>]+content=["\']([\d.,]+)', html)
    if meta:
        return {"price": float(meta.group(1).replace(",", "")), "in_stock": None}
    return None


def parse_product_page(html: str, retailer: str, sku: str | None = None) -> dict:
    """Pull price/availability/rating (and a spec snapshot) out of schema.org Product data."""
    products = [p for p in jsonld_products(html) if p.get("offers")]
    if not products:
        fb = parse_fallback(html, sku)
        if fb:
            return fb
        raise ValueError("no price data found on page (layout may have changed)")
    prod = products[0]
    offers = prod.get("offers") or []
    if isinstance(offers, dict):
        offers = [offers]
    first_party_names = {"bestbuy": "best buy"}
    fp = first_party_names.get(retailer)
    out: dict = {}
    news, used, mkt = [], [], []
    for o in offers:
        price = o.get("price") or o.get("lowPrice")
        try:
            price = float(str(price).replace(",", ""))
        except (TypeError, ValueError):
            continue
        seller = ((o.get("seller") or {}).get("name") or "").strip()
        cond = _cond(o)
        if cond == "new" and (fp is None or not seller or seller.lower() == fp):
            news.append((price, _avail(o)))
        elif cond == "new":
            mkt.append((price, seller))
        elif seller.lower() == (fp or seller.lower()):
            used.append(price)
    if news:
        price, avail = min(news, key=lambda x: x[0])
        out["price"], out["in_stock"] = price, avail if avail is not None else True
    else:
        out["in_stock"] = False
    if used:
        out["open_box"] = min(used)
    if mkt:
        p, s = min(mkt)
        out["marketplace"] = {"price": p, "seller": s}
    rating = prod.get("aggregateRating") or {}
    if rating.get("ratingValue"):
        out["rating"] = float(rating["ratingValue"])
        out["reviews"] = int(rating.get("reviewCount") or rating.get("ratingCount") or 0)
    props = {p.get("name"): p.get("value") for p in prod.get("additionalProperty", []) if isinstance(p, dict)}
    if props:
        out["spec_snapshot"] = {k: props.get(k) for k in (
            "Processor Model", "Processor Model Number", "Graphics", "System Memory (RAM)", "Total Storage Capacity",
            "Screen Size", "Screen Resolution", "Refresh Rate", "Brightness", "Product Weight") if props.get(k)}
    return out


# --------------------------------------------------------------------------- Best Buy official API

def _api_get(path_query: str, params: dict) -> dict:
    url = "https://api.bestbuy.com/v1/products" + quote(path_query, safe="(),=&.") + "?" + urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def bestbuy_api(key: str, skus: list[str], discover: bool) -> tuple[dict, list | None]:
    show = "sku,name,salePrice,regularPrice,onSale,onlineAvailability,orderable,customerReviewAverage,customerReviewCount,url,modelNumber,manufacturer"
    prices: dict = {}
    for i in range(0, len(skus), 90):
        chunk = ",".join(skus[i:i + 90])
        js = _api_get(f"(sku in({chunk}))", {"apiKey": key, "format": "json", "show": show, "pageSize": 100})
        for p in js.get("products", []):
            prices[str(p["sku"])] = p
        time.sleep(0.5)
    market = None
    if discover:
        market, page = [], 1
        while page <= 10:
            js = _api_get(f"(categoryPath.id={BESTBUY_CATEGORY}&active=true)",
                          {"apiKey": key, "format": "json", "show": show, "pageSize": 100, "page": page, "sort": "bestSellingRank.asc"})
            market.extend(js.get("products", []))
            if page >= js.get("totalPages", 1):
                break
            page += 1
            time.sleep(0.5)
    return prices, market


def api_to_obs(p: dict) -> dict:
    return {"price": float(p["salePrice"]), "regular": float(p.get("regularPrice") or p["salePrice"]),
            "in_stock": bool(p.get("onlineAvailability")), "rating": p.get("customerReviewAverage"),
            "reviews": p.get("customerReviewCount"), "url": p.get("url")}


def market_from_api(items: list, tracked: set) -> list:
    out = []
    for p in items:
        title = f"{p.get('manufacturer') or ''} - {p.get('name')}"
        parsed = N.parse_title(p.get("name") or "")
        out.append({k: v for k, v in dict(
            sku=str(p["sku"]), title=p.get("name"), price=p.get("salePrice"), regular=p.get("regularPrice"),
            rating=p.get("customerReviewAverage"), reviews=p.get("customerReviewCount"),
            status="in_stock" if p.get("onlineAvailability") else "sold_out", url=p.get("url"),
            tracked=str(p["sku"]) in tracked, **parsed).items() if v not in (None, "")})
        if not out[-1].get("brand"):
            out[-1]["brand"] = (p.get("manufacturer") or title.split(" ")[0]).strip()
    return out


# --------------------------------------------------------------------------- merge

def merge(catalog: dict, previous: dict | None, observations: list[dict], ref: dict, run_meta: dict, market: dict | None) -> dict:
    prev_by_id = {l["id"]: l for l in (previous or {}).get("laptops", [])}
    obs_by_key = {(o["laptop_id"], o["retailer"]): o for o in observations}
    retailers = catalog.get("retailers", {})
    today = run_meta["finished"][:10]
    laptops = []
    for item in catalog["laptops"]:
        fam = catalog["families"].get(item["family"], {})
        s = dict(item.get("specs", {}))
        s.update(item.get("overrides", {}))
        gpu = s.get("gpu_key")
        tgp = (fam.get("tgp") or {}).get(gpu) or (ref["gpus"].get(gpu, {}).get("ref_tgp"))
        soldered = (s.get("ram_type") or "").upper().startswith("LPDDR") or fam.get("ram_slots") == 0
        prev = prev_by_id.get(item["id"], {})
        prev_offers = {o["retailer"]: o for o in prev.get("offers", [])}
        offers = []
        for off in item["offers"]:
            ob = obs_by_key.get((item["id"], off["retailer"]))
            po = prev_offers.get(off["retailer"], {})
            o = {"retailer": off["retailer"], "retailer_name": retailers.get(off["retailer"], {}).get("name", off["retailer"]),
                 "sku": off.get("sku"), "url": off.get("url"), "manual": bool(off.get("manual"))}
            keep = ("price", "regular", "in_stock", "open_box", "marketplace", "rating", "reviews", "checked_at", "source")
            if ob and ob.get("ok"):  # refreshed this run
                o.update({k: ob.get(k) for k in keep if ob.get(k) is not None})
                o["stale"], o["_fresh"] = False, True
                if ob.get("manual"):
                    o["manual"] = True
            elif ob:  # tried this run and failed: keep the last known price, flag it
                o.update({k: po.get(k) for k in keep if po.get(k) is not None})
                o["stale"] = True
                o["error"] = ob.get("error") or "could not be read"
            elif po:  # not attempted this run (partial run or hand-tracked price): carry over unchanged
                o.update({k: po.get(k) for k in keep if po.get(k) is not None})
                o["stale"] = bool(po.get("stale"))
                if po.get("error") and o["stale"]:
                    o["error"] = po["error"]
            else:
                o["stale"] = True
                o["error"] = "never scraped"
            offers.append(o)
        priced = [o for o in offers if o.get("price")]
        live = [o for o in priced if o.get("in_stock")]
        best = min(live or priced, key=lambda o: o["price"]) if priced else None
        history = [h for h in prev.get("history", [])]
        if best and best.get("_fresh"):
            if history and history[-1][0] == today:
                history[-1][1] = min(history[-1][1], best["price"])
            else:
                history.append([today, best["price"]])
        history = history[-HISTORY_DAYS:]
        status = "unavailable" if best and not best.get("in_stock") else ("manual" if best and best.get("manual") else ("stale" if best and best.get("stale") else "live"))
        laptops.append({
            "id": item["id"], "family": item["family"], "brand": fam.get("brand"), "name": fam.get("name"),
            "year": s.get("year") or fam.get("year"), "form": fam.get("form"), "model": s.get("model"),
            "cpu": s.get("cpu"), "cpu_key": s.get("cpu_key"), "gpu_key": gpu, "vram_gb": s.get("vram_gb") or ref["gpus"].get(gpu, {}).get("vram") or None,
            "tgp_w": tgp, "tgp_estimated": "tgp" in fam.get("estimates", []) or not (fam.get("tgp") or {}).get(gpu),
            "ram_gb": s.get("ram_gb"), "ram_type": s.get("ram_type"), "ram_speed": s.get("ram_speed"), "ram_max_gb": s.get("ram_max_gb"),
            "ram_soldered": soldered, "ram_slots": 0 if soldered else fam.get("ram_slots", 2),
            "storage_gb": s.get("storage_gb"), "m2": s.get("m2"),
            "display": {k: s.get(k) for k in ("size", "w", "h", "hz", "panel", "nits", "touch")},
            "weight_lb": s.get("weight_lb"), "thickness_in": s.get("thickness_in"),
            "battery_wh": fam.get("battery_wh"), "battery_claim_h": s.get("battery_claim_h"),
            "ports": {"tb": s.get("tb"), "usb4": s.get("usb4"), "usb": s.get("usb"), "hdmi": s.get("hdmi"), "eth": s.get("eth")},
            "wifi": s.get("wifi"), "numpad": s.get("numpad"),
            "pros": fam.get("pros", []), "cons": fam.get("cons", []), "awards": fam.get("awards", []), "estimates": fam.get("estimates", []),
            "offers": offers, "price": best["price"] if best else None, "price_retailer": best["retailer_name"] if best else None,
            "price_status": status if best else "unknown", "regular": best.get("regular") if best else None,
            "rating": next((o.get("rating") for o in offers if o.get("rating")), None),
            "reviews": next((o.get("reviews") for o in offers if o.get("reviews")), None),
            "history": history,
        })
    # When prices were last actually confirmed: the newest successful check this run, else whatever the previous file said.
    # How old the prices on the site are: the oldest confirmation among the prices actually shown (hand-tracked ones aside).
    shown = []
    for l in laptops:
        priced = [o for o in l["offers"] if o.get("price") and not o.get("manual") and o.get("checked_at")]
        if priced:
            shown.append(min(priced, key=lambda o: o["price"])["checked_at"])
    prices_as_of = min(shown) if shown else ((previous or {}).get("prices_as_of") or (previous or {}).get("generated_at") or run_meta["finished"])
    for l in laptops:
        for o in l["offers"]:
            o.pop("_fresh", None)
    out = {"generated_at": run_meta["finished"], "prices_as_of": prices_as_of, "scrape": run_meta, "laptops": laptops}
    if market:
        out["market"] = market
    elif previous and previous.get("market"):
        out["market"] = previous["market"]
    return out


# --------------------------------------------------------------------------- main

def run_live(catalog: dict, limit: int | None, only: str | None) -> tuple[list[dict], dict, dict | None]:
    observations: list[dict] = []
    per: dict = {}
    notes: list[str] = []
    market = None
    todo = [(l, o) for l in catalog["laptops"] for o in l["offers"] if not o.get("manual") and (not only or o["retailer"] == only)]
    random.shuffle(todo)
    if limit:
        todo = todo[:limit]

    api_key = os.environ.get("BESTBUY_API_KEY", "").strip()
    if api_key:
        try:
            skus = sorted({o["sku"] for _, o in todo if o["retailer"] == "bestbuy"})
            prices, discovered = bestbuy_api(api_key, skus, discover=True)
            for l, o in [(l, o) for l, o in todo if o["retailer"] == "bestbuy"]:
                p = prices.get(o["sku"])
                rec = {"laptop_id": l["id"], "retailer": "bestbuy", "sku": o["sku"], "checked_at": now_iso()}
                if p:
                    rec.update(api_to_obs(p), ok=True, source="Best Buy Products API")
                else:
                    rec.update(ok=False, error="not returned by Best Buy API (discontinued?)")
                observations.append(rec)
            todo = [(l, o) for l, o in todo if o["retailer"] != "bestbuy"]
            if discovered is not None:
                tracked = {o["sku"] for l in catalog["laptops"] for o in l["offers"] if o["retailer"] == "bestbuy"}
                market = {"generated_at": now_iso(), "source": "Best Buy Products API, Gaming Laptops category", "items": market_from_api(discovered, tracked)}
            notes.append("Best Buy prices came from the official Products API.")
        except Exception as e:  # fall back to product pages
            notes.append(f"Best Buy API failed ({e.__class__.__name__}); fell back to product pages.")

    if todo:
        fetcher = PoliteFetcher()
        for l, o in todo:
            rec = {"laptop_id": l["id"], "retailer": o["retailer"], "sku": o.get("sku"), "checked_at": now_iso()}
            if fetcher.host_blocked(o["url"]):
                rec.update(ok=False, error="skipped: site kept refusing requests this run")
                observations.append(rec)
                continue
            try:
                status, html, final = fetcher.get(o["url"])
                if status != 200:
                    raise RuntimeError(f"HTTP {status}")
                rec.update(parse_product_page(html, o["retailer"], o.get("sku")), ok=True, source=f"{urlparse(final).netloc} product page")
            except Exception as e:
                rec.update(ok=False, error=f"{e.__class__.__name__}: {str(e)[:120]}")
            rec.pop("spec_snapshot", None)
            observations.append(rec)
            print(("ok  " if rec.get("ok") else "ERR ") + l["id"], rec.get("price") or rec.get("error"), flush=True)
    for o in observations:
        d = per.setdefault(o["retailer"], {"ok": 0, "failed": 0})
        d["ok" if o.get("ok") else "failed"] += 1
    names = {o["retailer"]: urlparse(o["url"]).netloc for l in catalog["laptops"] for o in l["offers"] if o.get("url")}
    for r, d in per.items():
        if d["failed"] and not d["ok"]:
            notes.append(f"{names.get(r, r)} didn't answer this machine at all, most likely because it blocks automated traffic "
                         "from cloud servers. Last known prices kept. Fix: run the scrape from a home connection (see README).")
    return observations, {"by_retailer": per, "notes": notes}, market


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--offline", action="store_true", help="don't fetch anything; rebuild from catalog/previous data")
    ap.add_argument("--observations", help="merge observations from this JSON file (seed or manual)")
    ap.add_argument("--market", help="use this market-scan JSON file")
    ap.add_argument("--limit", type=int, help="only scrape N offers (testing)")
    ap.add_argument("--only", help="only scrape one retailer id, e.g. bestbuy")
    ap.add_argument("--dry-run", action="store_true", help="print what was found but don't write laptops.json")
    args = ap.parse_args()

    catalog = load_json(CATALOG)
    ref = load_json(REFERENCE)
    previous = load_json(OUTPUT, {})
    started = now_iso()
    observations: list[dict] = []
    extra: dict = {"by_retailer": {}, "notes": []}
    market = load_json(args.market) if args.market else None

    if args.observations:
        obs_file = load_json(args.observations)
        observations = obs_file["observations"]
        extra["notes"].append(obs_file.get("note") or f"Merged observations from {Path(args.observations).name}.")
    if not args.offline:
        live_obs, live_extra, live_market = run_live(catalog, args.limit, args.only)
        extra = {"by_retailer": live_extra["by_retailer"], "notes": extra["notes"] + live_extra["notes"]}
        seen = {(o["laptop_id"], o["retailer"]) for o in live_obs}
        observations = [o for o in observations if (o["laptop_id"], o["retailer"]) not in seen] + live_obs
        market = live_market or market

    ok = sum(1 for o in observations if o.get("ok"))
    failed = sum(1 for o in observations if not o.get("ok"))
    meta = {"started": started, "finished": now_iso(), "mode": "offline" if args.offline else "live",
            "runner": os.environ.get("SCRAPER_RUNNER") or ("github-actions" if os.environ.get("GITHUB_ACTIONS") else "local"),
            "ok": ok, "failed": failed, "tracked_offers": sum(len(l["offers"]) for l in catalog["laptops"]),
            "by_retailer": extra.get("by_retailer", {}), "notes": extra.get("notes", []),
            "user_agent": UA if not args.offline else None, "api": bool(os.environ.get("BESTBUY_API_KEY"))}
    if args.observations and args.offline:
        meta["runner"] = load_json(args.observations).get("runner", meta["runner"])
        meta["finished"] = load_json(args.observations).get("checked_at", meta["finished"])
    elif args.offline and previous.get("scrape"):
        # A plain rebuild (e.g. after editing catalog.json) isn't a scrape: keep the last run's details and timestamp.
        meta = dict(previous["scrape"])
        meta["finished"] = previous.get("generated_at") or meta.get("finished") or now_iso()
        meta["tracked_offers"] = sum(len(l["offers"]) for l in catalog["laptops"])
    if not args.offline and observations and ok == 0:
        meta["notes"].append("No prices could be read this run, so the site keeps showing the last known prices.")
    data = merge(catalog, previous, observations, ref, meta, market)
    if args.dry_run:
        print(f"dry run: {ok} prices read, {failed} failed; laptops.json not written")
    else:
        OUTPUT.write_text(json.dumps(data, indent=1, ensure_ascii=False))
        what = "rebuilt from the catalog, no scraping" if args.offline and not args.observations else f"{ok} prices refreshed, {failed} failed"
        print(f"wrote {OUTPUT.relative_to(ROOT)}: {len(data['laptops'])} laptops, {what}")
    # Non-zero exit only when a live run refreshed nothing at all, so the workflow flags it.
    if not args.offline and observations and ok == 0:
        sys.exit(2)


if __name__ == "__main__":
    main()

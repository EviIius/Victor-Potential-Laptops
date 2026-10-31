# Victor's Laptop Finder

A small website for picking a gaming + work laptop. It tracks 79 laptop configurations (42 models, $850 to $5,950) with prices scraped from Best Buy, Razer and Framework, scores each one, and explains the trade-offs.

**Live site:** https://eviiius.github.io/Victor-Potential-Laptops/ (once the setup below is done)

| Page | What it does |
| --- | --- |
| Picks for Victor | Ranked shortlist from a budget slider, priority sliders (gaming, work, screen, portability, upgrades, value) and must-haves. Best pick per price tier. |
| Browse all | Sortable, filterable table of every configuration. Click any row for the full breakdown. |
| Compare | Pick any two: a verdict, pros and cons, score bars, what the extra money buys, and a spec table with the winner of each row. |
| Cost analysis | Price vs performance chart with the best-value line, value ranking, cheapest way into each GPU, thin-and-light premium, current deals. |
| Part analysis | Plain-English GPU, CPU, RAM, screen and power explainers, plus GPU and CPU tables. |
| Market scan | Every gaming laptop Best Buy sells and ships itself, so nothing gets missed. |

Settings (budget, sliders, theme, compare picks) are saved in each visitor's browser.

## One-time setup

1. **Push this folder** to `main` on GitHub.
2. **Turn on Pages:** repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
   If the first workflow run failed at "configure-pages" because Pages wasn't on yet, open the run and press **Re-run jobs**.
3. Wait about a minute. The **Actions** tab shows "Scrape prices and publish site"; when it's green the site is live at the address above.
4. **First live scrape:** Actions → "Scrape prices and publish site" → **Run workflow**. Pushes only rebuild the site; live prices come from the daily run, this button, or the site's Re-scrape button.

### The site's Re-scrape button

The button starts the same workflow through the GitHub API, so it needs a key:

1. GitHub → Settings → Developer settings → [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new) → Generate new token.
2. Repository access: **only `EviIius/Victor-Potential-Laptops`**. Permissions: **Actions: Read and write**. Nothing else. Pick an expiry you're happy with.
3. Paste it into the site's Re-scrape dialog, and send it to Victor so he can do the same. It's stored only in the browser it's pasted into, and it can only start and watch this repo's workflows.

Without a key, the dialog still shows when prices were last confirmed, and the repo owner can always use **Run workflow** on GitHub.

## How prices stay fresh

- **Daily:** the workflow runs every morning (11:17 UTC, about 6–7 AM Eastern), scrapes, commits the new prices and republishes. Change the `cron` line in `.github/workflows/scrape.yml`, and the `schedule` text in `site/assets/config.js` to match.
- **What's read:** each product page's schema.org Product data (the structured data stores publish for search engines). For Best Buy it separates Best Buy's own new price from cheaper marketplace sellers and open-box offers, and records rating and stock.
- **Politeness:** one request at a time, 3–6 seconds apart, robots.txt respected (wildcard rules included), an honest user agent, and it stops trying a site after 3 failures in a row. About 6 minutes per run.
- **When a page can't be read,** the last known price is kept and flagged. If a whole run fails, the site keeps the old prices and the header says "last refresh failed" with the date prices were last confirmed.
- **Price history:** one point per day per laptop (kept for a year), shown as a sparkline in each laptop's details.

### If the daily run gets blocked

Best Buy doesn't answer requests from GitHub's servers (first live run, Oct 31, 2026: no response at all, not even robots.txt), so the scrape needs to come from a home connection. Razer.com works from GitHub. Options:

1. **Test from your own computer first:** `python3 scraper/scrape.py --only bestbuy --limit 3 --dry-run`. If those three print prices, a home connection works.
2. **Make that computer the scraper (recommended):** Settings → Actions → Runners → **New self-hosted runner**, run the commands it shows on the computer, then its `./svc.sh install && ./svc.sh start` step so it keeps running after restarts. Then add a repository variable (Settings → Secrets and variables → Actions → **Variables**) named `SCRAPER_RUNNER` with the value `self-hosted`. Only the scrape moves to your computer; building and publishing the site stays on GitHub. The computer has to be on and awake at scrape time. Since the repo is public, also set Settings → Actions → General → fork pull request approval to **Require approval for all external contributors**, so strangers' pull requests can't run code on your machine.
3. **Run it by hand:** `python3 scraper/scrape.py`, then commit and push `site/data/laptops.json`.
4. **Best Buy API key:** if you can get one from [developer.bestbuy.com](https://developer.bestbuy.com/) (Best Buy has historically refused keys for free email addresses like Gmail), add it as a repo secret named `BESTBUY_API_KEY` (Settings → Secrets and variables → Actions). The scraper then uses Best Buy's official Products API for prices and also refreshes the Market scan page.

The Market scan page only refreshes with the API key; otherwise it shows the scan from the date at the top of that page.

## Run it locally

Python 3.9+ and nothing to install (standard library only).

```bash
python3 -m http.server -d site 8000            # then open http://localhost:8000
python3 scraper/test_parse.py                  # offline checks for the parsers, robots.txt and merge logic
python3 scraper/scrape.py --limit 3 --dry-run  # read 3 product pages, print, write nothing
python3 scraper/scrape.py                      # full scrape, rewrites site/data/laptops.json
python3 scraper/scrape.py --offline            # rebuild laptops.json from catalog.json without scraping
```

## Adding or removing laptops

Everything the scraper tracks lives in `site/data/catalog.json`:

- `families` holds what's shared by every configuration of a model: name, brand, GPU power limits (`tgp`, in watts), battery size, RAM slots, pros, cons and review awards.
- `laptops` has one entry per configuration: an `id` (family + SKU), its `family`, its `offers` (retailer, SKU, product URL) and its `specs`.

To add one, copy an existing laptop entry, change the SKU, URL and specs, and push. `cpu_key` and `gpu_key` must match a name in `site/data/reference.json`, which holds the benchmark numbers behind the scores. The push rebuilds the site; the new laptop gets its price on the next scrape. To drop one, delete its entry.

## How the scores work

All scores are 0–100 and only compare laptops on this site.

- **Gaming:** graphics speed relative to a laptop RTX 5060 (= 100), adjusted for how much power that model gives its GPU, with small tweaks for weak CPUs and extra graphics memory.
- **Work:** multi-core CPU speed (half the weight), RAM, graphics and screen.
- **Screen:** resolution, refresh rate, panel type (OLED, Mini-LED, IPS) and brightness.
- **Portability:** weight, thickness and battery size.
- **Upgradeability:** replaceable RAM, spare SSD slots, Thunderbolt or USB4.
- **Value:** gaming and work performance per dollar.
- **Fit:** the visitor's own slider weights applied to the above, within their budget and must-haves.

GPU and CPU figures come from published benchmarks (Notebookcheck and others, listed on the Part analysis page). Power limits marked "est." are estimates where the maker doesn't publish them.

## Files

```
site/                     the website (plain HTML, CSS and JavaScript; no build step)
  index.html
  assets/app.js           scoring, pages, compare, charts, re-scrape button
  assets/app.css
  assets/config.js        repo name, schedule text, site address
  data/catalog.json       the laptops being tracked (edit this)
  data/reference.json     GPU and CPU benchmark tables
  data/laptops.json       generated by the scraper (don't edit by hand)
scraper/
  scrape.py               the scraper
  normalize.py            turns store spec text into GPU/CPU names
  test_parse.py           offline checks
  seed/                   the first price collection (Oct 31, 2026)
.github/workflows/scrape.yml   daily scrape, commit and publish
```

Prices change constantly. Always check the store before buying. Not affiliated with any retailer or manufacturer.

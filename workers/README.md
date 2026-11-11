# Gemini chat setup

The public website stays on GitHub Pages. A small Cloudflare Worker calls Gemini with a private API key and reads the site's published catalog. No database, always-on computer, paid hosting plan or Gemini SDK is required.

## Activate it once

1. Create a key in [Google AI Studio](https://aistudio.google.com/apikey). Use a project on the free tier; enabling billing can incur Gemini charges. The default model is `gemini-3.5-flash-lite`. Google's project quotas apply; free-tier messages may be used to improve Google's products. Do not share the API key with Victor or paste it into chat.
2. Create a [free Cloudflare account](https://dash.cloudflare.com/sign-up). Open **Workers & Pages** and finish the account's `workers.dev` setup if prompted. Copy the **Account ID** from the account dashboard.
3. In [Cloudflare API tokens](https://dash.cloudflare.com/profile/api-tokens), create a token using **Edit Cloudflare Workers**, limited to this account.
4. From the repository directory in your own terminal, run:

   ```sh
   python3 scripts/setup_gemini.py
   ```

   It asks privately for the two API credentials and a separate chat code (at least 16 characters) to share with Victor. Credentials are checked, then sent through stdin to GitHub CLI and stored as encrypted repository secrets. They are never written to the source tree, terminal output or shell arguments. GitHub CLI must already be signed in (`gh auth login`).

5. The script starts [Set up Gemini chat](https://github.com/EviIius/Victor-Potential-Laptops/actions/workflows/deploy-gemini.yml). That workflow tests and deploys the Worker, checks its health, saves only its public URL in `site/data/chat-config.json`, then publishes the website without re-scraping prices. Wait for that workflow and the following **Scrape prices and publish site** run to succeed.
6. Victor opens [Ask Gemini](https://eviiius.github.io/Victor-Potential-Laptops/#chat), enters the **chat access code**, and asks a question. That code is kept in tab session storage; **Forget code** removes it. Conversation history stays in page memory and **New chat** clears it. The Gemini key remains on the backend.

If using GitHub's settings instead of the helper, add repository **secrets** `CLOUDFLARE_API_TOKEN`, `GEMINI_API_KEY`, `CHAT_ACCESS_TOKEN`, and repository **variable** `CLOUDFLARE_ACCOUNT_ID`, then run the same setup workflow. Never put these secrets in `config.js`, `chat-config.json`, issues or commits.

## Behavior and limits

- The Worker loads **all configurations** from the fixed live site's `laptops.json` and `reference.json`, cached for five minutes. The browser sends current budget, priority weights, must-haves, A/B IDs and up to three recent question/answer pairs. It cannot replace the server's catalog.
- `site/assets/scoring.mjs` runs in both the browser and Worker. Fit, gaming, work, display, portability, upgrades and catalog-relative value use exactly the same formulas. Weights are bounded to 0–100.
- Every listing includes its quote timestamp and evidence status. Page-reader snapshots, user reports, manual estimates and old quotes are explicitly distinguished. Only the site's confirmed-sale criteria can produce a verified discount. The Worker does not browse retailers or confirm new prices.
- Source cards use exact catalog IDs and the site's own specs, prices and score rendering. Unknown IDs cause a retryable error. All model answer text is rendered as text, never HTML. Model answers can still be wrong; the cards provide the original records to check.
- An origin allowlist and a separate private chat code protect access. A native Cloudflare rate limiter allows six authenticated questions per minute per IP per Cloudflare location. It is not an absolute global spending cap. Question size, history, request bytes, output tokens and timeouts are bounded. API errors and free-quota exhaustion return readable errors; there is no automatic fallback to a paid model.
- Cloudflare's Workers Free plan allows 100,000 requests/day with its CPU limits; Google's free Gemini quota is usually the tighter limit. Quotas vary by project and model; check AI Studio's current limits. Keep both projects on free plans to avoid paid usage. No message content is logged by this code; Worker observability is disabled.

## Develop and maintain

Requires Node 24 for the dependency-free checks:

```sh
node site/test_app.cjs
node --test workers/test_worker.mjs
```

The Worker imports only the shared scoring module; Wrangler bundles it at deployment. `npx wrangler dev --config workers/wrangler.jsonc` can exercise the backend locally with ignored `.dev.vars` secrets. Requests must carry the configured website Origin and chat code; the catalog still comes from the live HTTPS site. Browser chat endpoints require HTTPS. For frontend development, mock the chat fetch or use a deployed development Worker. Do not commit credentials.

Pushes changing Worker files, the shared scorer or the deployment workflow re-test and re-deploy the backend once the account variable is configured. Site-only pushes follow the existing Pages workflow. Secrets can be rotated in GitHub and applied by re-running **Set up Gemini chat**. To disable chat, clear the endpoint in `site/data/chat-config.json`, push, and delete/disable the Worker in Cloudflare. If the site's host or path changes, update `workers/wrangler.jsonc` before redeploying.

References: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Gemini pricing](https://aistudio.google.com/docs/pricing), [Gemini quotas](https://aistudio.google.com/docs/rate-limits), [Gemini API keys](https://aistudio.google.com/docs/api-key).

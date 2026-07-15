# Connecting your Kalshi account

The site never talks to Kalshi directly. A GitHub Action fetches your portfolio
on a schedule, strips it down to **percentages only**, and commits
`data/kalshi.json`. GitHub Pages serves that file. Your API keys live only in
GitHub Secrets — never in the page, never in the committed data.

```
GitHub Action (every 15 min)  ->  scripts/fetch-kalshi.mjs  ->  data/kalshi.json  ->  the site
        [keys: GitHub Secrets]         [computes % returns]        [no $ , no sizes]
```

## 1. Get Kalshi API credentials

1. Log in at kalshi.com → **Account → API Keys** (or Profile → API).
2. Create a new API key. You'll get:
   - an **API Key ID** (a UUID)
   - a **private key** file (`.pem` / RSA) — downloaded once, save it.

## 2. Add them as GitHub Secrets

In your repo: **Settings → Secrets and variables → Actions → New repository secret**

| Name                  | Value                                                        |
| --------------------- | ----------------------------------------------------------- |
| `KALSHI_API_KEY_ID`   | the API Key ID (UUID)                                        |
| `KALSHI_PRIVATE_KEY`  | the **entire** contents of the `.pem` file (incl. the `-----BEGIN…` / `-----END…` lines) |

## 3. Enable Pages + let the Action commit

- **Settings → Pages** → deploy from branch (e.g. `main`, root).
- The workflow already requests `contents: write`, so it can push the refreshed
  JSON. If pushes are blocked, check **Settings → Actions → General → Workflow
  permissions → Read and write**.

## 4. Test it

- **Actions** tab → **refresh kalshi snapshot** → **Run workflow** (manual run).
- On the first run, temporarily set `DEBUG: "1"` in the workflow's `env:` to dump
  raw responses to `data/_debug/` so you can confirm the field mapping matches
  your account. Kalshi occasionally renames response fields; the small
  `MAPPING` section in `scripts/fetch-kalshi.mjs` is where you'd adjust. Remove
  `DEBUG` afterward (and don't commit `data/_debug/`).

## Run locally (optional)

```bash
KALSHI_API_KEY_ID="your-uuid" \
KALSHI_PRIVATE_KEY="$(cat /path/to/key.pem)" \
DEBUG=1 node scripts/fetch-kalshi.mjs
```

## What gets published (privacy)

`data/kalshi.json` contains **only**:
- percentage returns (net, realized, unrealized, per-market, win rate)
- market titles, tickers, your side (yes/no), and market prices (public info)
- a cumulative return-% curve for the sparkline

It contains **no** dollar amounts, position sizes, quantities, or account
balance. If you later want to hide market prices too, remove the `avg`/`last`
fields from the script's output.

# beaver-mcp

Personal remote MCP server on Cloudflare Workers, connected to Claude as a custom connector.

**Tools**

| Tool | What it does |
|---|---|
| `search_places` | Google Maps keyword search; renders an interactive map widget (MCP Apps) with markers, plus per-place ratings, open-now status, and deep links |
| `get_navigation_link` | Builds a Google Maps directions deep link (free, no API call) — tap on a phone and the Maps app opens ready to navigate |
| `estimate_travel_time` | Travel time + distance via the Routes API (drive/walk/bicycle/transit), optional live traffic |
| `lunchmoney_*` | Lunch Money v2: list/get/update/create transactions, list categories/tags/accounts |

**Auth:** the endpoint is public, so `/mcp` sits behind OAuth (`@cloudflare/workers-oauth-provider`). Claude signs in via GitHub; only logins in the `ALLOWED_GITHUB_LOGINS` secret may authorize (empty = deny all).

## Setup

### 1. GitHub OAuth Apps (one-time)

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App. Create two:

| | Homepage | Callback |
|---|---|---|
| dev | `http://localhost:8788` | `http://localhost:8788/callback` |
| prod | `https://beaver-mcp.<account>.workers.dev` | `https://beaver-mcp.<account>.workers.dev/callback` |

No scopes needed (only the public profile is read).

### 2. Google Maps Platform (one-time)

1. [console.cloud.google.com](https://console.cloud.google.com) → create project → enable **billing** (required even for free tier).
2. Enable APIs: **Places API (New)** (not legacy "Places API"), **Routes API**, **Maps JavaScript API**.
3. Create two API keys:
   - **Server key** → API restriction: Places API (New) + Routes API only; application restriction: None (Workers have no stable egress IP).
   - **Browser key** (ships inside the map widget) → API restriction: Maps JavaScript API only; application restriction: HTTP referrers (add the widget sandbox origin once known — check the iframe origin in devtools when first testing in Claude).
4. Set a budget alert. Personal usage fits the per-SKU free tiers.

### 3. Lunch Money

Create a personal access token at [my.lunchmoney.app/developers](https://my.lunchmoney.app/developers).

### 4. Local dev

```sh
pnpm install
cp .dev.vars.example .dev.vars   # fill in dev OAuth app + keys; COOKIE_ENCRYPTION_KEY = openssl rand -hex 32
pnpm dev                          # http://localhost:8788/mcp
pnpm test
```

Widget iteration without Claude: `http://localhost:8788/widget-preview?widget=map-search&payload=<url-encoded JSON>`.

### 5. Deploy

```sh
npx wrangler kv namespace create OAUTH_KV   # put the returned id into wrangler.jsonc
pnpm deploy                                  # first deploy prints the workers.dev URL

# then set production secrets:
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY
npx wrangler secret put ALLOWED_GITHUB_LOGINS   # your GitHub username
npx wrangler secret put GOOGLE_MAPS_API_KEY
npx wrangler secret put GOOGLE_MAPS_BROWSER_KEY
npx wrangler secret put LUNCHMONEY_TOKEN
```

CI (`.github/workflows/ci.yml`) typechecks/lints/tests every PR and push to `main`, and deploys on `main` after checks pass. Repo secrets required: `CLOUDFLARE_API_TOKEN` (Edit Workers template), `CLOUDFLARE_ACCOUNT_ID`.

### 6. Connect to Claude

claude.ai → Settings → Connectors → Add custom connector → `https://beaver-mcp.<account>.workers.dev/mcp` → sign in with GitHub. The map widget renders on claude.ai, Claude Desktop, and mobile; Claude Code gets the JSON/text fallback.

## Adding another API

The server is built so a new service is one folder: client + tools + a line in `src/index.ts`. See the recipe in [CLAUDE.md](./CLAUDE.md).

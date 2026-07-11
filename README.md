# beaver-mcp

Personal remote MCP server on Cloudflare Workers, connected to Claude as a custom connector at `https://mcp.alanko.dev/mcp`.

**Tools**

| Tool | What it does |
|---|---|
| `lunchmoney_list_transactions` | List/filter transactions (date range, category, tag, status, pending) |
| `lunchmoney_get_transaction` | Single transaction with split/group children |
| `lunchmoney_update_transaction` | Update payee, category, notes, status, tags, amount |
| `lunchmoney_create_transaction` | Create a manual transaction |
| `lunchmoney_list_categories` / `_tags` / `_accounts` | ID lookups for updates |

**Auth:** the endpoint is public, so `/mcp` sits behind OAuth (`@cloudflare/workers-oauth-provider`). Claude signs in via GitHub; only logins in the `ALLOWED_GITHUB_LOGINS` secret may authorize (empty = deny all).

The server is structured so any API becomes MCP tools with one folder (`client.ts` + `tools.ts`) and one line in `src/index.ts` — see the recipe in [CLAUDE.md](./CLAUDE.md). A previous Google Maps service with an MCP Apps map widget was removed (Claude ships equivalent maps features natively); its implementation — including the widget build pipeline — lives in git history at `76b251b` if ever needed as a reference.

## Setup

### 1. GitHub OAuth Apps (one-time)

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App. Create two:

| | Homepage | Callback |
|---|---|---|
| dev | `http://localhost:8788` | `http://localhost:8788/callback` |
| prod | `https://mcp.alanko.dev` | `https://mcp.alanko.dev/callback` |

No scopes needed (only the public profile is read).

### 2. Lunch Money

Create a personal access token at [my.lunchmoney.app/developers](https://my.lunchmoney.app/developers).

### 3. Local dev

```sh
pnpm install
cp .dev.vars.example .dev.vars   # fill in dev OAuth app + token; COOKIE_ENCRYPTION_KEY = openssl rand -hex 32
pnpm dev                          # http://localhost:8788/mcp
pnpm test
```

### 4. Deploy

```sh
npx wrangler kv namespace create OAUTH_KV   # put the returned id into wrangler.jsonc
pnpm deploy

# production secrets:
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY
npx wrangler secret put ALLOWED_GITHUB_LOGINS   # your GitHub username
npx wrangler secret put LUNCHMONEY_TOKEN
```

CI (`.github/workflows/ci.yml`) typechecks/lints/tests every PR and push to `main`, and deploys on `main` after checks pass. Repo secrets required: `CLOUDFLARE_API_TOKEN` (Edit Workers template), `CLOUDFLARE_ACCOUNT_ID`.

### 5. Connect to Claude

claude.ai → Settings → Connectors → Add custom connector → `https://mcp.alanko.dev/mcp` → sign in with GitHub.

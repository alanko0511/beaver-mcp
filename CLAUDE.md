# beaver-mcp

Personal MCP server on Cloudflare Workers. Streamable-HTTP transport at `/mcp`, gated by
GitHub OAuth (`@cloudflare/workers-oauth-provider`) with a login allowlist. Services wrap
external APIs (Google Maps, Lunch Money) as MCP tools; `search_places` additionally renders
an MCP Apps map widget.

## Commands

- `pnpm dev` — build widgets + `wrangler dev` (port 8788)
- `pnpm test` — vitest (runs in workerd via `@cloudflare/vitest-pool-workers`)
- `pnpm check` — Biome lint/format + `tsc --noEmit`
- `pnpm format` — auto-fix
- `pnpm cf-typegen` — regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` or adding secrets to `.dev.vars`
- `pnpm build:widgets` — regenerate `src/generated/widgets.ts` (gitignored; required before tsc/test/dev)

## Architecture

- `src/index.ts` — `OAuthProvider` wiring + `BeaverMCP` (McpAgent Durable Object). Tools register in `init()` by iterating the `services` array.
- `src/auth/` — GitHub OAuth handler (Hono), allowlist, OAuth utils. Access control lives in TWO places on purpose: the `/callback` route (rejects non-allowlisted logins with 403 before completing authorization) and `BeaverMCP.init()` (throws if props fail the same check).
- `src/services/<name>/` — one folder per external API. `types.ts` defines `ToolDef`/`ServiceModule`/`registerService`.
- `widgets/*.html` — MCP Apps widget sources. `scripts/build-widgets.mjs` inlines the ext-apps runtime bundle (iframe CSP blocks CDN imports) and emits `src/generated/widgets.ts`.
- `test/` — vitest; upstream APIs mocked by stubbing global fetch (`test/helpers.ts`). Do NOT use `fetchMock` from `cloudflare:test` — removed in vitest-pool-workers 0.18.

## Public-repo rules (repo is public!)

- NO personal identifiers in code or committed config: no GitHub usernames, emails, account IDs, API keys. The allowlist is the `ALLOWED_GITHUB_LOGINS` secret (comma-separated; empty = deny all).
- Every credential is a Worker secret (`wrangler secret put NAME`) + `.dev.vars` locally (gitignored; keep `.dev.vars.example` in sync with placeholders).
- `wrangler.jsonc` deliberately has no `account_id` — CI uses the `CLOUDFLARE_ACCOUNT_ID` repo secret; local wrangler resolves it from login. The KV namespace ID in `wrangler.jsonc` is an opaque resource ID and OK to commit.

## How to add a new API service

1. Create `src/services/<name>/client.ts`: thin fetch wrapper — base URL, auth header from a secret, error normalization via `UpstreamApiError` (see `lunchmoney/client.ts` as the reference).
2. Create `src/services/<name>/tools.ts`: `defineTool({...})` per action, export a `ServiceModule`. Conventions:
   - Tool names snake_case; prefix with the service name when ambiguous (`lunchmoney_list_transactions`), skip the prefix when self-evident (`search_places`).
   - Every tool sets `annotations` (`readOnlyHint: true` for reads; write tools set `destructiveHint`/`idempotentHint` honestly).
   - Descriptions state gotchas Claude needs (units, sign conventions, ID lookup flow) — they're the only documentation Claude sees.
   - Validate cross-field constraints in the handler and `throw new Error(...)`; `registerService` converts throws to `isError` results.
3. Add the module to the `services` array in `src/index.ts`.
4. Secret: name it `<SERVICE>_TOKEN` (or `<SERVICE>_API_KEY`), add to `.dev.vars` + `.dev.vars.example`, document in the `wrangler.jsonc` comment, run `pnpm cf-typegen`, and `wrangler secret put` it in prod.
5. Tests in `test/<name>-client.test.ts` with `stubFetch` from `test/helpers.ts`: assert auth header, request shape, error normalization.
6. Widget (only if the output is spatial/visual): add `widgets/<name>.html` with the `/*__EXT_APPS_BUNDLE__*/` placeholder, register a `WidgetResource` with explicit `csp` domains, and keep the tool's JSON result meaningful as plain text — non-widget hosts (Claude Code) render it directly.

## Gotchas

- Google Places/Routes: `X-Goog-FieldMask` header is mandatory (400 without). Field masks stay minimal — extra fields bump the billing SKU tier.
- Places response: `displayName` is `{text}`, `location` is `{latitude, longitude}`; Routes wants `{location: {latLng: {...}}}` — different shapes.
- Routes `duration` is a string like `"1620s"`.
- Google Maps deep links use lowercase `travelmode=driving`; Routes API uses `DRIVE`. Map via `ROUTES_MODE_TO_DEEP_LINK`.
- Lunch Money v2 is alpha: amounts are 4dp strings (positive = expense), currency lowercase, `tag_ids` replaces / `additional_tag_ids` appends (mutually exclusive), single-txn PUT returns 201.
- Widget dev loop: `http://localhost:8788/widget-preview?widget=map-search&payload=<url-encoded JSON>&theme=dark` (localhost-only route, fake ExtApps host). In Claude Desktop, widget resources are cached — fully quit (⌘Q) to pick up HTML changes.
- The two Google keys are different: `GOOGLE_MAPS_API_KEY` (server; Places+Routes; never leaves the Worker) vs `GOOGLE_MAPS_BROWSER_KEY` (injected into widget HTML, visible client-side; must be referrer-restricted to Maps JavaScript API only).

# beaver-mcp

Personal MCP server on Cloudflare Workers. Streamable-HTTP transport at `/mcp` (prod: `https://mcp.alanko.dev/mcp`), gated by GitHub OAuth (`@cloudflare/workers-oauth-provider`) with a login allowlist. Services wrap external APIs (Lunch Money, Cloudflare Browser Run) as MCP tools.

## Commands

- `pnpm dev` — `wrangler dev` (port 8788)
- `pnpm test` — vitest (runs in workerd via `@cloudflare/vitest-pool-workers`)
- `pnpm check` — Biome lint/format + `tsc --noEmit`
- `pnpm format` — auto-fix
- `pnpm cf-typegen` — regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` or adding secrets to `.dev.vars`

## Architecture

- `src/index.ts` — `OAuthProvider` wiring + `BeaverMCP` (McpAgent Durable Object). Tools register in `init()` by iterating the `services` array.
- `src/auth/` — GitHub OAuth handler (Hono), allowlist, OAuth utils. Access control lives in TWO places on purpose: the `/callback` route (rejects non-allowlisted logins with 403 before completing authorization) and `BeaverMCP.init()` (throws if props fail the same check).
- `src/services/<name>/` — one folder per external API. `types.ts` defines `ToolDef`/`ServiceModule`/`registerService`. The framework also supports MCP Apps widget tools (`widget:` field + `WidgetResource` with CSP domains); no service currently uses one.
- `test/` — vitest; upstream APIs mocked by stubbing global fetch (`test/helpers.ts`). Do NOT use `fetchMock` from `cloudflare:test` — removed in vitest-pool-workers 0.18.
- Deploys: merge to main → GitHub Actions deploys after checks pass. Manual: `pnpm deploy`.

## Public-repo rules (repo is public!)

- NO personal identifiers in code or committed config: no GitHub usernames, emails, account IDs, API keys. The allowlist is the `ALLOWED_GITHUB_LOGINS` secret (comma-separated; empty = deny all).
- Every credential is a Worker secret (`wrangler secret put NAME`) + `.dev.vars` locally (gitignored; keep `.dev.vars.example` in sync with placeholders).
- `wrangler.jsonc` deliberately has no `account_id` — CI uses the `CLOUDFLARE_ACCOUNT_ID` repo secret; local wrangler resolves it from login. The KV namespace ID in `wrangler.jsonc` is an opaque resource ID and OK to commit.

## How to add a new API service

1. Create `src/services/<name>/client.ts`: thin fetch wrapper — base URL, auth header from a secret, error normalization via `UpstreamApiError` (see `lunchmoney/client.ts` as the reference).
2. Create `src/services/<name>/tools.ts`: `defineTool({...})` per action, export a `ServiceModule`. Conventions:
   - Tool names snake_case; prefix with the service name when ambiguous (`lunchmoney_list_transactions`), skip the prefix when self-evident.
   - Every tool sets `annotations` (`readOnlyHint: true` for reads; write tools set `destructiveHint`/`idempotentHint` honestly).
   - Descriptions state gotchas Claude needs (units, sign conventions, ID lookup flow) — they're the only documentation Claude sees.
   - Validate cross-field constraints in the handler and `throw new Error(...)`; `registerService` converts throws to `isError` results.
3. Add the module to the `services` array in `src/index.ts`.
4. Secret: name it `<SERVICE>_TOKEN` (or `<SERVICE>_API_KEY`), add to `.dev.vars` + `.dev.vars.example`, document in the `wrangler.jsonc` comment, run `pnpm cf-typegen`, and `wrangler secret put` it in prod.
5. Tests in `test/<name>-client.test.ts` with `stubFetch` from `test/helpers.ts`: assert auth header, request shape, error normalization.

## Gotchas

- Lunch Money v2 is alpha: amounts are 4dp strings (positive = expense), currency lowercase, `tag_ids` replaces / `additional_tag_ids` appends (mutually exclusive), single-txn PUT returns 201. Mock server for testing: `https://mock.lunchmoney.dev/v2`.
- OAuth changes: test locally first — the flow needs a browser (`npx mcp-remote http://localhost:8788/mcp --allow-http --transport http-only`), and pace JSON-RPC messages (the Durable Object transport needs the `Mcp-Session-Id` from initialize before accepting more requests).
- For the local mcp-remote flow, run dev as `wrangler dev --local-upstream localhost:8788` — otherwise wrangler infers the host from the custom-domain route and the OAuth metadata advertises `mcp.alanko.dev`, which mcp-remote rejects (`Protected resource ... does not match`).
- Browser Run (`src/services/browser/`): the binding needs NO secret. `compatibility_date` must stay >= 2026-03-24 (floor for the `quickAction` binding method). Session tools carry state via `sessionId` param (connect → act → `disconnect()`, never `close()` except in `browser_session_close`). Local `wrangler dev` runs a real local Chromium for session/puppeteer tools, but does NOT implement `quickAction` ("The RPC receiver does not implement the method") — quick-action tools (`browser_fetch_rendered`, `browser_screenshot`, `browser_scrape`, `browser_get_links`) are only verifiable in prod. Tests stub the binding object (quick actions) and the `sessionDeps` seam in `session.ts` (puppeteer) — `vi.mock` of `@cloudflare/puppeteer` is not needed.

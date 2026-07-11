import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { isLoginAllowed } from "./auth/allowlist";
import { GitHubHandler } from "./auth/github-handler";
import type { Props } from "./auth/utils";
import { lunchmoneyService } from "./services/lunchmoney/tools";
import { registerService } from "./services/types";

const services = [lunchmoneyService];

export class BeaverMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "beaver-mcp",
		version: "0.1.0",
	});

	async init() {
		// Defense in depth: the GitHub callback already rejects non-allowlisted logins,
		// but never expose tools to a session whose props don't pass the same check.
		if (!isLoginAllowed(this.props?.login, this.env.ALLOWED_GITHUB_LOGINS)) {
			throw new Error("Unauthorized: GitHub account is not allowlisted");
		}

		for (const service of services) {
			registerService(this.server, this.env, service);
		}
	}
}

export default new OAuthProvider({
	apiHandler: BeaverMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	// biome-ignore lint/suspicious/noExplicitAny: Hono app type vs provider's handler type (template does the same)
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});

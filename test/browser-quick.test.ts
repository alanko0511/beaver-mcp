import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { browserService } from "../src/services/browser/tools";
import { registerService } from "../src/services/types";

type QuickActionMock = ReturnType<typeof vi.fn>;

function makeEnv(quickAction: QuickActionMock): Env {
	return { BROWSER: { quickAction } } as unknown as Env;
}

async function connect(env: Env) {
	const server = new McpServer({ name: "test", version: "0.0.0" });
	registerService(server, env, browserService);
	const client = new Client({ name: "test-client", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

function jsonSuccess(result: unknown): Response {
	return Response.json({ success: true, result, meta: { status: 200, title: "t" } });
}

describe("browser service registration", () => {
	it("lists all 15 tools with honest annotations", async () => {
		const client = await connect(makeEnv(vi.fn()));
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual(
			[
				"browser_click",
				"browser_evaluate",
				"browser_fetch_rendered",
				"browser_get_links",
				"browser_navigate",
				"browser_read_page",
				"browser_scrape",
				"browser_screenshot",
				"browser_screenshot_session",
				"browser_select",
				"browser_session_close",
				"browser_session_list",
				"browser_session_start",
				"browser_type",
				"browser_wait_for",
			].sort(),
		);
		const byName = new Map(tools.map((t) => [t.name, t]));
		expect(byName.get("browser_fetch_rendered")?.annotations?.readOnlyHint).toBe(true);
		expect(byName.get("browser_click")?.annotations?.destructiveHint).toBe(true);
		expect(byName.get("browser_session_close")?.annotations?.idempotentHint).toBe(true);
	});
});

describe("browser quick-action tools", () => {
	it("browser_fetch_rendered maps markdown format to the markdown action", async () => {
		const quickAction = vi.fn(async () => jsonSuccess("# Hello"));
		const client = await connect(makeEnv(quickAction));

		const result = await client.callTool({
			name: "browser_fetch_rendered",
			arguments: { url: "https://example.com" },
		});
		expect(quickAction).toHaveBeenCalledWith("markdown", { url: "https://example.com" });
		expect(result.content).toEqual([{ type: "text", text: "# Hello" }]);
	});

	it("browser_fetch_rendered maps html format to the content action and forwards wait options", async () => {
		const quickAction = vi.fn(async () => jsonSuccess("<html></html>"));
		const client = await connect(makeEnv(quickAction));

		await client.callTool({
			name: "browser_fetch_rendered",
			arguments: {
				url: "https://example.com",
				format: "html",
				wait_until: "networkidle0",
				wait_for_selector: "#app",
			},
		});
		expect(quickAction).toHaveBeenCalledWith("content", {
			url: "https://example.com",
			gotoOptions: { waitUntil: "networkidle0" },
			waitForSelector: { selector: "#app" },
		});
	});

	it("browser_fetch_rendered truncates long content with a notice", async () => {
		const quickAction = vi.fn(async () => jsonSuccess("x".repeat(2000)));
		const client = await connect(makeEnv(quickAction));

		const result = await client.callTool({
			name: "browser_fetch_rendered",
			arguments: { url: "https://example.com", max_length: 1000 },
		});
		const text = (result.content as Array<{ text: string }>)[0].text;
		expect(text).toContain("[Output truncated at 1000 characters");
		expect(text.startsWith("x".repeat(1000))).toBe(true);
	});

	it("normalizes non-OK responses to Browser Run API errors", async () => {
		const quickAction = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ success: false, errors: [{ message: "invalid url", detail: "nope" }] }),
					{ status: 400 },
				),
		);
		const client = await connect(makeEnv(quickAction));

		const result = await client.callTool({
			name: "browser_fetch_rendered",
			arguments: { url: "https://example.com" },
		});
		expect(result.isError).toBe(true);
		const text = (result.content as Array<{ text: string }>)[0].text;
		expect(text).toContain("Browser Run API error (HTTP 400)");
		expect(text).toContain("invalid url: nope");
	});

	it("flags 429 responses as concurrency/rate limit errors", async () => {
		const quickAction = vi.fn(
			async () =>
				new Response(JSON.stringify({ success: false, errors: [{ message: "too many" }] }), {
					status: 429,
				}),
		);
		const client = await connect(makeEnv(quickAction));

		const result = await client.callTool({
			name: "browser_get_links",
			arguments: { url: "https://example.com" },
		});
		expect(result.isError).toBe(true);
		expect((result.content as Array<{ text: string }>)[0].text).toContain(
			"concurrency/rate limit hit",
		);
	});

	it("browser_screenshot strips the data-URI prefix and returns an inline jpeg with small defaults", async () => {
		const quickAction = vi.fn(
			async () => new Response("data:image/jpeg;base64,aGVsbG8=", { status: 200 }),
		);
		const client = await connect(makeEnv(quickAction));

		const result = await client.callTool({
			name: "browser_screenshot",
			arguments: { url: "https://example.com" },
		});
		expect(result.content).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" }]);
		expect(quickAction).toHaveBeenCalledWith("screenshot", {
			url: "https://example.com",
			viewport: { width: 1280, height: 800 },
			screenshotOptions: { encoding: "base64", type: "jpeg", quality: 80 },
		});
	});

	it("browser_screenshot rejects oversized images with remediation guidance", async () => {
		const quickAction = vi.fn(async () => new Response("A".repeat(1_500_000), { status: 200 }));
		const client = await connect(makeEnv(quickAction));

		const result = await client.callTool({
			name: "browser_screenshot",
			arguments: { url: "https://example.com" },
		});
		expect(result.isError).toBe(true);
		expect((result.content as Array<{ text: string }>)[0].text).toContain("Screenshot too large");
	});

	it("browser_screenshot rejects selector + full_page together", async () => {
		const quickAction = vi.fn();
		const client = await connect(makeEnv(quickAction));

		const result = await client.callTool({
			name: "browser_screenshot",
			arguments: { url: "https://example.com", selector: "#hero", full_page: true },
		});
		expect(result.isError).toBe(true);
		expect(quickAction).not.toHaveBeenCalled();
	});

	it("browser_scrape maps selectors onto elements", async () => {
		const quickAction = vi.fn(async () => jsonSuccess([{ selector: "h1", results: [] }]));
		const client = await connect(makeEnv(quickAction));

		await client.callTool({
			name: "browser_scrape",
			arguments: { url: "https://example.com", selectors: ["h1", ".price"] },
		});
		expect(quickAction).toHaveBeenCalledWith("scrape", {
			url: "https://example.com",
			elements: [{ selector: "h1" }, { selector: ".price" }],
		});
	});

	it("browser_get_links forwards filter flags", async () => {
		const quickAction = vi.fn(async () => jsonSuccess(["https://example.com/a"]));
		const client = await connect(makeEnv(quickAction));

		const result = await client.callTool({
			name: "browser_get_links",
			arguments: { url: "https://example.com", visible_only: true, exclude_external: true },
		});
		expect(quickAction).toHaveBeenCalledWith("links", {
			url: "https://example.com",
			visibleLinksOnly: true,
			excludeExternalLinks: true,
		});
		expect((result.content as Array<{ text: string }>)[0].text).toContain("https://example.com/a");
	});
});

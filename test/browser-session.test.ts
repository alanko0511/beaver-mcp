import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionDeps } from "../src/services/browser/session";
import { browserService } from "../src/services/browser/tools";
import { registerService } from "../src/services/types";

const fakeEnv = { BROWSER: {} } as unknown as Env;
const originalDeps = { ...sessionDeps };

afterEach(() => {
	Object.assign(sessionDeps, originalDeps);
	vi.restoreAllMocks();
});

async function connect() {
	const server = new McpServer({ name: "test", version: "0.0.0" });
	registerService(server, fakeEnv, browserService);
	const client = new Client({ name: "test-client", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

// biome-ignore lint/suspicious/noExplicitAny: loose stubs stand in for puppeteer's Page
function stubPage(overrides: Record<string, any> = {}) {
	return {
		goto: vi.fn(async () => ({ status: () => 200 })),
		url: vi.fn(() => "https://example.com/"),
		title: vi.fn(async () => "Example"),
		click: vi.fn(async () => {}),
		type: vi.fn(async () => {}),
		select: vi.fn(async () => ["b"]),
		evaluate: vi.fn(async () => "visible page text"),
		screenshot: vi.fn(async () => "aGVsbG8="),
		waitForSelector: vi.fn(async () => ({})),
		waitForNavigation: vi.fn(async () => {}),
		setViewport: vi.fn(async () => {}),
		keyboard: { press: vi.fn(async () => {}) },
		accessibility: { snapshot: vi.fn(async () => ({ role: "RootWebArea", name: "Example" })) },
		$: vi.fn(async () => ({ screenshot: vi.fn(async () => "aGVsbG8=") })),
		...overrides,
	};
}

// biome-ignore lint/suspicious/noExplicitAny: loose stubs stand in for puppeteer's Browser
function stubBrowser(page: any, overrides: Record<string, any> = {}) {
	return {
		sessionId: vi.fn(() => "sess-123"),
		pages: vi.fn(async () => [page]),
		newPage: vi.fn(async () => page),
		disconnect: vi.fn(),
		close: vi.fn(async () => {}),
		...overrides,
	};
}

// biome-ignore lint/suspicious/noExplicitAny: assigning stubs into the deps seam
function useDeps(overrides: Record<string, any>) {
	Object.assign(sessionDeps, overrides);
}

function firstText(result: unknown): string {
	return (result as { content: Array<{ text: string }> }).content[0].text;
}

describe("browser_session_start", () => {
	it("launches with the default keep_alive, returns the sessionId, and disconnects (not closes)", async () => {
		const page = stubPage();
		const browser = stubBrowser(page);
		const launch = vi.fn(async () => browser);
		useDeps({ launch });
		const client = await connect();

		const result = await client.callTool({ name: "browser_session_start", arguments: {} });
		expect(launch).toHaveBeenCalledWith(fakeEnv.BROWSER, { keep_alive: 300_000 });
		expect(firstText(result)).toContain("sess-123");
		expect(browser.disconnect).toHaveBeenCalled();
		expect(browser.close).not.toHaveBeenCalled();
		expect(page.setViewport).toHaveBeenCalledWith({ width: 1280, height: 800 });
	});

	it("navigates immediately when url is given", async () => {
		const page = stubPage();
		useDeps({ launch: vi.fn(async () => stubBrowser(page)) });
		const client = await connect();

		await client.callTool({
			name: "browser_session_start",
			arguments: { url: "https://example.com" },
		});
		expect(page.goto).toHaveBeenCalledWith("https://example.com", {
			waitUntil: "domcontentloaded",
		});
	});
});

describe("withSession-based tools", () => {
	it("browser_navigate connects with the sessionId and reports url/status/title", async () => {
		const page = stubPage();
		const browser = stubBrowser(page);
		const connectDep = vi.fn(async () => browser);
		useDeps({ connect: connectDep });
		const client = await connect();

		const result = await client.callTool({
			name: "browser_navigate",
			arguments: { sessionId: "sess-123", url: "https://example.com" },
		});
		expect(connectDep).toHaveBeenCalledWith(fakeEnv.BROWSER, "sess-123");
		const text = firstText(result);
		expect(text).toContain('"status": 200');
		expect(text).toContain('"title": "Example"');
		expect(browser.disconnect).toHaveBeenCalled();
		expect(browser.close).not.toHaveBeenCalled();
	});

	it("disconnects even when the page action throws", async () => {
		const page = stubPage({
			goto: vi.fn(async () => {
				throw new Error("net::ERR_FAILED");
			}),
		});
		const browser = stubBrowser(page);
		useDeps({ connect: vi.fn(async () => browser) });
		const client = await connect();

		const result = await client.callTool({
			name: "browser_navigate",
			arguments: { sessionId: "sess-123", url: "https://example.com" },
		});
		expect(result.isError).toBe(true);
		expect(browser.disconnect).toHaveBeenCalled();
	});

	it("maps a failed connect to recovery guidance", async () => {
		useDeps({
			connect: vi.fn(async () => {
				throw new Error("no such session");
			}),
		});
		const client = await connect();

		const result = await client.callTool({
			name: "browser_read_page",
			arguments: { sessionId: "gone" },
		});
		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain("browser_session_start");
	});
});

describe("browser_session_close / _list", () => {
	it("treats an unreachable session as already closed", async () => {
		useDeps({
			connect: vi.fn(async () => {
				throw new Error("no such session");
			}),
		});
		const client = await connect();

		const result = await client.callTool({
			name: "browser_session_close",
			arguments: { sessionId: "gone" },
		});
		expect(result.isError).toBeFalsy();
		expect(firstText(result)).toContain("already closed");
	});

	it("closes a live session", async () => {
		const browser = stubBrowser(stubPage());
		useDeps({ connect: vi.fn(async () => browser) });
		const client = await connect();

		const result = await client.callTool({
			name: "browser_session_close",
			arguments: { sessionId: "sess-123" },
		});
		expect(browser.close).toHaveBeenCalled();
		expect(firstText(result)).toContain("closed");
	});

	it("merges sessions and limits", async () => {
		useDeps({
			sessions: vi.fn(async () => [{ sessionId: "sess-123", startTime: 1 }]),
			limits: vi.fn(async () => ({ maxConcurrentSessions: 120 })),
		});
		const client = await connect();

		const result = await client.callTool({ name: "browser_session_list", arguments: {} });
		const text = firstText(result);
		expect(text).toContain("sess-123");
		expect(text).toContain("maxConcurrentSessions");
	});
});

describe("interaction tools", () => {
	it("browser_click waits for the selector, then clicks", async () => {
		const page = stubPage();
		useDeps({ connect: vi.fn(async () => stubBrowser(page)) });
		const client = await connect();

		await client.callTool({
			name: "browser_click",
			arguments: { sessionId: "sess-123", selector: "#submit" },
		});
		expect(page.waitForSelector).toHaveBeenCalledWith("#submit", {
			timeout: 10_000,
			visible: true,
		});
		expect(page.click).toHaveBeenCalledWith("#submit");
	});

	it("browser_click selector timeout points Claude at the a11y tree", async () => {
		const page = stubPage({
			waitForSelector: vi.fn(async () => {
				throw new Error("timeout");
			}),
		});
		useDeps({ connect: vi.fn(async () => stubBrowser(page)) });
		const client = await connect();

		const result = await client.callTool({
			name: "browser_click",
			arguments: { sessionId: "sess-123", selector: "#missing" },
		});
		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain("browser_read_page");
	});

	it("browser_type clears first and presses Enter when asked", async () => {
		const page = stubPage();
		useDeps({ connect: vi.fn(async () => stubBrowser(page)) });
		const client = await connect();

		await client.callTool({
			name: "browser_type",
			arguments: { sessionId: "sess-123", selector: "#q", text: "hello", press_enter: true },
		});
		expect(page.click).toHaveBeenCalledWith("#q", { clickCount: 3 });
		expect(page.keyboard.press).toHaveBeenCalledWith("Backspace");
		expect(page.type).toHaveBeenCalledWith("#q", "hello");
		expect(page.keyboard.press).toHaveBeenCalledWith("Enter");
	});

	it("browser_read_page evaluates innerText as a string expression and truncates", async () => {
		const page = stubPage({ evaluate: vi.fn(async () => "y".repeat(2000)) });
		useDeps({ connect: vi.fn(async () => stubBrowser(page)) });
		const client = await connect();

		const result = await client.callTool({
			name: "browser_read_page",
			arguments: { sessionId: "sess-123", max_length: 1000 },
		});
		expect(page.evaluate).toHaveBeenCalledWith("document.body.innerText");
		expect(firstText(result)).toContain("[Output truncated at 1000 characters");
	});

	it("browser_read_page a11y format returns the accessibility snapshot", async () => {
		const page = stubPage();
		useDeps({ connect: vi.fn(async () => stubBrowser(page)) });
		const client = await connect();

		const result = await client.callTool({
			name: "browser_read_page",
			arguments: { sessionId: "sess-123", format: "a11y" },
		});
		expect(page.accessibility.snapshot).toHaveBeenCalled();
		expect(firstText(result)).toContain("RootWebArea");
	});

	it("browser_screenshot_session returns an inline image", async () => {
		const page = stubPage();
		useDeps({ connect: vi.fn(async () => stubBrowser(page)) });
		const client = await connect();

		const result = await client.callTool({
			name: "browser_screenshot_session",
			arguments: { sessionId: "sess-123" },
		});
		expect(result.content).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" }]);
		expect(page.screenshot).toHaveBeenCalledWith({
			encoding: "base64",
			type: "jpeg",
			quality: 80,
			fullPage: false,
		});
	});

	it("browser_evaluate wraps in-page errors", async () => {
		const page = stubPage({
			evaluate: vi.fn(async () => {
				throw new Error("boom in page");
			}),
		});
		useDeps({ connect: vi.fn(async () => stubBrowser(page)) });
		const client = await connect();

		const result = await client.callTool({
			name: "browser_evaluate",
			arguments: { sessionId: "sess-123", expression: "explode()" },
		});
		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain("Page script threw");
	});

	it("browser_wait_for requires exactly one of selector / delay_ms", async () => {
		useDeps({ connect: vi.fn(async () => stubBrowser(stubPage())) });
		const client = await connect();

		const neither = await client.callTool({
			name: "browser_wait_for",
			arguments: { sessionId: "sess-123" },
		});
		expect(neither.isError).toBe(true);

		const both = await client.callTool({
			name: "browser_wait_for",
			arguments: { sessionId: "sess-123", selector: "#x", delay_ms: 500 },
		});
		expect(both.isError).toBe(true);
	});

	it("browser_wait_for waits a fixed delay", async () => {
		useDeps({ connect: vi.fn(async () => stubBrowser(stubPage())) });
		const client = await connect();

		const result = await client.callTool({
			name: "browser_wait_for",
			arguments: { sessionId: "sess-123", delay_ms: 100 },
		});
		expect(firstText(result)).toBe("Waited 100ms.");
	});
});

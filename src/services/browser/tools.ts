import { z } from "zod";
import { defineTool, imageResult, jsonResult, type ServiceModule, textResult } from "../types";
import {
	guardImageSize,
	pageLoadOptions,
	runQuickAction,
	stripDataUriPrefix,
	truncateText,
} from "./client";
import {
	KEEP_ALIVE_DEFAULT_MS,
	KEEP_ALIVE_MAX_MS,
	requireSelector,
	sessionDeps,
	takeSessionScreenshot,
	withSession,
} from "./session";

const WAIT_UNTIL = z
	.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"])
	.describe("When to consider navigation done (networkidle0 waits for quiet network)");
const WAIT_FOR_SELECTOR = z
	.string()
	.optional()
	.describe("CSS selector to wait for before capturing");
const SESSION_ID = z.string().describe("Session ID returned by browser_session_start");
const MAX_LENGTH = z.number().int().min(1000).max(200_000).default(40_000);
const SCREENSHOT_FORMAT = z
	.enum(["jpeg", "png"])
	.default("jpeg")
	.describe("jpeg (quality 80) keeps the image small; png only when fidelity matters");

/**
 * Prepended to every entry-point tool: the user prefers their local
 * "Claude in Chrome" browser tools over this remote Cloudflare browser.
 */
const LOCAL_BROWSER_NOTE =
	"NOTE: This runs a REMOTE headless browser on Cloudflare. If Claude-in-Chrome browser tools " +
	"(mcp__claude-in-chrome__*) are available in this session, use those instead — unless the user " +
	"explicitly asked for the remote browser. If they are not available, ask the user whether to " +
	"use the remote browser before proceeding. ";

// ---------------------------------------------------------------------------
// Quick actions (stateless — each call spins up and tears down its own browser)
// ---------------------------------------------------------------------------

const fetchRenderedTool = defineTool({
	name: "browser_fetch_rendered",
	description:
		LOCAL_BROWSER_NOTE +
		"Fetch a page with a real headless browser (JavaScript executed) and return it as markdown or " +
		"rendered HTML. Use when plain web fetch returns an empty JS shell or client-rendered content. " +
		"Stateless — for multi-step interaction use browser_session_start instead.",
	inputSchema: {
		url: z.string().url(),
		format: z
			.enum(["markdown", "html"])
			.default("markdown")
			.describe("markdown is far cheaper to read; html only when markup structure matters"),
		wait_until: WAIT_UNTIL.optional(),
		wait_for_selector: WAIT_FOR_SELECTOR,
		max_length: MAX_LENGTH,
	},
	annotations: { title: "Fetch rendered page", readOnlyHint: true, openWorldHint: true },
	handler: async (args, { env }) => {
		const action = args.format === "markdown" ? "markdown" : "content";
		const response = await runQuickAction(env, action, pageLoadOptions(args));
		const body = (await response.json()) as { success: boolean; result: string };
		if (!body.success) {
			throw new Error(`Browser Run returned success=false for ${action}`);
		}
		return textResult(truncateText(body.result, args.max_length));
	},
});

const screenshotTool = defineTool({
	name: "browser_screenshot",
	description:
		LOCAL_BROWSER_NOTE +
		"Take a screenshot of a URL (no session needed) and return it as an inline image. " +
		"Defaults to a 1280×800 viewport JPEG to keep the image small. full_page on long pages can " +
		"exceed the inline size limit — prefer selector to capture one element.",
	inputSchema: {
		url: z.string().url(),
		full_page: z.boolean().default(false).describe("Capture the whole scroll height (can be huge)"),
		selector: z
			.string()
			.optional()
			.describe("Screenshot only the first element matching this CSS selector"),
		viewport_width: z.number().int().min(320).max(1920).default(1280),
		viewport_height: z.number().int().min(320).max(1920).default(800),
		format: SCREENSHOT_FORMAT,
		wait_until: WAIT_UNTIL.optional(),
		wait_for_selector: WAIT_FOR_SELECTOR,
	},
	annotations: { title: "Screenshot URL", readOnlyHint: true, openWorldHint: true },
	handler: async (args, { env }) => {
		if (args.selector && args.full_page) {
			throw new Error("selector and full_page are mutually exclusive");
		}
		const options = {
			...pageLoadOptions(args),
			viewport: { width: args.viewport_width, height: args.viewport_height },
			...(args.selector ? { selector: args.selector } : {}),
			screenshotOptions: {
				encoding: "base64" as const,
				type: args.format,
				...(args.format === "jpeg" ? { quality: 80 } : {}),
				...(args.full_page ? { fullPage: true } : {}),
			},
		};
		const response = await runQuickAction(env, "screenshot", options);
		const base64 = guardImageSize(stripDataUriPrefix(await response.text()));
		return imageResult(base64, `image/${args.format}`);
	},
});

const scrapeTool = defineTool({
	name: "browser_scrape",
	description:
		LOCAL_BROWSER_NOTE +
		"Extract text, HTML, and attributes of elements matching CSS selectors from a rendered page " +
		"(JavaScript executed). Returns per-selector results with every matching element.",
	inputSchema: {
		url: z.string().url(),
		selectors: z.array(z.string()).min(1).max(20).describe("CSS selectors to extract"),
		wait_until: WAIT_UNTIL.optional(),
		wait_for_selector: WAIT_FOR_SELECTOR,
	},
	annotations: { title: "Scrape elements", readOnlyHint: true, openWorldHint: true },
	handler: async (args, { env }) => {
		const options = {
			...pageLoadOptions(args),
			elements: args.selectors.map((selector) => ({ selector })),
		};
		const response = await runQuickAction(env, "scrape", options);
		const body = (await response.json()) as { success: boolean; result: unknown };
		return jsonResult(body.result);
	},
});

const getLinksTool = defineTool({
	name: "browser_get_links",
	description:
		LOCAL_BROWSER_NOTE +
		"List all links on a rendered page (JavaScript executed). Cheaper than fetching full page " +
		"content when you only need navigation targets.",
	inputSchema: {
		url: z.string().url(),
		visible_only: z.boolean().default(false).describe("Only links visible on the page"),
		exclude_external: z.boolean().default(false).describe("Drop links to other domains"),
	},
	annotations: { title: "Get page links", readOnlyHint: true, openWorldHint: true },
	handler: async (args, { env }) => {
		const response = await runQuickAction(env, "links", {
			url: args.url,
			visibleLinksOnly: args.visible_only,
			excludeExternalLinks: args.exclude_external,
		});
		const body = (await response.json()) as { success: boolean; result: string[] };
		return jsonResult(body.result);
	},
});

// ---------------------------------------------------------------------------
// Interactive sessions (stateful — sessionId is the handle; tools reconnect per call)
// ---------------------------------------------------------------------------

const sessionStartTool = defineTool({
	name: "browser_session_start",
	description:
		LOCAL_BROWSER_NOTE +
		"Start a persistent browser session for multi-step automation (login flows, form fills, " +
		"clicking through UIs). Returns a sessionId — pass it to every browser_navigate / _click / " +
		"_type / _read_page / etc. call. The session closes after keep_alive_ms of inactivity; if a " +
		"later call reports the session not found, start a new one. Tools operate on the most " +
		"recently opened tab. Close with browser_session_close when done to free a browser slot.",
	inputSchema: {
		url: z.string().url().optional().describe("Navigate to this URL immediately"),
		keep_alive_ms: z
			.number()
			.int()
			.min(10_000)
			.max(KEEP_ALIVE_MAX_MS)
			.default(KEEP_ALIVE_DEFAULT_MS)
			.describe("Idle window before the session auto-closes (max 600000 = 10 min)"),
		viewport_width: z.number().int().min(320).max(1920).default(1280),
		viewport_height: z.number().int().min(320).max(1920).default(800),
	},
	annotations: {
		title: "Start browser session",
		readOnlyHint: false,
		destructiveHint: false,
		openWorldHint: true,
	},
	handler: async (args, { env }) => {
		const browser = await sessionDeps.launch(env.BROWSER, { keep_alive: args.keep_alive_ms });
		try {
			const sessionId = browser.sessionId();
			const pages = await browser.pages();
			const page = pages[pages.length - 1] ?? (await browser.newPage());
			await page.setViewport({ width: args.viewport_width, height: args.viewport_height });
			if (args.url) {
				await page.goto(args.url, { waitUntil: "domcontentloaded" });
			}
			return jsonResult({
				sessionId,
				keep_alive_ms: args.keep_alive_ms,
				current_url: args.url ? page.url() : null,
				note: "Pass sessionId to the other browser_* session tools; the session dies after the idle window.",
			});
		} finally {
			browser.disconnect();
		}
	},
});

const sessionCloseTool = defineTool({
	name: "browser_session_close",
	description:
		"Close a browser session and release its browser slot. Safe to call on an already-closed " +
		"session (treated as success).",
	inputSchema: { sessionId: SESSION_ID },
	annotations: {
		title: "Close browser session",
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	handler: async (args, { env }) => {
		let browser: Awaited<ReturnType<typeof sessionDeps.connect>>;
		try {
			browser = await sessionDeps.connect(env.BROWSER, args.sessionId);
		} catch {
			return textResult(`Session "${args.sessionId}" is already closed or expired.`);
		}
		await browser.close();
		return textResult(`Session "${args.sessionId}" closed.`);
	},
});

const sessionListTool = defineTool({
	name: "browser_session_list",
	description:
		"List active Browser Run sessions and account concurrency limits. Use to find reusable " +
		"sessions or to see why a new session can't be acquired.",
	inputSchema: {},
	annotations: { title: "List browser sessions", readOnlyHint: true, openWorldHint: true },
	handler: async (_args, { env }) => {
		const [sessions, limits] = await Promise.all([
			sessionDeps.sessions(env.BROWSER),
			sessionDeps.limits(env.BROWSER),
		]);
		return jsonResult({ sessions, limits });
	},
});

const navigateTool = defineTool({
	name: "browser_navigate",
	description:
		"Navigate the session's page to a URL. Returns the final URL, HTTP status, and title.",
	inputSchema: {
		sessionId: SESSION_ID,
		url: z.string().url(),
		wait_until: WAIT_UNTIL.default("domcontentloaded"),
	},
	annotations: {
		title: "Navigate",
		readOnlyHint: false,
		destructiveHint: false,
		openWorldHint: true,
	},
	handler: async (args, { env }) =>
		withSession(env, args.sessionId, async (page) => {
			const response = await page.goto(args.url, { waitUntil: args.wait_until });
			return jsonResult({
				url: page.url(),
				status: response?.status() ?? null,
				title: await page.title(),
			});
		}),
});

const clickTool = defineTool({
	name: "browser_click",
	description:
		"Click an element by CSS selector in the session's page. Clicking can trigger real site " +
		"actions (form submits, purchases) — be sure the element is the intended one; inspect first " +
		"with browser_read_page. Set wait_for_navigation when the click loads a new page.",
	inputSchema: {
		sessionId: SESSION_ID,
		selector: z.string(),
		wait_for_navigation: z
			.boolean()
			.default(false)
			.describe("Wait for a page navigation triggered by the click"),
	},
	annotations: {
		title: "Click element",
		readOnlyHint: false,
		destructiveHint: true,
		openWorldHint: true,
	},
	handler: async (args, { env }) =>
		withSession(env, args.sessionId, async (page) => {
			await requireSelector(page, args.selector, { timeout: 10_000, visible: true });
			if (args.wait_for_navigation) {
				await Promise.all([
					page.waitForNavigation({ waitUntil: "domcontentloaded" }),
					page.click(args.selector),
				]);
			} else {
				await page.click(args.selector);
			}
			return jsonResult({ clicked: args.selector, url: page.url(), title: await page.title() });
		}),
});

const typeTool = defineTool({
	name: "browser_type",
	description:
		"Type text into an input/textarea in the session's page. Clears the existing value first by " +
		"default. Set press_enter to submit after typing (e.g. search boxes).",
	inputSchema: {
		sessionId: SESSION_ID,
		selector: z.string(),
		text: z.string(),
		clear_first: z.boolean().default(true),
		press_enter: z.boolean().default(false),
	},
	annotations: {
		title: "Type text",
		readOnlyHint: false,
		destructiveHint: true,
		openWorldHint: true,
	},
	handler: async (args, { env }) =>
		withSession(env, args.sessionId, async (page) => {
			await requireSelector(page, args.selector, { timeout: 10_000, visible: true });
			if (args.clear_first) {
				await page.click(args.selector, { clickCount: 3 });
				await page.keyboard.press("Backspace");
			}
			await page.type(args.selector, args.text);
			if (args.press_enter) {
				await page.keyboard.press("Enter");
			}
			return jsonResult({ typed_into: args.selector, url: page.url() });
		}),
});

const selectTool = defineTool({
	name: "browser_select",
	description:
		"Choose option(s) in a <select> element by value. Returns the values actually selected " +
		"(empty array = no option matched).",
	inputSchema: {
		sessionId: SESSION_ID,
		selector: z.string(),
		values: z.array(z.string()).min(1).describe("Option value attributes, not display labels"),
	},
	annotations: {
		title: "Select option",
		readOnlyHint: false,
		destructiveHint: false,
		openWorldHint: true,
	},
	handler: async (args, { env }) =>
		withSession(env, args.sessionId, async (page) => {
			await requireSelector(page, args.selector, { timeout: 10_000 });
			const selected = await page.select(args.selector, ...args.values);
			return jsonResult({ selector: args.selector, selected });
		}),
});

const readPageTool = defineTool({
	name: "browser_read_page",
	description:
		"Read the session's current page. format 'text' (default) returns visible text — best for " +
		"reading content. format 'a11y' returns the accessibility tree (roles + names) — best for " +
		"discovering what can be clicked or typed into and building selectors.",
	inputSchema: {
		sessionId: SESSION_ID,
		format: z.enum(["text", "a11y"]).default("text"),
		max_length: MAX_LENGTH,
	},
	annotations: { title: "Read page", readOnlyHint: true, openWorldHint: true },
	handler: async (args, { env }) =>
		withSession(env, args.sessionId, async (page) => {
			const content =
				args.format === "text"
					? // String expression: the worker has no DOM lib, so a `document` closure won't typecheck
						((await page.evaluate("document.body.innerText")) as string)
					: JSON.stringify(await page.accessibility.snapshot(), null, 2);
			return textResult(truncateText(content ?? "", args.max_length));
		}),
});

const screenshotSessionTool = defineTool({
	name: "browser_screenshot_session",
	description:
		"Screenshot the session's current page as an inline image (JPEG by default). full_page on " +
		"long pages can exceed the inline size limit — prefer selector for one element.",
	inputSchema: {
		sessionId: SESSION_ID,
		full_page: z.boolean().default(false),
		selector: z
			.string()
			.optional()
			.describe("Screenshot only the first element matching this CSS selector"),
		format: SCREENSHOT_FORMAT,
	},
	annotations: { title: "Screenshot session", readOnlyHint: true, openWorldHint: true },
	handler: async (args, { env }) =>
		withSession(env, args.sessionId, async (page) => {
			const { base64, mimeType } = await takeSessionScreenshot(page, args);
			return imageResult(guardImageSize(base64), mimeType);
		}),
});

const evaluateTool = defineTool({
	name: "browser_evaluate",
	description:
		"Run a JavaScript expression in the session's page and return its JSON-serialized result. " +
		"The result must be JSON-serializable (no DOM nodes/functions). Scripts can mutate the page.",
	inputSchema: {
		sessionId: SESSION_ID,
		expression: z.string().describe("e.g. \"document.querySelectorAll('.item').length\""),
	},
	annotations: {
		title: "Evaluate JS",
		readOnlyHint: false,
		destructiveHint: true,
		openWorldHint: true,
	},
	handler: async (args, { env }) =>
		withSession(env, args.sessionId, async (page) => {
			let result: unknown;
			try {
				result = await page.evaluate(args.expression);
			} catch (err) {
				throw new Error(`Page script threw: ${err instanceof Error ? err.message : String(err)}`);
			}
			return jsonResult(result === undefined ? null : result);
		}),
});

const waitForTool = defineTool({
	name: "browser_wait_for",
	description:
		"Wait for a CSS selector to become visible/hidden, or wait a fixed delay. Use after clicks " +
		"that trigger async UI updates. Provide exactly one of selector or delay_ms.",
	inputSchema: {
		sessionId: SESSION_ID,
		selector: z.string().optional(),
		state: z.enum(["visible", "hidden"]).default("visible"),
		timeout_ms: z.number().int().min(100).max(60_000).default(15_000),
		delay_ms: z
			.number()
			.int()
			.min(100)
			.max(30_000)
			.optional()
			.describe("Fixed wait instead of a selector"),
	},
	annotations: { title: "Wait for", readOnlyHint: true, openWorldHint: true },
	handler: async (args, { env }) => {
		if ((args.selector === undefined) === (args.delay_ms === undefined)) {
			throw new Error("Provide exactly one of selector or delay_ms");
		}
		return withSession(env, args.sessionId, async (page) => {
			if (args.delay_ms !== undefined) {
				await new Promise((resolve) => setTimeout(resolve, args.delay_ms));
				return textResult(`Waited ${args.delay_ms}ms.`);
			}
			const selector = args.selector as string;
			await requireSelector(page, selector, {
				timeout: args.timeout_ms,
				visible: args.state === "visible",
				hidden: args.state === "hidden",
			});
			return textResult(`Selector "${selector}" is now ${args.state}.`);
		});
	},
});

export const browserService: ServiceModule = {
	name: "browser",
	tools: [
		fetchRenderedTool,
		screenshotTool,
		scrapeTool,
		getLinksTool,
		sessionStartTool,
		sessionCloseTool,
		sessionListTool,
		navigateTool,
		clickTool,
		typeTool,
		selectTool,
		readPageTool,
		screenshotSessionTool,
		evaluateTool,
		waitForTool,
	],
};

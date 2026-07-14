import puppeteer, {
	type ActiveSession,
	type Browser,
	type BrowserWorker,
	type LimitsResponse,
	type Page,
	type WorkersLaunchOptions,
} from "@cloudflare/puppeteer";

export const KEEP_ALIVE_MAX_MS = 600_000;
export const KEEP_ALIVE_DEFAULT_MS = 300_000;

/**
 * Injection seam: tests replace these instead of module-mocking @cloudflare/puppeteer,
 * which is unreliable under vitest-pool-workers.
 */
export const sessionDeps = {
	launch: (binding: BrowserWorker, options?: WorkersLaunchOptions): Promise<Browser> =>
		puppeteer.launch(binding, options),
	connect: (binding: BrowserWorker, sessionId: string): Promise<Browser> =>
		puppeteer.connect(binding, sessionId),
	sessions: (binding: BrowserWorker): Promise<ActiveSession[]> => puppeteer.sessions(binding),
	limits: (binding: BrowserWorker): Promise<LimitsResponse> => puppeteer.limits(binding),
};

/**
 * Connect to an existing Browser Run session, run `fn` against its most recently
 * opened page, then disconnect — never close — so the session outlives the call.
 */
export async function withSession<T>(
	env: Env,
	sessionId: string,
	fn: (page: Page, browser: Browser) => Promise<T>,
): Promise<T> {
	let browser: Browser;
	try {
		browser = await sessionDeps.connect(env.BROWSER, sessionId);
	} catch (err) {
		throw new Error(
			`Browser session "${sessionId}" not found or expired (sessions close after their keep_alive ` +
				`idle window). Start a new one with browser_session_start. ` +
				`(${err instanceof Error ? err.message : String(err)})`,
		);
	}
	try {
		const pages = await browser.pages();
		const page = pages[pages.length - 1] ?? (await browser.newPage());
		return await fn(page, browser);
	} finally {
		browser.disconnect();
	}
}

/** waitForSelector with an error message that tells Claude how to recover. */
export async function requireSelector(
	page: Page,
	selector: string,
	options: { timeout: number; visible?: boolean; hidden?: boolean },
): Promise<void> {
	try {
		await page.waitForSelector(selector, options);
	} catch {
		throw new Error(
			`No element matched selector "${selector}" within ${options.timeout}ms — ` +
				'call browser_read_page (format:"a11y") to inspect the elements on the page.',
		);
	}
}

export interface SessionScreenshotArgs {
	full_page: boolean;
	selector?: string;
	format: "jpeg" | "png";
}

/** Take a base64 screenshot of the page (or one element), with jpeg-by-default sizing. */
export async function takeSessionScreenshot(
	page: Page,
	args: SessionScreenshotArgs,
): Promise<{ base64: string; mimeType: string }> {
	if (args.selector && args.full_page) {
		throw new Error("selector and full_page are mutually exclusive");
	}
	const options = {
		encoding: "base64" as const,
		type: args.format,
		...(args.format === "jpeg" ? { quality: 80 } : {}),
	};
	let base64: string;
	if (args.selector) {
		await requireSelector(page, args.selector, { timeout: 10_000 });
		const element = await page.$(args.selector);
		if (!element) {
			throw new Error(`No element matched selector "${args.selector}"`);
		}
		base64 = (await element.screenshot(options)) as string;
	} else {
		base64 = (await page.screenshot({ ...options, fullPage: args.full_page })) as string;
	}
	return { base64, mimeType: `image/${args.format}` };
}

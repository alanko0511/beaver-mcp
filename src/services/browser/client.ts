import { UpstreamApiError } from "../types";

export type QuickAction = "screenshot" | "content" | "markdown" | "scrape" | "links";

/**
 * Run a Browser Run quick action via the binding and normalize failures.
 * The binding types each action's options via overloads; callers build the
 * options object per action, so we erase to `never` at the call site.
 */
export async function runQuickAction(
	env: Env,
	action: QuickAction,
	options: Record<string, unknown>,
): Promise<Response> {
	const response = await env.BROWSER.quickAction(action as never, options as never);
	if (!response.ok) {
		let detail = "";
		try {
			const body = (await response.json()) as {
				errors?: Array<{ message?: string; detail?: string }>;
			};
			detail = (body.errors ?? [])
				.map((e) => [e.message, e.detail].filter(Boolean).join(": "))
				.join("; ");
		} catch {
			detail = (await response.text().catch(() => "")).slice(0, 300);
		}
		if (response.status === 429) {
			detail = `concurrency/rate limit hit — ${detail}`;
		}
		throw new UpstreamApiError("Browser Run", response.status, detail || response.statusText);
	}
	return response;
}

/** Args shared by all quick-action tools that load a page. */
export interface PageLoadArgs {
	url: string;
	wait_until?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
	wait_for_selector?: string;
}

/** Map shared tool args onto Browser Run quick-action options. */
export function pageLoadOptions(args: PageLoadArgs): Record<string, unknown> {
	const options: Record<string, unknown> = { url: args.url };
	if (args.wait_until) {
		options.gotoOptions = { waitUntil: args.wait_until };
	}
	if (args.wait_for_selector) {
		options.waitForSelector = { selector: args.wait_for_selector };
	}
	return options;
}

/**
 * Keep inline images comfortably under MCP client message limits.
 * ~1.4M base64 chars ≈ 1 MB of binary image data.
 */
const MAX_IMAGE_BASE64_CHARS = 1_400_000;

/** Strip a `data:image/...;base64,` prefix if present (quick-action base64 responses use one). */
export function stripDataUriPrefix(data: string): string {
	return data.replace(/^data:[^;,]+;base64,/, "");
}

/** Throw with remediation guidance when a screenshot is too large to inline. */
export function guardImageSize(base64: string): string {
	if (base64.length > MAX_IMAGE_BASE64_CHARS) {
		throw new Error(
			`Screenshot too large (~${Math.round(base64.length / 1365)} KB). ` +
				'Retry with format:"jpeg", full_page:false, a narrower selector, or a smaller viewport.',
		);
	}
	return base64;
}

/** Truncate long page text, appending a notice so Claude knows content was cut. */
export function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength)}\n\n[Output truncated at ${maxLength} characters — full content is ${text.length} characters. Raise max_length or narrow the request to see more.]`;
}

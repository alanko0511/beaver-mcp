import { vi } from "vitest";

export interface CapturedRequest {
	url: URL;
	method: string;
	headers: Headers;
	body: unknown;
}

/**
 * Stub global fetch for one test. Returns the capture list; each call to the
 * stub consumes the next queued response. Restore happens via vi.unstubAllGlobals()
 * in afterEach.
 */
export function stubFetch(...responses: Response[]): CapturedRequest[] {
	const captured: CapturedRequest[] = [];
	const queue = [...responses];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			let body: unknown;
			const text = await request.text();
			if (text) {
				try {
					body = JSON.parse(text);
				} catch {
					body = text;
				}
			}
			captured.push({
				url: new URL(request.url),
				method: request.method,
				headers: request.headers,
				body,
			});
			const response = queue.shift();
			if (!response) throw new Error(`Unexpected fetch call: ${request.method} ${request.url}`);
			return response;
		}),
	);
	return captured;
}

export function jsonResponse(
	status: number,
	body: unknown,
	headers?: Record<string, string>,
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

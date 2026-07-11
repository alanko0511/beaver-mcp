import { afterEach, describe, expect, it, vi } from "vitest";
import { LunchMoneyClient } from "../src/services/lunchmoney/client";
import { jsonResponse, stubFetch } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

describe("LunchMoneyClient", () => {
	it("sends bearer auth and query params on list; drops undefined params", async () => {
		const captured = stubFetch(
			jsonResponse(200, { transactions: [{ id: 1, amount: "5.0000" }], has_more: false }),
		);

		const client = new LunchMoneyClient("tok-123");
		const result = await client.listTransactions({
			start_date: "2026-07-01",
			end_date: "2026-07-11",
			limit: 50,
			category_id: undefined,
		});

		const request = captured[0];
		expect(request.url.origin + request.url.pathname).toBe(
			"https://api.lunchmoney.dev/v2/transactions",
		);
		expect(request.headers.get("Authorization")).toBe("Bearer tok-123");
		expect(request.url.searchParams.get("start_date")).toBe("2026-07-01");
		expect(request.url.searchParams.get("limit")).toBe("50");
		expect(request.url.searchParams.has("category_id")).toBe(false);
		expect(result.transactions).toHaveLength(1);
	});

	it("passes include_metadata through when set", async () => {
		const captured = stubFetch(jsonResponse(200, { transactions: [], has_more: false }));
		const client = new LunchMoneyClient("tok");
		await client.listTransactions({ include_metadata: true, limit: 10 });
		expect(captured[0].url.searchParams.get("include_metadata")).toBe("true");
	});

	it("PUTs update fields to /v2/transactions/:id", async () => {
		const captured = stubFetch(jsonResponse(201, { id: 987, status: "reviewed" }));

		const client = new LunchMoneyClient("tok");
		await client.updateTransaction(987, {
			category_id: 12345,
			status: "reviewed",
			additional_tag_ids: [678],
		});

		expect(captured[0].method).toBe("PUT");
		expect(captured[0].url.pathname).toBe("/v2/transactions/987");
		expect(captured[0].body).toEqual({
			category_id: 12345,
			status: "reviewed",
			additional_tag_ids: [678],
		});
	});

	it("normalizes the v2 error shape", async () => {
		stubFetch(
			jsonResponse(400, {
				message: "Validation failed",
				errors: [{ errMsg: "must be integer", instancePath: "/query/category_id" }],
			}),
		);

		const client = new LunchMoneyClient("tok");
		await expect(client.getTransaction(1)).rejects.toThrow(
			/HTTP 400.*Validation failed.*category_id must be integer/s,
		);
	});

	it("surfaces 429 with Retry-After", async () => {
		stubFetch(new Response("slow down", { status: 429, headers: { "Retry-After": "30" } }));

		const client = new LunchMoneyClient("tok");
		await expect(client.listTags()).rejects.toThrow(/429.*retry after 30s/s);
	});

	it("supports a custom base URL (mock server)", async () => {
		const captured = stubFetch(jsonResponse(200, { tags: [] }));
		const client = new LunchMoneyClient("tok", "https://mock.lunchmoney.dev/v2");
		await client.listTags();
		expect(captured[0].url.href).toBe("https://mock.lunchmoney.dev/v2/tags");
	});
});

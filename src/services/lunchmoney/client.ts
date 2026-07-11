import { UpstreamApiError } from "../types";

/**
 * Lunch Money v2 API client (alpha — https://alpha.lunchmoney.dev).
 * Thin fetch wrapper: bearer auth, query building, error normalization.
 *
 * v2 conventions worth remembering:
 * - amounts are STRINGS with 4 decimal places ("5.0000"); positive = expense, negative = income
 * - currency is lowercase ISO 4217 ("usd")
 * - relations are IDs (tag_ids, category_id, manual_account_id), not hydrated objects
 * - rate limit: 100 req/min per IP, 429 + Retry-After on exceed
 */

const DEFAULT_BASE_URL = "https://api.lunchmoney.dev/v2";

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface LunchMoneyTransactionUpdate {
	date?: string;
	amount?: string | number;
	currency?: string;
	payee?: string;
	category_id?: number | null;
	notes?: string;
	status?: "reviewed" | "unreviewed";
	tag_ids?: number[];
	additional_tag_ids?: number[];
	manual_account_id?: number | null;
	plaid_account_id?: number | null;
	external_id?: string;
	recurring_id?: number | null;
}

export interface LunchMoneyTransactionCreate {
	date: string;
	amount: string | number;
	payee?: string;
	currency?: string;
	category_id?: number;
	notes?: string;
	status?: "reviewed" | "unreviewed";
	tag_ids?: number[];
	manual_account_id?: number;
	external_id?: string;
}

export class LunchMoneyClient {
	constructor(
		private readonly token: string,
		private readonly baseUrl: string = DEFAULT_BASE_URL,
	) {}

	private async request<T>(
		method: string,
		path: string,
		options: { query?: QueryParams; body?: unknown } = {},
	): Promise<T> {
		const url = new URL(this.baseUrl + path);
		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}

		const response = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});

		if (response.status === 429) {
			const retryAfter = response.headers.get("Retry-After");
			throw new UpstreamApiError(
				"Lunch Money",
				429,
				`rate limited${retryAfter ? `, retry after ${retryAfter}s` : ""}`,
			);
		}
		if (!response.ok) {
			let detail: string;
			try {
				const data = (await response.json()) as {
					message?: string;
					errors?: Array<{ errMsg?: string; instancePath?: string }>;
				};
				detail = [
					data.message,
					...(data.errors ?? []).map((e) => `${e.instancePath ?? ""} ${e.errMsg ?? ""}`.trim()),
				]
					.filter(Boolean)
					.join("; ");
			} catch {
				detail = (await response.text().catch(() => "")).slice(0, 300);
			}
			throw new UpstreamApiError("Lunch Money", response.status, detail || response.statusText);
		}
		if (response.status === 204) return undefined as T;
		return (await response.json()) as T;
	}

	listTransactions(query: QueryParams): Promise<{ transactions: unknown[]; has_more?: boolean }> {
		return this.request("GET", "/transactions", { query });
	}

	getTransaction(id: number): Promise<unknown> {
		return this.request("GET", `/transactions/${id}`);
	}

	updateTransaction(id: number, fields: LunchMoneyTransactionUpdate): Promise<unknown> {
		return this.request("PUT", `/transactions/${id}`, { body: fields });
	}

	createTransactions(
		transactions: LunchMoneyTransactionCreate[],
		options: { apply_rules?: boolean; skip_duplicates?: boolean } = {},
	): Promise<unknown> {
		return this.request("POST", "/transactions", { body: { transactions, ...options } });
	}

	listCategories(): Promise<{ categories: unknown[] }> {
		return this.request("GET", "/categories", { query: { format: "flattened" } });
	}

	listTags(): Promise<{ tags: unknown[] }> {
		return this.request("GET", "/tags");
	}

	listManualAccounts(): Promise<{ manual_accounts: unknown[] }> {
		return this.request("GET", "/manual_accounts");
	}

	listPlaidAccounts(): Promise<{ plaid_accounts: unknown[] }> {
		return this.request("GET", "/plaid_accounts");
	}
}

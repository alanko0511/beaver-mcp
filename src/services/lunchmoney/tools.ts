import { z } from "zod";
import { defineTool, jsonResult, type ServiceModule } from "../types";
import { LunchMoneyClient } from "./client";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

function client(env: Env): LunchMoneyClient {
	return new LunchMoneyClient(env.LUNCHMONEY_TOKEN);
}

const listTransactionsTool = defineTool({
	name: "lunchmoney_list_transactions",
	description:
		"List Lunch Money transactions with optional filters. Amounts are strings (positive = expense, " +
		"negative = income); relations are IDs — resolve names via lunchmoney_list_categories / _tags / _accounts. " +
		"Pending transactions are excluded unless include_pending is set.",
	inputSchema: {
		start_date: DATE.optional().describe("Inclusive start date (requires end_date)"),
		end_date: DATE.optional().describe("Inclusive end date (requires start_date)"),
		category_id: z.number().int().optional().describe("Filter by category; 0 = uncategorized"),
		tag_id: z.number().int().optional(),
		status: z.enum(["reviewed", "unreviewed", "delete_pending"]).optional(),
		is_pending: z.boolean().optional(),
		include_pending: z.boolean().optional(),
		updated_since: z
			.string()
			.optional()
			.describe("ISO 8601 — only transactions updated after this"),
		limit: z.number().int().min(1).max(500).default(50),
		offset: z.number().int().min(0).optional(),
	},
	annotations: { title: "List transactions", readOnlyHint: true },
	handler: async (args, { env }) => {
		if ((args.start_date === undefined) !== (args.end_date === undefined)) {
			throw new Error("start_date and end_date must be provided together");
		}
		return jsonResult(await client(env).listTransactions(args));
	},
});

const getTransactionTool = defineTool({
	name: "lunchmoney_get_transaction",
	description: "Get a single Lunch Money transaction by ID (includes split/group children if any).",
	inputSchema: { id: z.number().int() },
	annotations: { title: "Get transaction", readOnlyHint: true },
	handler: async (args, { env }) => jsonResult(await client(env).getTransaction(args.id)),
});

const updateTransactionTool = defineTool({
	name: "lunchmoney_update_transaction",
	description:
		"Update a Lunch Money transaction. tag_ids REPLACES the whole tag list; additional_tag_ids appends " +
		"(the two are mutually exclusive). category_id null clears the category; notes '' clears notes. " +
		"Split or grouped transactions cannot be updated this way.",
	inputSchema: {
		id: z.number().int(),
		date: DATE.optional(),
		amount: z
			.union([z.string(), z.number()])
			.optional()
			.describe("Positive = expense, negative = income"),
		currency: z.string().length(3).optional().describe("Lowercase ISO 4217, e.g. 'usd'"),
		payee: z.string().optional(),
		category_id: z.number().int().nullable().optional().describe("null clears the category"),
		notes: z.string().optional().describe("Empty string clears notes"),
		status: z.enum(["reviewed", "unreviewed"]).optional(),
		tag_ids: z.array(z.number().int()).optional().describe("Replaces ALL tags"),
		additional_tag_ids: z.array(z.number().int()).optional().describe("Appends tags"),
	},
	annotations: {
		title: "Update transaction",
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
	},
	handler: async (args, { env }) => {
		const { id, ...fields } = args;
		if (fields.tag_ids && fields.additional_tag_ids) {
			throw new Error("tag_ids and additional_tag_ids are mutually exclusive");
		}
		return jsonResult(await client(env).updateTransaction(id, fields));
	},
});

const createTransactionTool = defineTool({
	name: "lunchmoney_create_transaction",
	description:
		"Create a manual Lunch Money transaction. Amount: positive = expense, negative = income.",
	inputSchema: {
		date: DATE,
		amount: z.union([z.string(), z.number()]),
		payee: z.string().optional(),
		currency: z
			.string()
			.length(3)
			.optional()
			.describe("Lowercase ISO 4217; defaults to account/primary currency"),
		category_id: z.number().int().optional(),
		notes: z.string().optional(),
		status: z.enum(["reviewed", "unreviewed"]).optional(),
		tag_ids: z.array(z.number().int()).optional(),
		manual_account_id: z.number().int().optional(),
		apply_rules: z
			.boolean()
			.default(false)
			.describe("Run Lunch Money rules on the new transaction"),
	},
	annotations: { title: "Create transaction", readOnlyHint: false, destructiveHint: false },
	handler: async (args, { env }) => {
		const { apply_rules, ...txn } = args;
		return jsonResult(await client(env).createTransactions([txn], { apply_rules }));
	},
});

const listCategoriesTool = defineTool({
	name: "lunchmoney_list_categories",
	description: "List Lunch Money categories (flattened) — use to resolve category_id for updates.",
	inputSchema: {},
	annotations: { title: "List categories", readOnlyHint: true },
	handler: async (_args, { env }) => jsonResult(await client(env).listCategories()),
});

const listTagsTool = defineTool({
	name: "lunchmoney_list_tags",
	description: "List Lunch Money tags — use to resolve tag_ids for updates.",
	inputSchema: {},
	annotations: { title: "List tags", readOnlyHint: true },
	handler: async (_args, { env }) => jsonResult(await client(env).listTags()),
});

const listAccountsTool = defineTool({
	name: "lunchmoney_list_accounts",
	description:
		"List Lunch Money accounts: manually-managed accounts and Plaid-synced accounts. " +
		"Transactions reference these via manual_account_id / plaid_account_id.",
	inputSchema: {},
	annotations: { title: "List accounts", readOnlyHint: true },
	handler: async (_args, { env }) => {
		const lm = client(env);
		const [manual, plaid] = await Promise.all([lm.listManualAccounts(), lm.listPlaidAccounts()]);
		return jsonResult({ ...manual, ...plaid });
	},
});

export const lunchmoneyService: ServiceModule = {
	name: "lunchmoney",
	tools: [
		listTransactionsTool,
		getTransactionTool,
		updateTransactionTool,
		createTransactionTool,
		listCategoriesTool,
		listTagsTool,
		listAccountsTool,
	],
};

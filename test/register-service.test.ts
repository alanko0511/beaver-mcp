import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, registerService, type ServiceModule, textResult } from "../src/services/types";

const fakeEnv = { LUNCHMONEY_TOKEN: "fake-secret-123" } as Env;

async function connect(service: ServiceModule) {
	const server = new McpServer({ name: "test", version: "0.0.0" });
	registerService(server, fakeEnv, service);
	const client = new Client({ name: "test-client", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

const plainTool = defineTool({
	name: "echo",
	description: "Echo the input",
	inputSchema: { text: z.string() },
	annotations: { title: "Echo", readOnlyHint: true },
	handler: async (args) => textResult(args.text),
});

const failingTool = defineTool({
	name: "boom",
	description: "Always throws",
	inputSchema: {},
	handler: async () => {
		throw new Error("kaboom");
	},
});

const widgetTool = defineTool({
	name: "show_widget",
	description: "Widget-backed tool",
	inputSchema: {},
	widget: { resourceUri: "ui://test/widget.html" },
	handler: async () => textResult("{}"),
});

const service: ServiceModule = {
	name: "test-service",
	tools: [plainTool, failingTool, widgetTool],
	resources: [
		{
			name: "Test Widget",
			uri: "ui://test/widget.html",
			html: (env) => `<html>key=${env.LUNCHMONEY_TOKEN}</html>`,
			csp: {
				connectDomains: ["https://api.example.com"],
				resourceDomains: ["https://cdn.example.com"],
			},
		},
	],
};

describe("registerService", () => {
	it("registers plain and widget tools; widget tool carries _meta.ui.resourceUri", async () => {
		const client = await connect(service);
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual(["boom", "echo", "show_widget"]);

		const widget = tools.find((t) => t.name === "show_widget");
		expect(widget?._meta?.ui).toMatchObject({ resourceUri: "ui://test/widget.html" });

		const echo = tools.find((t) => t.name === "echo");
		expect(echo?.annotations?.readOnlyHint).toBe(true);
		expect(echo?._meta?.ui).toBeUndefined();
	});

	it("calls handlers with env context and normalizes thrown errors", async () => {
		const client = await connect(service);

		const ok = await client.callTool({ name: "echo", arguments: { text: "hi" } });
		expect(ok.content).toEqual([{ type: "text", text: "hi" }]);

		const failed = await client.callTool({ name: "boom", arguments: {} });
		expect(failed.isError).toBe(true);
		expect(failed.content).toEqual([{ type: "text", text: "Error: kaboom" }]);
	});

	it("serves widget resources with the MCP Apps mime type, env-injected HTML, and CSP meta", async () => {
		const client = await connect(service);

		const { resources } = await client.listResources();
		expect(resources.map((r) => r.uri)).toContain("ui://test/widget.html");

		const result = await client.readResource({ uri: "ui://test/widget.html" });
		const content = result.contents[0];
		expect(content.mimeType).toBe("text/html;profile=mcp-app");
		if (!("text" in content)) throw new Error("expected text resource content");
		expect(content.text).toContain("key=fake-secret-123");
		expect(result._meta?.ui).toMatchObject({
			csp: {
				connectDomains: ["https://api.example.com"],
				resourceDomains: ["https://cdn.example.com"],
			},
		});
	});
});

import {
	RESOURCE_MIME_TYPE,
	registerAppResource,
	registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

export interface ToolContext {
	env: Env;
}

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
	name: string;
	description: string;
	inputSchema: Shape;
	annotations?: ToolAnnotations;
	/** Present → tool renders an MCP Apps widget (registerAppTool). */
	widget?: { resourceUri: string };
	handler: (args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<CallToolResult>;
}

/** Identity helper that preserves input-schema type inference in the handler. */
export function defineTool<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): ToolDef {
	return def as unknown as ToolDef;
}

export interface WidgetResource {
	/** Human-readable name shown by hosts. */
	name: string;
	/** Must match the `widget.resourceUri` of the tool that uses it. */
	uri: string;
	description?: string;
	/** Widget HTML, or a factory when the HTML needs env values injected (e.g. a browser API key). */
	html: string | ((env: Env) => string);
	/** External origins the widget iframe may touch. Omitted → block-all (host default). */
	csp?: {
		connectDomains?: string[];
		resourceDomains?: string[];
	};
}

export interface ServiceModule {
	name: string;
	tools: ToolDef[];
	resources?: WidgetResource[];
}

/** Thrown by service clients when an upstream API call fails; surfaced as a tool error. */
export class UpstreamApiError extends Error {
	constructor(
		public readonly service: string,
		public readonly status: number,
		message: string,
	) {
		super(`${service} API error (HTTP ${status}): ${message}`);
		this.name = "UpstreamApiError";
	}
}

export function textResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }] };
}

export function jsonResult(value: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function imageResult(
	base64Data: string,
	mimeType: string,
	caption?: string,
): CallToolResult {
	const content: CallToolResult["content"] = [{ type: "image", data: base64Data, mimeType }];
	if (caption) {
		content.push({ type: "text", text: caption });
	}
	return { content };
}

function errorResult(err: unknown): CallToolResult {
	const message = err instanceof Error ? err.message : String(err);
	return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/**
 * Register every tool (and widget resource) of a service module on the server.
 * Widget-backed tools go through ext-apps' registerAppTool so hosts that support
 * MCP Apps render the widget; other hosts fall back to the handler's text content.
 */
export function registerService(server: McpServer, env: Env, service: ServiceModule): void {
	for (const tool of service.tools) {
		const config = {
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: tool.annotations,
		};
		const handler = async (args: unknown): Promise<CallToolResult> => {
			try {
				return await tool.handler(args as never, { env });
			} catch (err) {
				return errorResult(err);
			}
		};
		if (tool.widget) {
			registerAppTool(
				server,
				tool.name,
				{ ...config, _meta: { ui: { resourceUri: tool.widget.resourceUri } } },
				// biome-ignore lint/suspicious/noExplicitAny: SDK callback generics don't compose with our erased ToolDef shape
				handler as any,
			);
		} else {
			// biome-ignore lint/suspicious/noExplicitAny: same as above
			server.registerTool(tool.name, config, handler as any);
		}
	}

	for (const resource of service.resources ?? []) {
		registerAppResource(
			server,
			resource.name,
			resource.uri,
			{ description: resource.description },
			async () => ({
				contents: [
					{
						uri: resource.uri,
						mimeType: RESOURCE_MIME_TYPE,
						text: typeof resource.html === "function" ? resource.html(env) : resource.html,
					},
				],
				_meta: resource.csp ? { ui: { csp: resource.csp } } : undefined,
			}),
		);
	}
}

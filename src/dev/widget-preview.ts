/**
 * Dev-only widget preview: open http://localhost:8788/widget-preview?widget=map-search
 * with an optional ?payload=<url-encoded JSON> to iterate on widget HTML in a normal
 * browser tab with devtools, instead of the ⌘Q-relaunch cycle in Claude Desktop.
 *
 * A classic <script> (which executes before the widget's deferred module script)
 * installs a fake ExtApps host on globalThis.ExtAppsShim; the widget prefers the
 * shim when present.
 */

const SHIM = `<script>
globalThis.ExtAppsShim = {
	App: class {
		constructor() {}
		ontoolresult; ontoolinput; onhostcontextchanged;
		async connect() {
			const payload = new URLSearchParams(location.search).get("payload");
			if (payload) this.ontoolresult?.({ content: [{ type: "text", text: payload }] });
		}
		getHostContext() {
			return { theme: new URLSearchParams(location.search).get("theme") ?? "light" };
		}
		openLink({ url }) { window.open(url, "_blank"); }
		sendMessage(message) { console.log("where - sendMessage", message); }
		updateModelContext() {}
		callServerTool() { return Promise.resolve({ content: [] }); }
		requestDisplayMode() {}
		downloadFile() {}
	},
};
</script>
`;

export function isLocalhost(url: URL): boolean {
	return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

export function renderWidgetPreview(widgetHtml: string): Response {
	return new Response(SHIM + widgetHtml, {
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

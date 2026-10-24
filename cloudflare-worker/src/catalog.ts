import rawCatalog from "./catalog.json";
export interface CatalogTool { name: string; title?: string; description: string; inputSchema: Record<string, any>; outputSchema?: Record<string, any>; annotations?: Record<string, any>; _meta?: Record<string, any> }
export const catalog = rawCatalog as unknown as { extensionVersion: string; tools: CatalogTool[]; resources: {uri: string; name: string; mimeType: string; text: string; _meta?: Record<string, any>}[] };
import { MCP_SCOPE } from "./auth";

export const WIDGET_URI = "ui://researchtube/cloud-browser-v1.html";
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const securitySchemes = [{ type: "oauth2", scopes: [MCP_SCOPE] }];
const bootstrap = [
  { name: "system_connect_browser", title: "Connect this Chrome chat", description: "Automatically connect this exact ChatGPT tab using the ResearchTube extension widget. Then call system_connection_status for browserBindingId. Requires ChatGPT in Chrome; Codex is unsupported.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { ...annotations, readOnlyHint: false },
    outputSchema: { type: "object", additionalProperties: false, properties: { status: { type: "string", const: "binding" }, pollIntervalMs: { type: "integer", minimum: 1000 }, expiresAt: { type: "number" }, message: { type: "string" } }, required: ["status", "pollIntervalMs", "expiresAt", "message"] },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/outputTemplate": WIDGET_URI } },
  { name: "system_connection_status", title: "Check this chat connection", description: "Check this conversation's verified Chrome connection and obtain browserBindingId for ResearchTube tools. Does not select a device or another browser.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations,
    outputSchema: { type: "object", additionalProperties: false, properties: { connected: { type: "boolean" }, ambiguous: { type: "boolean" }, bindings: { type: "array", items: { type: "object", additionalProperties: false, properties: { bindingId: { type: "string", format: "uuid" }, expiresAt: { type: "number" } }, required: ["bindingId", "expiresAt"] } } }, required: ["connected", "ambiguous", "bindings"] } },
  { name: "system_disconnect_browser", title: "Disconnect this chat", description: "Disconnect this conversation's browser bindings. Reconnect from a single Chrome tab if duplicate bindings were detected.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { ...annotations, readOnlyHint: false },
    outputSchema: { type: "object", additionalProperties: false, properties: { disconnected: { type: "boolean", const: true } }, required: ["disconnected"] } }
];
export const tools = [...bootstrap, ...catalog.tools.map(tool => ({ ...tool,
  description: `${tool.description} Use browserBindingId from system_connection_status.`,
  inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
    browserBindingId: { type: "string", format: "uuid", description: "This chat's verified browser binding from system_connection_status." } },
    required: [...(tool.inputSchema.required || []), "browserBindingId"] }
}))].map(tool => ({ ...tool, securitySchemes, _meta: { ...tool._meta, securitySchemes } }));

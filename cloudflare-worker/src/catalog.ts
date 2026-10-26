import rawCatalog from "./catalog.json";
export interface CatalogTool { name: string; title?: string; description: string; inputSchema: Record<string, any>; outputSchema?: Record<string, any>; annotations?: Record<string, any>; _meta?: Record<string, any> }
export const catalog = rawCatalog as unknown as { extensionVersion: string; tools: CatalogTool[]; resources: {uri: string; name: string; mimeType: string; text: string; _meta?: Record<string, any>}[] };
import { MCP_SCOPE } from "./auth";
import { setupProperties } from "./onboarding";

export const WIDGET_URI = "ui://researchtube/cloud-browser-v2.html";
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const securitySchemes = [{ type: "oauth2", scopes: [MCP_SCOPE] }];
const bootstrap = [
  { name: "system_connect_browser", title: "Connect this Chrome chat", description: "Automatically pair the installed extension and connect this exact ChatGPT tab using the existing ResearchTube browser sign-in. If needed the widget explains missing browser sign-in or different accounts. Then call system_connection_status for browserBindingId. Requires this saved ChatGPT conversation in desktop Chrome.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { ...annotations, readOnlyHint: false },
    outputSchema: { type: "object", additionalProperties: false, properties: { status: { enum: ["binding", "extension_required", "unsupported_client"] }, setupUrl: { type: "string", format: "uri" }, pollIntervalMs: { type: "integer", minimum: 1000 }, expiresAt: { type: "number" }, message: { type: "string" } }, required: ["status", "setupUrl", "pollIntervalMs", "message"] },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/outputTemplate": WIDGET_URI } },
  { name: "system_connection_status", title: "Set up ResearchTube or check this chat", description: "Call first after OAuth or when ResearchTube is not connected. Works before Extension or Agent installation and without browser binding. Returns setup instructions, online extension state and this chat's verified browserBindingId when connected. No server-side YouTube execution or free cloud quota is provided.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations,
    outputSchema: { type: "object", additionalProperties: false, properties: setupProperties, required: Object.keys(setupProperties) } },
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

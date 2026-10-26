import rawCatalog from "./catalog.json";
export interface CatalogTool { name: string; title?: string; description: string; inputSchema: Record<string, any>; outputSchema?: Record<string, any>; annotations?: Record<string, any>; _meta?: Record<string, any> }
export const catalog = rawCatalog as unknown as { extensionVersion: string; tools: CatalogTool[]; resources: {uri: string; name: string; mimeType: string; text: string; _meta?: Record<string, any>}[] };
import { MCP_SCOPE } from "./auth";
import { setupProperties } from "./onboarding";

export const WIDGET_URI = "ui://researchtube/cloud-browser-v3.html";
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const securitySchemes = [{ type: "oauth2", scopes: [MCP_SCOPE] }];
const bootstrap = [
  { name: "system_connect_browser", title: "Connect this Chrome chat", description: "Repair a browser connection only after a requested tool reports BROWSER_BINDING_REQUIRED or BROWSER_DISCONNECTED, or when the user asks to connect. The widget connects this saved ChatGPT conversation to its Chrome extension. After connection, call the originally requested tool directly. Do not poll system_connection_status or call this before productive tools.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { ...annotations, readOnlyHint: false },
    outputSchema: { type: "object", additionalProperties: false, properties: { status: { enum: ["binding", "extension_required", "unsupported_client"] }, setupUrl: { type: "string", format: "uri" }, expiresAt: { type: "number" }, message: { type: "string" } }, required: ["status", "setupUrl", "message"] },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/outputTemplate": WIDGET_URI } },
  { name: "system_connection_status", title: "Diagnose ResearchTube connection", description: "Connection diagnostics and installation help when the user asks. For actual work, call the requested tool directly; it checks and routes this conversation internally. For BROWSER_BINDING_REQUIRED use system_connect_browser directly. Never use status as a startup preflight, readiness check or routine polling loop.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations,
    outputSchema: { type: "object", additionalProperties: false, properties: setupProperties, required: Object.keys(setupProperties) } },
  { name: "system_disconnect_browser", title: "Disconnect this chat", description: "Disconnect this conversation's browser bindings. Reconnect from a single Chrome tab if duplicate bindings were detected.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { ...annotations, readOnlyHint: false },
    outputSchema: { type: "object", additionalProperties: false, properties: { disconnected: { type: "boolean", const: true } }, required: ["disconnected"] } }
];
export const tools = [...bootstrap, ...catalog.tools].map(tool => ({ ...tool, securitySchemes, _meta: { ...tool._meta, securitySchemes } }));

import rawCatalog from "./catalog.json";
export interface CatalogTool { name: string; title?: string; description: string; inputSchema: Record<string, any>; outputSchema?: Record<string, any>; annotations?: Record<string, any>; _meta?: Record<string, any> }
export const catalog = rawCatalog as unknown as { extensionVersion: string; tools: CatalogTool[]; resources: {uri: string; name: string; mimeType: string; text: string; _meta?: Record<string, any>}[] };
import { MCP_SCOPE } from "./auth";
import { setupProperties } from "./onboarding";

const securitySchemes = [{ type: "oauth2", scopes: [MCP_SCOPE] }];
const diagnostic = {
  name: "system_connection_status", title: "Diagnose ResearchTube connection",
  description: "Account and extension connection diagnostics when the user asks. For actual work call the requested tool directly. Never use this as a startup check or polling loop.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: { type: "object", additionalProperties: false, properties: setupProperties, required: Object.keys(setupProperties) }
};
export const tools = [diagnostic, ...catalog.tools].map(tool => ({ ...tool, securitySchemes, _meta: { ...("_meta" in tool ? tool._meta : {}), securitySchemes } }));

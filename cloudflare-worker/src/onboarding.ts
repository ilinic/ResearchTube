import { origin, type Env } from "./types";

export const setupProperties = {
  accountConnected: { type: "boolean", const: true }, extensionConnected: { type: "boolean" },
  connected: { type: "boolean" }, ambiguous: { type: "boolean" }, contextAvailable: { type: "boolean" },
  cloudToolsAvailable: { type: "boolean", const: false }, setupUrl: { type: "string", format: "uri" },
  message: { type: "string" }, pollIntervalMs: { type: "integer", minimum: 2000 },
  bindings: { type: "array", items: { type: "object", additionalProperties: false,
    properties: { bindingId: { type: "string", format: "uuid" }, expiresAt: { type: "number" } }, required: ["bindingId", "expiresAt"] } }
};
export function setupResult(env: Env, contextAvailable: boolean, status: Record<string, any> = {}) {
  const connected = status.connected === true, extensionConnected = status.extensionConnected === true, ambiguous = status.ambiguous === true;
  return { accountConnected: true, extensionConnected, connected, ambiguous, contextAvailable, cloudToolsAvailable: false,
    setupUrl: `${origin(env)}/setup`, pollIntervalMs: 2000,
    bindings: Array.isArray(status.bindings) ? status.bindings : [],
    message: !contextAvailable ? "Your ResearchTube account is connected. Browser tools require a saved ChatGPT conversation in desktop Chrome with ResearchTube Extension. Mobile execution and cloud transcripts are not available."
      : ambiguous ? "Disconnect this chat's conflicting browser bindings, then reconnect from one Chrome tab."
      : connected ? "This chat is connected. Browser tools are ready; local file and media tools additionally require the optional Local Agent."
      : extensionConnected ? "Your extension is online. Call system_connect_browser in this desktop Chrome chat to connect its exact tab."
      : "Your ResearchTube account is connected. Install ResearchTube Extension in desktop Chrome, then call system_connect_browser in this saved chat. Follow the setup instructions at the returned setupUrl." };
}

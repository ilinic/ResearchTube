import { origin, type Env } from "./types";
export const setupProperties = {
  accountConnected: { type: "boolean", const: true }, extensionConnected: { type: "boolean" }, connected: { type: "boolean" },
  cloudToolsAvailable: { type: "boolean", const: false }, setupUrl: { type: "string", format: "uri" }, message: { type: "string" }
};
export function setupResult(env: Env, status: Record<string, any> = {}) {
  const connected = status.extensionConnected === true;
  return { accountConnected: true, extensionConnected: connected, connected, cloudToolsAvailable: false,
    setupUrl: `${origin(env)}/setup`, message: connected
      ? "Your extension is connected. Call the requested tool directly. Local file and media tools also require the optional Local Agent."
      : "Open Chrome with ResearchTube Extension. Install it from the latest ResearchTube release if needed, then sign in to ResearchTube in that Chrome profile." };
}

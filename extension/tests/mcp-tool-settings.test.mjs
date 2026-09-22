import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [background, html, script] = await Promise.all([
  readFile(new URL("../background.js", import.meta.url), "utf8"),
  readFile(new URL("../onboarding.html", import.meta.url), "utf8"),
  readFile(new URL("../onboarding.js", import.meta.url), "utf8")
]);

assert.match(background, /const MCP_TOOL_GROUPS/);
assert.match(background, /custom: \{ title: "Custom"/);
assert.match(background, /system_agent_status: \{ group: "system", alwaysEnabled: true \}/);
assert.match(background, /enabledMcpToolDefinitions/);
assert.match(background, /isMcpToolEnabled/);
assert.match(background, /updateMcpToolEnabled/);
assert.match(background, /updateNewToolsEnabledByDefault/);
assert.match(background, /enabledByName/);
assert.match(background, /name: tool\.name/);
assert.match(background, /tools: await enabledMcpToolDefinitions\(\)/);
assert.match(html, /MCP tool availability/);
assert.match(html, /id="new-tools-enabled"/);
assert.match(html, /ChatGPT Plugins/);
assert.match(html, /Find <strong>ResearchTube<\/strong> and open <strong>Manage<\/strong>/);
assert.match(html, /Click <strong>Refresh<\/strong> to reload the MCP tool schema/);
assert.match(html, /data-open="chatgpt"/);
assert.match(script, /get-mcp-tool-settings/);
assert.match(script, /set-mcp-tool-enabled/);
assert.match(script, /set-mcp-new-tools-default/);
assert.match(script, /ResearchTube → Manage → Refresh/);
console.log("MCP tool settings: ok");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [background, html, script] = await Promise.all([
  readFile(new URL("../background.js", import.meta.url), "utf8"),
  readFile(new URL("../settings.html", import.meta.url), "utf8"),
  readFile(new URL("../settings.js", import.meta.url), "utf8")
]);

assert.match(background, /const MCP_TOOL_GROUPS/);
assert.match(background, /custom: \{ title: "Custom Asynchronous Tasks"/);
assert.match(background, /system_agent_status: \{ group: "system", alwaysEnabled: true \}/);
assert.match(background, /enabledMcpToolDefinitions/);
assert.match(background, /isMcpToolEnabled/);
assert.match(background, /updateMcpToolEnabled/);
assert.doesNotMatch(background, /updateNewToolsEnabledByDefault/);
assert.match(background, /enabledByName/);
assert.match(background, /name: tool\.name/);
assert.match(background, /const tools = await enabledMcpToolDefinitions\(\)/);
assert.match(background, /description: String\(tool\.description \|\| tool\.title \|\| tool\.name\)/, "Settings must keep each tool's complete description");
assert.doesNotMatch(background, /localWorkspaceReadAnnotations/, "all tool annotation constants must be defined");
assert.match(html, /MCP tool availability/);
assert.doesNotMatch(html, /id="new-tools-enabled"/);
assert.match(html, /ChatGPT Plugins/);
assert.doesNotMatch(html, /<h2>Status<\/h2>/, "Settings must not display the obsolete connection-status section");
assert.doesNotMatch(script, /formatStatus\(/, "Settings must not maintain obsolete connection-status rendering");
assert.match(html, /Find <strong>ResearchTube<\/strong> and open <strong>Manage<\/strong>/);
assert.match(html, /Click <strong>Refresh<\/strong> to reload the MCP tool schema/);
assert.match(html, /data-open="chatgpt"/);
assert.match(script, /get-mcp-tool-settings/);
assert.match(script, /set-mcp-tool-enabled/);
assert.doesNotMatch(script, /set-mcp-new-tools-default/);
assert.match(script, /ResearchTube → Manage → Refresh/);
assert.match(script, /tools\.sort\(\(left, right\) => left\.name\.localeCompare\(right\.name\)\)/, "each Settings group must be ordered by MCP command name");
assert.match(script, /tool-heading/, "tool titles and MCP names must share a heading line");
assert.match(script, /heading\.append\(title, name\)/, "the MCP name must follow the bold tool title");
assert.ok(html.indexOf('<h3>Step 4 — Start the Local Agent') < html.indexOf('id="silent-automation-heading"'), "Local Agent setup must precede silent file automation inside the guide");
assert.match(html, /<code id="silent-automation-flag">--silent-debugger-extension-api<\/code><button id="copy-silent-automation-flag" class="copy-inline" type="button">Copy<\/button>/, "the Chrome flag must have a matching inline Copy button");
assert.match(html, /Properties → Shortcut → Target/, "Settings must explain where to add the flag in the Chrome shortcut");
assert.match(script, /navigator\.clipboard\.writeText\(\$\("silent-automation-flag"\)\.textContent\.trim\(\)\)/, "Copy must put only the displayed flag on the clipboard");
console.log("MCP tool settings: ok");

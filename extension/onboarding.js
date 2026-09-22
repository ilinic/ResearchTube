const $ = (id) => document.getElementById(id);
const messages = {
  API_KEY_INVALID: "The OpenAI API key was rejected. Check the key and try again.",
  TUNNEL_PERMISSION_DENIED: "The API key is valid, but it cannot access this tunnel. Use a Restricted key with Tunnels: Read + Use.",
  TUNNEL_NOT_FOUND: "The tunnel could not be found. Check the Tunnel ID and try again.",
  NETWORK_ERROR: "ResearchTube could not reach OpenAI. Check your internet connection and try again.",
  API_KEY_MISSING: "Enter your OpenAI API key.",
  TUNNEL_ID_MISSING: "Enter your Tunnel ID."
};
async function call(message) { return chrome.runtime.sendMessage(message); }
function escapeHtml(value) { const element = document.createElement("span"); element.textContent = value; return element.innerHTML; }
function renderResult(result) { const box = $("test-result"); box.hidden = false; box.className = result.ok ? "ok" : "error"; if (result.ok) box.innerHTML = "<strong>Connection successful.</strong><br>✓ API key accepted<br>✓ Tunnel found<br>✓ ResearchTube can access the tunnel"; else { const message = messages[result.errorCode] || result.message || "Connection test failed."; box.innerHTML = `<strong>${escapeHtml(message)}</strong>${result.detail ? `<details><summary>Technical details</summary>${escapeHtml(result.detail)}</details>` : ""}`; } }
function componentLabel(name) { return name === "ytDlp" ? "yt-dlp" : name; }
function componentDetail(component) {
  const version = component.version ? ` — ${component.version}` : "";
  const resolved = component.source && component.path ? ` (${component.source === "path" ? "PATH" : "local"}: ${component.path})` : "";
  return `${component.status}${version}${resolved}`;
}
function appendTextLine(parent, text) { const line = document.createElement("div"); line.textContent = text; parent.append(line); }
function renderAgentResult(result) {
  const box = $("agent-result");
  box.hidden = false;
  box.replaceChildren();
  box.className = result?.ok ? "ok" : "error";
  const title = document.createElement("strong");
  title.textContent = result?.ok ? `Local Agent connected — version ${result.agentVersion || "unknown"}.` : (result?.message || "ResearchTube Local Agent is unavailable.");
  box.append(title);
  if (!result?.ok) return;
  const details = document.createElement("div");
  details.className = "health-lines";
  const workspace = result.workspace;
  appendTextLine(details, `Workspace: ${workspace?.status || "unknown"}${workspace?.path ? ` — ${workspace.path}` : ""}`);
  for (const [name, component] of Object.entries(result.components || {})) appendTextLine(details, `${componentLabel(name)}: ${componentDetail(component)}`);
  box.append(details);
}
async function testAgentConnection() {
  const button = $("test-agent");
  button.disabled = true;
  button.textContent = "Testing…";
  try {
    renderAgentResult(await call({ type: "test-agent-connection", payload: { port: $("agent-port").value } }));
  } finally {
    button.disabled = false;
    button.textContent = "Test connection";
  }
}
async function refreshDiagnostics() { const result = await call({ type: "get-diagnostics" }); const summary = $("diagnostics-summary"); if (!result?.ok) { summary.textContent = "Diagnostics are unavailable."; return result; } const count = Number(result.commandEntryCount || 0) + Number(result.searchEntryCount || 0); summary.textContent = count ? `${count} local event${count === 1 ? "" : "s"} captured (${result.commandEntryCount || 0} tool, ${result.searchEntryCount || 0} search). Copy the log after reproducing the problem.` : "No diagnostic events captured yet."; return result; }
function toolGroupTitle(groups, group) { return groups?.[group]?.title || "Custom"; }
function renderMcpTools(result) {
  const container = $("mcp-tools"); const note = $("mcp-tools-result");
  if (!result?.ok) { container.textContent = "MCP tool settings are unavailable."; note.textContent = result?.error || ""; return; }
  const defaultCheckbox = $("new-tools-enabled");
  defaultCheckbox.checked = result.preferences?.newToolsEnabledByDefault !== false;
  defaultCheckbox.onchange = async () => {
    const saved = await call({ type: "set-mcp-new-tools-default", payload: { enabled: defaultCheckbox.checked } });
    if (!saved?.ok) { defaultCheckbox.checked = !defaultCheckbox.checked; note.textContent = saved?.message || "Could not save the default."; return; }
    note.textContent = "Saved. Refresh the MCP tool schema in ChatGPT to apply future tool changes.";
  };
  container.replaceChildren();
  const groups = new Map();
  for (const tool of result.tools || []) { if (!groups.has(tool.group)) groups.set(tool.group, []); groups.get(tool.group).push(tool); }
  for (const [group, tools] of groups) {
    tools.sort((left, right) => left.name.localeCompare(right.name));
    const groupElement = document.createElement("section"); groupElement.className = "tool-group";
    const heading = document.createElement("h3"); heading.textContent = toolGroupTitle(result.groups, group); groupElement.append(heading);
    for (const tool of tools) {
      const row = document.createElement("label"); row.className = "tool-row";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = tool.enabled === true; checkbox.disabled = tool.alwaysEnabled === true;
      const copy = document.createElement("span"); copy.className = "tool-copy";
      const title = document.createElement("strong"); title.textContent = tool.title;
      const description = document.createElement("span"); description.className = "tool-description"; description.textContent = tool.description;
      const name = document.createElement("code"); name.textContent = tool.name;
      copy.append(title, description, name); row.append(checkbox, copy); groupElement.append(row);
      checkbox.addEventListener("change", async () => {
        const saved = await call({ type: "set-mcp-tool-enabled", payload: { name: tool.name, enabled: checkbox.checked } });
        if (!saved?.ok) { checkbox.checked = !checkbox.checked; note.textContent = saved?.message || "Could not save this tool setting."; return; }
        note.textContent = "Saved. Open ChatGPT Plugins, then ResearchTube → Manage → Refresh.";
      });
    }
    container.append(groupElement);
  }
}
async function loadMcpToolSettings() { renderMcpTools(await call({ type: "get-mcp-tool-settings" })); }
async function saveAndTest() { $("test-connection").disabled = true; $("test-connection").textContent = "Testing…"; const saved = await call({ type: "save-connection", payload: { tunnelId: $("tunnel-id").value, apiKey: $("api-key").value } }); const result = saved.ok ? await call({ type: "test-connection" }) : saved; renderResult(result); if (result.ok) { await call({ type: "save-connection", payload: { tunnelId: $("tunnel-id").value, onboardingCompleted: true } }); $("api-key").value = ""; $("api-key").placeholder = "••••••••••••••••"; } $("test-connection").disabled = false; $("test-connection").textContent = "Save and test connection"; }
$("test-connection").addEventListener("click", saveAndTest);
$("test-agent").addEventListener("click", testAgentConnection);
document.querySelectorAll("[data-open]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); call({ type: "open-external", target: link.dataset.open }); }));
$("copy-tunnel").addEventListener("click", async () => { await navigator.clipboard.writeText($("tunnel-id").value.trim()); $("copy-tunnel").textContent = "Copied"; setTimeout(() => { $("copy-tunnel").textContent = "Copy Tunnel ID"; }, 1400); });
$("copy-app-name").addEventListener("click", async () => { await navigator.clipboard.writeText("ResearchTube"); $("copy-app-name").textContent = "Copied"; setTimeout(() => { $("copy-app-name").textContent = "Copy name"; }, 1400); });
$("copy-prompt").addEventListener("click", async () => { await navigator.clipboard.writeText($("example-prompt").textContent.trim()); $("copy-prompt").textContent = "Copied"; setTimeout(() => { $("copy-prompt").textContent = "Copy example prompt"; }, 1400); });
$("copy-diagnostics").addEventListener("click", async () => { const button = $("copy-diagnostics"); const result = await call({ type: "get-diagnostics" }); if (!result?.ok) { $("diagnostics-summary").textContent = "Could not export diagnostics."; return; } await navigator.clipboard.writeText(result.text); button.textContent = "Copied"; setTimeout(() => { button.textContent = "Copy diagnostics log"; }, 1400); });
$("clear-diagnostics").addEventListener("click", async () => { const result = await call({ type: "clear-diagnostics" }); if (result?.ok) { $("diagnostics-summary").textContent = "No diagnostic events captured yet."; } else { $("diagnostics-summary").textContent = "Could not clear diagnostics."; } });
async function init() { const state = await call({ type: "status" }); $("tunnel-id").value = state.tunnelId || ""; $("agent-port").value = state.agentPort || 17843; if (state.apiKeyPresent) $("api-key").placeholder = "••••••••••••••••"; await refreshDiagnostics(); await loadMcpToolSettings(); }
init();

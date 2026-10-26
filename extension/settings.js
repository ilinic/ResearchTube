const $ = (id) => document.getElementById(id);
async function call(message) { return chrome.runtime.sendMessage(message); }
function componentLabel(name) { return name === "ytDlp" ? "yt-dlp" : name === "youtubePoTokenProvider" ? "YouTube PO-token provider" : name; }
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
function toolGroupTitle(groups, group) { return groups?.[group]?.title || "Custom Asynchronous Tasks"; }
function renderMcpTools(result) {
  const container = $("mcp-tools"); const note = $("mcp-tools-result");
  if (!result?.ok) { container.textContent = "MCP tool settings are unavailable."; note.textContent = result?.error || ""; return; }
  container.replaceChildren();
  const groups = new Map();
  for (const tool of result.tools || []) { if (!groups.has(tool.group)) groups.set(tool.group, []); groups.get(tool.group).push(tool); }
  for (const [group, tools] of groups) {
    tools.sort((left, right) => left.name.localeCompare(right.name));
    const groupElement = document.createElement("section"); groupElement.className = "tool-group";
    const heading = document.createElement("h3"); heading.textContent = tools[0]?.groupTitle || toolGroupTitle(result.groups, group); groupElement.append(heading);
    for (const tool of tools) {
      const row = document.createElement("label"); row.className = "tool-row";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = tool.enabled === true; checkbox.disabled = tool.alwaysEnabled === true;
      const copy = document.createElement("span"); copy.className = "tool-copy";
      const heading = document.createElement("span"); heading.className = "tool-heading";
      const title = document.createElement("strong"); title.textContent = tool.title;
      const name = document.createElement("code"); name.textContent = tool.name;
      const description = document.createElement("span"); description.className = "tool-description"; description.textContent = tool.description;
      heading.append(title, name); copy.append(heading, description); row.append(checkbox, copy); groupElement.append(row);
      checkbox.addEventListener("change", async () => {
        const saved = await call({ type: "set-mcp-tool-enabled", payload: { name: tool.name, enabled: checkbox.checked } });
        if (!saved?.ok) { checkbox.checked = !checkbox.checked; note.textContent = saved?.message || "Could not save this tool setting."; return; }
        note.textContent = "Saved. Open ChatGPT Plugins, then ResearchTube → Manage → Refresh.";
      });
    }
    container.append(groupElement);
  }
  if (Array.isArray(result.customToolErrors) && result.customToolErrors.length) {
    const errors = document.createElement("p"); errors.className = "field-help";
    errors.textContent = `Custom Tool packages with errors: ${result.customToolErrors.map((item) => item.package || "unknown").join(", ")}.`;
    container.append(errors);
  }
}
async function loadMcpToolSettings() { renderMcpTools(await call({ type: "get-mcp-tool-settings" })); }
$("test-agent").addEventListener("click", testAgentConnection);
document.querySelectorAll("[data-open]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); call({ type: "open-external", target: link.dataset.open }); }));
$("copy-silent-automation-flag").addEventListener("click", async () => { await navigator.clipboard.writeText($("silent-automation-flag").textContent.trim()); $("copy-silent-automation-flag").textContent = "Copied"; setTimeout(() => { $("copy-silent-automation-flag").textContent = "Copy"; }, 1400); });
$("copy-diagnostics").addEventListener("click", async () => { const button = $("copy-diagnostics"); const result = await call({ type: "get-diagnostics" }); if (!result?.ok) { $("diagnostics-summary").textContent = "Could not export diagnostics."; return; } await navigator.clipboard.writeText(result.text); button.textContent = "Copied"; setTimeout(() => { button.textContent = "Copy diagnostics log"; }, 1400); });
$("clear-diagnostics").addEventListener("click", async () => { const result = await call({ type: "clear-diagnostics" }); if (result?.ok) { $("diagnostics-summary").textContent = "No diagnostic events captured yet."; } else { $("diagnostics-summary").textContent = "Could not clear diagnostics."; } });
async function init() {
  const state = await call({ type: "status", includeAgent: false });
  $("agent-port").value = state.agentPort || 17843;
  await refreshDiagnostics(); await loadMcpToolSettings();
}
init();

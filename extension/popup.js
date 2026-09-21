const $ = (id) => document.getElementById(id);
async function call(message) { return chrome.runtime.sendMessage(message); }
function shortTunnel(id) { return id && id.length > 14 ? `${id.slice(0, 9)}…${id.slice(-4)}` : id || "Not configured"; }
function version(value) { return value ? `v${String(value).replace(/^v/i, "")}` : "v—"; }
function agentSummary(agent, port) {
  if (!agent?.available) return { text: `Unavailable · ${port}`, className: "bad" };
  if (agent.error === "AGENT_INTERFACE_INCOMPATIBLE") return { text: "Version mismatch", className: "bad" };
  return { text: `Ready · ${version(agent.agentVersion)}`, className: "good" };
}
async function load() {
  const state = await call({ type: "status" });
  const configured = state.configured;
  const youtubeSearch = state.youtubeSearch;
  const searchLimited = Boolean(youtubeSearch?.rateLimited);
  const agent = agentSummary(state.agent, state.agentPort || 17843);
  $("extension-status").textContent = version(state.extensionVersion);
  $("extension-status").className = "good";
  $("tunnel-status").textContent = shortTunnel(state.tunnelId);
  $("tunnel-status").className = configured ? "good" : "bad";
  $("youtube-status").textContent = searchLimited ? `Search paused — retry in ${youtubeSearch.retryAfterSeconds}s` : "Ready";
  $("youtube-status").className = searchLimited ? "warn" : "good";
  $("interface-version").textContent = version(state.requiredAgentInterfaceVersion);
  $("interface-version").className = "good";
  $("agent-status").textContent = agent.text;
  $("agent-status").className = agent.className;
}
$("chatgpt").addEventListener("click", () => call({ type: "open-external", target: "chatgptNewChat" }));
$("attach-image").addEventListener("click", async () => {
  const button = $("attach-image"); const result = $("test-image-result"); const filePath = $("cdp-image-path").value;
  button.disabled = true; result.hidden = false; result.className = ""; result.textContent = "Attaching image…";
  try {
    const response = await call({ type: "cdp-attach-image", filePath });
    if (!response?.ok) throw new Error(response?.error || "The image could not be attached.");
    result.className = "ok"; result.textContent = "Image attached. Open the service tab to inspect the Composer preview.";
  } catch (error) {
    result.className = "error"; result.textContent = String(error?.message || error);
  } finally { button.disabled = false; }
});
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
load();

const $ = (id) => document.getElementById(id);
async function call(message) { return chrome.runtime.sendMessage(message); }
function shortTunnel(id) { return id && id.length > 14 ? `${id.slice(0, 9)}…${id.slice(-4)}` : id || "Not configured"; }
function setResult(result) { const box = $("result"); box.hidden = false; box.className = result.ok ? "ok" : "error"; box.textContent = result.ok ? "Connection successful." : (result.message || "Connection test failed."); }
function agentSummary(agent, port) {
  if (!agent?.available) return { text: `Unavailable · ${port}`, className: "bad" };
  if (agent.error === "AGENT_INTERFACE_INCOMPATIBLE") return { text: "Version mismatch", className: "bad" };
  return { text: `Ready · ${agent.agentVersion || "unknown"}`, className: "good" };
}
async function load() {
  const state = await call({ type: "status" });
  const tested = state.lastConnectionTest;
  const configured = state.configured;
  const youtubeSearch = state.youtubeSearch;
  const searchLimited = Boolean(youtubeSearch?.rateLimited);
  const agent = agentSummary(state.agent, state.agentPort || 17843);
  $("state").textContent = searchLimited ? "YouTube search temporarily limited" : (configured ? "Local tunnel connection" : "Settings required");
  $("tunnel-status").textContent = shortTunnel(state.tunnelId);
  $("tunnel-status").className = configured ? "good" : "bad";
  $("youtube-status").textContent = searchLimited ? `Search paused — retry in ${youtubeSearch.retryAfterSeconds}s` : "Ready";
  $("youtube-status").className = searchLimited ? "warn" : "good";
  $("interface-version").textContent = `v${state.requiredAgentInterfaceVersion ?? "—"}`;
  $("interface-version").className = "good";
  $("agent-status").textContent = agent.text;
  $("agent-status").className = agent.className;
  $("test-status").textContent = tested ? (tested.success ? "Successful" : "Failed") : "Not run";
  $("test-status").className = tested?.success ? "good" : (tested ? "bad" : "");
}
$("test").addEventListener("click", async () => { $("test").disabled = true; $("test").textContent = "Testing YT…"; const result = await call({ type: "test-connection" }); setResult(result); await load(); $("test").disabled = false; $("test").textContent = "Test YT Connection"; });
$("chatgpt").addEventListener("click", () => call({ type: "open-external", target: "chatgptNewChat" }));
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
load();

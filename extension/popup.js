const $ = (id) => document.getElementById(id);
async function call(message) { return chrome.runtime.sendMessage(message); }
function shortTunnel(id) { return id && id.length > 14 ? `${id.slice(0, 9)}…${id.slice(-4)}` : id || "Not configured"; }
function version(value) { return value ? `v${String(value).replace(/^v/i, "")}` : "v—"; }
function agentSummary(agent, port) {
  if (!agent?.available) return { text: `Unavailable · ${port}`, className: "bad" };
  if (agent.error === "AGENT_INTERFACE_INCOMPATIBLE") return { text: "Version mismatch", className: "bad" };
  return { text: `Ready · ${version(agent.agentVersion)}`, className: "good" };
}
function currentYouTubeVideoTab(tabs) {
  const tab = tabs?.[0];
  try {
    const url = new URL(tab?.url || "");
    return url.origin === "https://www.youtube.com" && url.pathname === "/watch" && /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get("v") || "") ? tab : null;
  } catch (_error) { return null; }
}
let activeYouTubeVideoTab = null;
async function load() {
  // The contextual action must not wait for Agent health, which can take
  // seconds while the Local Agent is starting or unavailable.
  const activeTabPromise = chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const statePromise = call({ type: "status" });
  activeYouTubeVideoTab = currentYouTubeVideoTab(await activeTabPromise);
  $("describe-video").hidden = !activeYouTubeVideoTab;
  const state = await statePromise;
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
$("describe-video").addEventListener("click", async () => {
  const button = $("describe-video"); const status = $("describe-video-status");
  if (!activeYouTubeVideoTab) return;
  button.disabled = true; status.hidden = false; status.className = "action-status"; status.textContent = "Opening ChatGPT…";
  const result = await call({ type: "describe-youtube-video", tab: { url: activeYouTubeVideoTab.url, index: activeYouTubeVideoTab.index } });
  if (result?.ok) { status.classList.add("ok"); status.textContent = "Sent to ChatGPT."; } else { status.classList.add("error"); status.textContent = result?.error || "Could not send the video-description request."; button.disabled = false; }
});
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
load();

const $ = (id) => document.getElementById(id);
async function call(message) { return chrome.runtime.sendMessage(message); }
function shortTunnel(id) { return id && id.length > 14 ? `${id.slice(0, 9)}…${id.slice(-4)}` : id || "Not configured"; }
function version(value) { return value ? `v${String(value).replace(/^v/i, "")}` : "v—"; }
function agentSummary(agent, port) {
  if (!agent?.available) return { text: `Unavailable · ${port}`, className: "bad" };
  if (agent.error === "AGENT_INTERFACE_INCOMPATIBLE") return { text: "Version mismatch", className: "bad" };
  return { text: `Ready · ${version(agent.agentVersion)}`, className: "good" };
}
function chromeAutomationSummary(agent) {
  const state = agent?.available ? agent.chromeAutomation?.state : "unknown";
  if (state === "enabled") return { text: "Enabled", className: "good" };
  if (state === "disabled") return { text: "Disabled", className: "bad" };
  if (state === "mixed") return { text: "Mixed", className: "warn" };
  return { text: "Unknown", className: "warn" };
}
function currentYouTubeVideoTab(tabs) {
  const tab = tabs?.[0];
  try {
    const url = new URL(tab?.url || "");
    if (url.origin !== "https://www.youtube.com") return null;
    const isWatchVideo = url.pathname === "/watch" && /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get("v") || "");
    const isShort = /^\/shorts\/[A-Za-z0-9_-]{11}$/.test(url.pathname);
    return isWatchVideo || isShort ? tab : null;
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
  const chromeAutomation = chromeAutomationSummary(state.agent);
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
  $("chrome-automation-status").textContent = chromeAutomation.text;
  $("chrome-automation-status").className = chromeAutomation.className;
}
$("chatgpt").addEventListener("click", () => call({ type: "open-external", target: "chatgptNewChat" }));
$("describe-video").addEventListener("click", () => {
  if (!activeYouTubeVideoTab) return;
  // Start the background request first.  It owns the full CDP lifecycle, so the
  // popup can close without waiting for ChatGPT to become ready.
  void call({ type: "describe-youtube-video", tab: { url: activeYouTubeVideoTab.url, title: activeYouTubeVideoTab.title, index: activeYouTubeVideoTab.index } }).catch(() => {});
  window.close();
});
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
load();

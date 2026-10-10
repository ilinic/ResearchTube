const $ = (id) => document.getElementById(id);
async function call(message) { return chrome.runtime.sendMessage(message); }
function shortTunnel(id) { return id && id.length > 14 ? `${id.slice(0, 9)}…${id.slice(-4)}` : id || "Not configured"; }
function version(value) { return value ? `v${String(value).replace(/^v/i, "")}` : "v—"; }
let connectionReadRevision = 0;
function renderConnectionStatus(state) {
  const errorLabels = {
    NOT_CONFIGURED: "Not Configured", API_KEY_MISSING: "API key missing", TUNNEL_ID_MISSING: "Tunnel ID missing",
    API_KEY_INVALID: "API key rejected", TUNNEL_PERMISSION_DENIED: "Access denied", TUNNEL_NOT_FOUND: "Tunnel not found", NETWORK_ERROR: "Network error"
  };
  const connection = state.connection || (state.configured ? { state: "unchecked" } : { state: "not-configured", errorCode: "NOT_CONFIGURED" });
  const element = $("tunnel-status");
  const notConfigured = !state.configured || connection.state === "not-configured";
  $("tunnel-status-value").textContent = notConfigured ? "Not Configured" : connection.state === "ready" ? shortTunnel(state.tunnelId) : connection.state === "unchecked" ? "Not tested" : errorLabels[connection.errorCode] || "Connection failed";
  $("tunnel-help").hidden = connection.state === "ready";
  element.className = connection.state === "ready" ? "good" : connection.state === "unchecked" || connection.errorCode === "NOT_CONFIGURED" ? "warn" : "bad";
}
async function loadConnectionStatus() {
  const revision = ++connectionReadRevision;
  const state = await call({ type: "status", includeAgent: false });
  if (revision === connectionReadRevision) renderConnectionStatus(state);
}
function agentSummary(agent, port) {
  if (!agent?.available) return { text: `Unavailable · ${port}`, className: "bad" };
  if (agent.error === "AGENT_INTERFACE_INCOMPATIBLE") return { text: "Version mismatch", className: "bad" };
  return { text: `Ready · ${version(agent.agentVersion)}`, className: "good" };
}
function chromeAutomationSummary(agent) {
  const state = agent?.available ? agent.chromeAutomation?.state : "unknown";
  if (state === "checking") return { text: "Checking…", className: "warn" };
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
function renderAgentStatus(agent, port = 17843) {
  const summary = agentSummary(agent, port);
  const chromeAutomation = chromeAutomationSummary(agent);
  $("agent-status").textContent = summary.text;
  $("agent-status").className = summary.className;
  $("chrome-automation-status").textContent = chromeAutomation.text;
  $("chrome-automation-status").className = chromeAutomation.className;
}
async function loadAgentStatus(port) {
  $("agent-status").textContent = "Checking…";
  $("chrome-automation-status").textContent = "Checking…";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const agent = await call({ type: "agent-status" });
    renderAgentStatus(agent, port);
    if (!agent?.available || agent.chromeAutomation?.state !== "checking") return;
    // Only read the saved startup snapshot. Never trigger another diagnostic.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
let activeYouTubeVideoTab = null;
async function load() {
  $("extension-status").textContent = version(chrome.runtime.getManifest().version);
  $("extension-status").className = "good";
  $("agent-status").textContent = "Checking…";
  $("chrome-automation-status").textContent = "Checking…";
  // Local popup state and actions render independently of Agent availability.
  const activeTabPromise = chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const connectionRevision = ++connectionReadRevision;
  const statePromise = call({ type: "status", includeAgent: false });
  const activeTabs = await activeTabPromise;
  activeYouTubeVideoTab = currentYouTubeVideoTab(activeTabs);
  $("describe-video").hidden = !activeYouTubeVideoTab;
  $("chatgpt").hidden = Boolean(activeYouTubeVideoTab);
  const state = await statePromise;
  const youtubeSearch = state.youtubeSearch;
  const searchLimited = Boolean(youtubeSearch?.rateLimited);
  if (connectionRevision === connectionReadRevision) renderConnectionStatus(state);
  $("youtube-status").textContent = searchLimited ? `Search paused — retry in ${youtubeSearch.retryAfterSeconds}s` : "Ready";
  $("youtube-status").className = searchLimited ? "warn" : "good";
  $("interface-version").textContent = version(state.requiredAgentInterfaceVersion);
  $("interface-version").className = "good";
  void loadAgentStatus(state.agentPort || 17843).catch((error) => console.info("[ResearchTube] Agent status unavailable", error));
}
$("chatgpt").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^https?:\/\//.test(tab.url || "")) { console.info("[ResearchTube Browser] Open a website before starting Study this site."); return; }
  void call({ type: "study-site", tabId: tab.id }).catch(error => console.info("[ResearchTube Browser]", error));
  window.close();
});
$("describe-video").addEventListener("click", async () => {
  // Do not reuse the tab snapshot collected when the popup opened. A playlist
  // can advance while it is open. Chrome supplies the URL from the address bar
  // and the tab title at this exact click time.
  const liveTab = currentYouTubeVideoTab(await chrome.tabs.query({ active: true, lastFocusedWindow: true }));
  if (!liveTab) return;
  // Start the background request first. It owns the full CDP lifecycle, so the
  // popup can close without waiting for ChatGPT to become ready.
  void call({ type: "describe-youtube-video", tab: {
    url: liveTab.url,
    title: liveTab.title,
    index: liveTab.index
  } }).catch((error) => console.info("[ResearchTube] Describe this video request failed", error));
  window.close();
});
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("tunnel-help").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") + "#setup-guide" }));
$("help").addEventListener("click", () => {
  // The worker owns startup after this popup closes, including with no Agent
  // or tunnel configured: help must be available during initial installation.
  void call({ type: "open-help" }).catch(error => console.info("[ResearchTube] Help request failed", error));
  window.close();
});
$("support").addEventListener("click", () => call({ type: "open-external", target: "support" }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ["tunnelId", "runtimeApiKey", "lastConnectionTest", "lastTunnelConnection"].some(name => Object.hasOwn(changes, name))) {
    void loadConnectionStatus().catch(() => {});
  }
});
load();

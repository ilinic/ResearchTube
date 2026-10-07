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
let browserControlTabId = null;
let browserPopupClosed = false;
window.addEventListener("pagehide", () => { browserPopupClosed = true; });
function renderBrowserSession(session) {
  $("browser-session").hidden = !session;
  if (!session) return;
  $("browser-session-status").textContent = session.error ? `${session.error.code}: ${session.error.message}` : session.statusMessage;
  $("browser-pause").disabled = session.state !== "running";
  $("browser-resume").disabled = session.state !== "paused";
  $("browser-stop").disabled = !["starting", "running", "paused"].includes(session.state);
}
async function loadBrowserSession(tabId) {
  browserControlTabId = tabId;
  while (!browserPopupClosed) {
    const result = await call({ type: "browser-local-status", tabId });
    if (!result?.ok) return;
    renderBrowserSession(result.session);
    if (!result.session || ["stopped", "failed"].includes(result.session.state)) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
for (const action of ["pause", "resume", "stop"]) {
  $(`browser-${action}`).addEventListener("click", async () => {
    if (!Number.isInteger(browserControlTabId)) return;
    const result = await call({ type: "browser-local-control", tabId: browserControlTabId, action }).catch(error => ({ error: String(error) }));
    if (result?.ok) renderBrowserSession(result.session);
    else $("browser-session-status").textContent = result?.error || "Browser control unavailable.";
  });
}
let activeYouTubeVideoTab = null;
async function load() {
  $("agent-status").textContent = "Checking…";
  $("chrome-automation-status").textContent = "Checking…";
  // Local popup state and actions render independently of Agent availability.
  const activeTabPromise = chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const statePromise = call({ type: "status", includeAgent: false });
  const activeTabs = await activeTabPromise;
  activeYouTubeVideoTab = currentYouTubeVideoTab(activeTabs);
  if (Number.isInteger(activeTabs?.[0]?.id)) void loadBrowserSession(activeTabs[0].id).catch(error => console.info("[ResearchTube Browser] status unavailable", error));
  $("describe-video").hidden = !activeYouTubeVideoTab;
  const state = await statePromise;
  const configured = state.configured;
  const youtubeSearch = state.youtubeSearch;
  const searchLimited = Boolean(youtubeSearch?.rateLimited);
  $("extension-status").textContent = version(state.extensionVersion);
  $("extension-status").className = "good";
  $("tunnel-status").textContent = shortTunnel(state.tunnelId);
  $("tunnel-status").className = configured ? "good" : "bad";
  $("youtube-status").textContent = searchLimited ? `Search paused — retry in ${youtubeSearch.retryAfterSeconds}s` : "Ready";
  $("youtube-status").className = searchLimited ? "warn" : "good";
  $("interface-version").textContent = version(state.requiredAgentInterfaceVersion);
  $("interface-version").className = "good";
  void loadAgentStatus(state.agentPort || 17843).catch((error) => console.info("[ResearchTube] Agent status unavailable", error));
}
$("chatgpt").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^https?:\/\//.test(tab.url || "")) { $("describe-video-status").hidden = false; $("describe-video-status").textContent = "Open a website before starting Study this site."; return; }
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
$("support").addEventListener("click", () => call({ type: "open-external", target: "support" }));
load();

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [html, script, css, background] = await Promise.all([
  readFile(new URL("../popup.html", import.meta.url), "utf8"),
  readFile(new URL("../popup.js", import.meta.url), "utf8"),
  readFile(new URL("../popup.css", import.meta.url), "utf8"),
  readFile(new URL("../background.js", import.meta.url), "utf8")
]);

assert.match(html, /Turn YouTube into Answers/);
assert.match(html, /id="describe-video" hidden>Describe this video/);
assert.match(html, /Study this site/);
assert.match(script, /type: "study-site", tabId: tab.id/);
assert.match(html, /<nav><button id="settings"[^>]*>Settings<\/button><button id="help" class="link">Help<\/button><button id="support"[^>]*><span class="support-heart" aria-hidden="true">♥<\/span> Support<\/button><\/nav>/, "Help must appear between Settings and Support on the same row with the same link style");
assert.match(html, /<dt>Extension<\/dt><dd id="extension-status">/);
assert.match(html, /<dt>OpenAI Tunnel<\/dt>/);
assert.match(html, /<dt>YouTube<\/dt>/);
assert.match(html, /<dt>Local Agent<\/dt>/);
assert.match(html, /<dt>Interface<\/dt>/);
assert.match(html, /<dt>Silent file automation<\/dt><dd id="chrome-automation-status">/);
assert.doesNotMatch(html, /Image preview|Base64|Local Agent URL/);
assert.doesNotMatch(html, /cdp-image-path|Image file path|Attach Image/);
assert.doesNotMatch(html, /Local tunnel connection/);
assert.match(script, /function version\(value\)/);
assert.match(script, /\$\("extension-status"\)\.textContent = version\(state\.extensionVersion\)/);
assert.match(script, /Ready · \$\{version\(agent\.agentVersion\)\}/);
assert.match(script, /function chromeAutomationSummary\(agent\)/);
assert.match(script, /\$\("chrome-automation-status"\)\.textContent = chromeAutomation\.text/);
assert.match(script, /currentYouTubeVideoTab/);
assert.match(script, /const isShort =/, "Describe this video must be available on YouTube Shorts too");
assert.match(script, /describe-youtube-video/);
assert.match(script, /void call\(\{ type: "describe-youtube-video"/, "Describe this video must hand the work to the background service worker");
assert.match(script, /await chrome\.tabs\.query\(\{ active: true, lastFocusedWindow: true \}\)/, "Describe this video must read the active tab again at click time");
assert.match(script, /url: liveTab\.url/, "Describe this video must pass the current address-bar URL to the prompt builder");
assert.match(script, /title: liveTab\.title/, "Describe this video must pass the current tab title to the prompt builder");
assert.match(script, /window\.close\(\)/, "Describe this video must close the popup immediately");
assert.match(script, /const activeTabPromise = chrome\.tabs\.query/, "video-button visibility must start before the Agent status request resolves");
assert.match(script, /const statePromise = call\(\{ type: "status", includeAgent: false \}\)/, "status may load in parallel with the contextual action");
assert.match(script, /\$\("support"\)\.addEventListener\("click", \(\) => call\(\{ type: "open-external", target: "support" \}\)\)/, "Support must use the allowlisted external-link handler");
assert.match(background, /support: "https:\/\/ko-fi\.com\/ilinic"/, "Support must open the configured Ko-fi page");
assert.match(html, /<header>[\s\S]*?<\/header>\s*<hr class="section-divider">\s*<section class="quick-actions">/, "a divider must separate the header from the quick actions");
assert.match(html, /<\/dl>\s*<hr class="section-divider">\s*<nav>/, "a divider must separate the status details from Settings");
assert.match(css, /\.section-divider\{[^}]*border-top:1px solid var\(--border\)/, "popup dividers must use the standard border color");
assert.match(css, /nav\{[^}]*grid-template-columns:repeat\(3,1fr\)/, "footer must have three equal columns");
assert.match(css, /#help\{justify-self:center\}/, "Help must be centered in the popup");
assert.match(css, /\.support-heart\{[^}]*color:var\(--heart\)/, "Support heart must use its dedicated red color");
assert.doesNotMatch(script, /widget-image-delivery|save-widget-image-delivery/);
assert.doesNotMatch(script, /cdp-attach-image|filePath/);
console.log("popup UI: ok");

// Exercise popup rendering with a stalled Agent response, then startup progress.
const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, { textContent: "", className: "", hidden: false, addEventListener() {} });
  return elements.get(id);
};
const messages = [];
const scheduled = [];
let resolveAgent;
let agentCalls = 0;
const popupContext = {
  document: { getElementById: element }, URL, console,
  window: { close() {}, addEventListener() {} },
  setTimeout: (callback) => { scheduled.push(callback); return scheduled.length; },
  chrome: {
    storage: { onChanged: { addListener() {} } },
    tabs: { query: async () => [] },
    runtime: {
      openOptionsPage() {},
      sendMessage: (message) => {
        messages.push(message);
        if (message.type === "status") return Promise.resolve({
          configured: true, connection: { state: "ready", errorCode: null }, tunnelId: "tunnel_test", extensionVersion: "2.2.52",
          requiredAgentInterfaceVersion: 73, agentPort: 17844, youtubeSearch: {},
        });
        assert.equal(message.type, "agent-status");
        agentCalls += 1;
        if (agentCalls === 1) return new Promise((resolve) => { resolveAgent = resolve; });
        return Promise.resolve({ available: true, agentVersion: "2.2.52", chromeAutomation: { state: "enabled" } });
      },
    },
  },
};
vm.runInNewContext(script, popupContext);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(element("extension-status").textContent, "v2.2.52", "local status renders before Agent responds");
assert.equal(element("tunnel-status-value").textContent, "tunnel_test");
assert.equal(element("interface-version").textContent, "v73");
assert.equal(element("agent-status").textContent, "Checking…");
assert.equal(messages[0].includeAgent, false);
resolveAgent({ available: true, agentVersion: "2.2.52", chromeAutomation: { state: "checking" } });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(element("agent-status").textContent, "Ready · v2.2.52");
assert.equal(element("chrome-automation-status").textContent, "Checking…");
assert.equal(scheduled.length, 1, "pending startup state has one bounded snapshot reread");
scheduled.shift()();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(element("chrome-automation-status").textContent, "Enabled");
assert.equal(scheduled.length, 0, "completed diagnostics are not periodically polled");
vm.runInNewContext("renderAgentStatus({available: false}, 17844)", popupContext);
assert.equal(element("agent-status").textContent, "Unavailable · 17844");
console.log("popup nonblocking Agent status: ok");

// Exactly one filled action, selected before connection/Agent checks finish.
assert.match(html, /id="chatgpt" hidden>Study this site/);
for (const id of ["describe-video", "chatgpt"]) {
  const button = html.match(new RegExp(`<button id="${id}"[^>]*>`))[0];
  assert.doesNotMatch(button, /secondary|class="link/, `${id} uses the filled primary style`);
}
assert.match(css, /button\{[^}]*background:var\(--blue\);color:#fff/);
const actionCases = [
  ["https://www.youtube.com/watch?v=dod4cpb0z1k", true],
  ["https://www.youtube.com/watch?v=dod4cpb0z1k&list=PL_test&t=20", true],
  ["https://www.youtube.com/shorts/dod4cpb0z1k?feature=share", true],
  ["https://www.youtube.com/", false],
  ["https://www.youtube.com/@ResearchTube", false],
  ["https://www.youtube.com/results?search_query=research", false],
  ["https://www.youtube.com/playlist?list=PL_test", false],
  ["https://www.youtube.com/watch", false],
  ["https://www.youtube.com/watch?v=invalid", false],
  ["https://example.com/watch?v=dod4cpb0z1k", false],
];
for (const [url, video] of actionCases) {
  const controls = new Map();
  const getControl = id => {
    if (!controls.has(id)) controls.set(id, {
      hidden: true, textContent: "", className: "", listeners: {},
      addEventListener(event, callback) { this.listeners[event] = callback; },
    });
    return controls.get(id);
  };
  const sent = [];
  const tab = { id: 42, url, title: "Current page", index: 2 };
  const context = {
    document: { getElementById: getControl }, URL, console,
    window: { close() {} },
    chrome: {
      storage: { onChanged: { addListener() {} } },
      tabs: { query: async () => [tab] },
      runtime: {
        openOptionsPage() {},
        sendMessage(message) {
          sent.push(message);
          // Keep status pending: contextual actions must not depend on it.
          return message.type === "status" ? new Promise(() => {}) : Promise.resolve({ ok: true });
        },
      },
    },
  };
  vm.runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getControl("describe-video").hidden, !video, url);
  assert.equal(getControl("chatgpt").hidden, video, url);
  assert.equal(["describe-video", "chatgpt"].filter(id => !getControl(id).hidden).length, 1, url);
  await getControl(video ? "describe-video" : "chatgpt").listeners.click();
  const action = sent.at(-1);
  assert.equal(action.type, video ? "describe-youtube-video" : "study-site", url);
  if (video) assert.equal(action.tab.url, url);
  else assert.equal(action.tabId, tab.id);
  getControl("help").listeners.click();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { type: "open-help" }, "Help sends no source page, task/session or configuration data");
}
console.log("popup contextual filled actions: watch/Shorts describe only; other pages study only: ok");

// Study this site has no popup controls, status polling or error panel.
assert.doesNotMatch(html,/browser-session|browser-pause|browser-resume|browser-stop/);
assert.doesNotMatch(script,/browser-local-status|browser-local-control|loadBrowserSession|renderBrowserSession/);
assert.doesNotMatch(css,/browser-session|browser-controls/);
assert.doesNotMatch(background,/browser-local-status|browser-local-control/);
console.log('Browser popup: launch button only; no session panel, controls or polling: ok');

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
assert.match(html, /Open empty ChatGPT/);
assert.match(html, /<nav><button id="settings"[^>]*>Settings<\/button><button id="support"[^>]*><span class="support-heart" aria-hidden="true">♥<\/span> Support<\/button><\/nav>/, "Support must appear to the right of Settings on the same row");
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
  window: { close() {} },
  setTimeout: (callback) => { scheduled.push(callback); return scheduled.length; },
  chrome: {
    tabs: { query: async () => [] },
    runtime: {
      openOptionsPage() {},
      sendMessage: (message) => {
        messages.push(message);
        if (message.type === "status") return Promise.resolve({
          configured: true, tunnelId: "tunnel_test", extensionVersion: "2.2.52",
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
assert.equal(element("tunnel-status").textContent, "tunnel_test");
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

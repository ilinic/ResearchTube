import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, script, css] = await Promise.all([
  readFile(new URL("../popup.html", import.meta.url), "utf8"),
  readFile(new URL("../popup.js", import.meta.url), "utf8"),
  readFile(new URL("../popup.css", import.meta.url), "utf8")
]);

assert.match(html, /Turn YouTube into Answers/);
assert.match(html, /id="describe-video" hidden>Describe this video/);
assert.match(html, /Open empty ChatGPT/);
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
assert.match(script, /title: activeYouTubeVideoTab\.title/, "Describe this video must pass the current YouTube title to the prompt builder");
assert.match(script, /window\.close\(\)/, "Describe this video must close the popup immediately");
assert.match(script, /const activeTabPromise = chrome\.tabs\.query/, "video-button visibility must start before the Agent status request resolves");
assert.match(script, /const statePromise = call\(\{ type: "status" \}\)/, "status may load in parallel with the contextual action");
assert.match(html, /<header>[\s\S]*?<\/header>\s*<hr class="section-divider">\s*<section class="quick-actions">/, "a divider must separate the header from the quick actions");
assert.match(html, /<\/dl>\s*<hr class="section-divider">\s*<nav>/, "a divider must separate the status details from Settings");
assert.match(css, /\.section-divider\{[^}]*border-top:1px solid var\(--border\)/, "popup dividers must use the standard border color");
assert.doesNotMatch(script, /widget-image-delivery|save-widget-image-delivery/);
assert.doesNotMatch(script, /cdp-attach-image|filePath/);
console.log("popup UI: ok");

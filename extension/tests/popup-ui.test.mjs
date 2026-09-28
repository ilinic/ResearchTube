import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
assert.match(script, /const statePromise = call\(\{ type: "status" \}\)/, "status may load in parallel with the contextual action");
assert.match(script, /\$\("support"\)\.addEventListener\("click", \(\) => call\(\{ type: "open-external", target: "support" \}\)\)/, "Support must use the allowlisted external-link handler");
assert.match(background, /support: "https:\/\/ko-fi\.com\/ilinic"/, "Support must open the configured Ko-fi page");
assert.match(html, /<header>[\s\S]*?<\/header>\s*<hr class="section-divider">\s*<section class="quick-actions">/, "a divider must separate the header from the quick actions");
assert.match(html, /<\/dl>\s*<hr class="section-divider">\s*<nav>/, "a divider must separate the status details from Settings");
assert.match(css, /\.section-divider\{[^}]*border-top:1px solid var\(--border\)/, "popup dividers must use the standard border color");
assert.match(css, /\.support-heart\{[^}]*color:var\(--heart\)/, "Support heart must use its dedicated red color");
assert.doesNotMatch(script, /widget-image-delivery|save-widget-image-delivery/);
assert.doesNotMatch(script, /cdp-attach-image|filePath/);
console.log("popup UI: ok");

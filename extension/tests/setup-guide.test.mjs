import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {existsSync} from "node:fs";
const root = p => new URL("../" + p, import.meta.url);
const [popup, script, settings, guide, style] = await Promise.all(
  ["popup.html","popup.js","settings.html","settings.js","settings.css"].map(p => readFile(root(p),"utf8")));
assert.match(popup,/id="tunnel-help"[^>]*hidden>Help/);
assert.match(script,/notConfigured = !state\.configured/);
assert.match(script,/\$\("tunnel-help"\)\.hidden = connection\.state === "ready"/);
assert.match(script,/tunnel-status-value/);
assert.match(script,/getURL\("settings.html"\) \+ "#setup-guide"/);
assert.match(settings,/<details id="setup-guide" class="setup-guide">/);
assert.doesNotMatch(settings,/<details id="setup-guide"[^>]*open\b/);
assert.match(guide,/guide\.open = true/);
assert.match(guide,/scrollIntoView/);
assert.match(style,/\.setup-image img/);
const paths=[...settings.matchAll(/src="(images\/setup-[^"]+\.png)"/g)].map(x=>x[1]);
assert.equal(paths.length,4);
assert.deepEqual([...settings.matchAll(/<h3(?: [^>]*)?>Step (\d+) —/g)].map(x=>Number(x[1])),[1,2,3,4,5,6,7,8,9]);
assert.doesNotMatch(settings,/<h3>[^<]*Developer Mode/);
assert.doesNotMatch(settings,/setup-04-developer-mode\.png/);
assert.match(settings,/<h3>Step 7 — Add ResearchTube as a custom MCP plugin<\/h3>/);
assert.match(settings,/<h3>Step 8 — Try ResearchTube<\/h3>/);
const stepEight = settings.slice(settings.indexOf("<h3>Step 8 —"), settings.indexOf("<h3>Step 9 —"));
assert.match(stepEight,/id="example-prompt"/);
assert.match(stepEight,/id="copy-prompt"/);
assert.match(stepEight,/data-open="chatgptNewChat"/);
assert.doesNotMatch(stepEight,/Troubleshooting|Local Agent|Silent file automation/);
assert.ok(stepEight.indexOf('id="copy-prompt"') < stepEight.indexOf('data-open="chatgptNewChat"'));
assert.doesNotMatch(stepEight,/select\b/i);
assert.match(stepEight,/Copy the example prompt below/);
assert.match(stepEight,/Open a new ChatGPT chat/);
assert.match(stepEight,/Paste and send this prompt/);
const troubleshootingStep = settings.slice(settings.indexOf("<h3>Step 9 —"), settings.indexOf("</details>"));
assert.match(troubleshootingStep,/Troubleshooting/);
assert.match(troubleshootingStep,/<strong>Help<\/strong>/);
assert.match(troubleshootingStep,/ResearchTube popup/);
assert.match(troubleshootingStep,/dedicated ChatGPT help chat/);
assert.doesNotMatch(settings,/<h2>3\. Try ResearchTube<\/h2>/);
assert.equal((settings.match(/id="example-prompt"/g)||[]).length,1);
assert.equal((settings.match(/id="copy-prompt"/g)||[]).length,1);
for (const path of paths) {const img=await readFile(root(path));assert.equal(img.subarray(0,8).toString("hex"),"89504e470d0a1a0a");}

assert.equal(JSON.parse(await readFile(root("manifest.json"),"utf8")).options_page,"settings.html");
for (const path of ["onboarding.html","onboarding.css","onboarding.js"]) {
  assert.equal(existsSync(root(path)),false,`obsolete ${path} must be removed`);
}
assert.equal((settings.match(/<details\b/g)||[]).length,1,"only the setup guide should collapse");
assert.match(settings,/<p class="field-help setup-requirements"><strong>Requirements:<\/strong> The latest version of Google Chrome and a paid ChatGPT subscription\. ResearchTube is tested with ChatGPT Plus\.<\/p>/);
assert.match(style,/\.setup-guide-body > \.setup-requirements \{ color: #fff; \}/);
const guideSource=guide.slice(guide.indexOf("function openSetupGuideFromHash() {"),guide.indexOf('window.addEventListener("hashchange", openSetupGuideFromHash)'));
const openGuide=new Function("window","document","requestAnimationFrame",'const $=id=>document.getElementById(id);\n'+guideSource+"openSetupGuideFromHash();");
for (const hash of ["","#setup-guide"]) {
  let scrolled=0;
  const element={open:false,scrollIntoView(){scrolled++;}};
  openGuide({location:{hash}},{getElementById(id){assert.equal(id,"setup-guide");return element;}},callback=>callback());
  assert.equal(element.open,hash==="#setup-guide");
  assert.equal(scrolled,hash==="#setup-guide"?1:0);
}


const installationStep = settings.slice(settings.indexOf("<h3>Step 1 —"), settings.indexOf("<h3>Step 2 —"));
assert.match(installationStep,/id="open-chrome-extensions"/);
assert.match(installationStep,/Developer mode/);
assert.match(installationStep,/Load unpacked/);
assert.match(installationStep,/<code>extension<\/code>/);
assert.match(settings, /<h2>Set up OpenAI connection<\/h2>/);
assert.match(settings, /<summary>How to Set Up ResearchTube<\/summary>/);
assert.doesNotMatch(settings, /<(?:h2|summary)>\d+\./);
assert.match(installationStep, /Confirm the Chrome Extension is installed/);
assert.match(installationStep, /GitHub Releases/);
assert.match(installationStep, /platform ZIP/);
assert.match(installationStep, /<strong>Assets<\/strong>/);
assert.match(installationStep, /not a <strong>Source code<\/strong> archive/);
assert.match(installationStep, /extracted platform ZIP/);
assert.match(installationStep, /ResearchTube is enabled/);
assert.match(installationStep, /Pin it to Chrome's toolbar/);
assert.match(installationStep, /Keep the extracted folder in place/);
assert.match(settings, /Step 2 — Create an OpenAI Tunnel/);
assert.match(settings, /Step 3 — Create a restricted API key/);
assert.doesNotMatch(installationStep, /Save and test connection/);
const connectionStep = settings.slice(settings.indexOf("<h3>Step 4 —"), settings.indexOf("<h3>Step 5 —"));
assert.match(connectionStep, /API key and Tunnel ID/);
assert.match(connectionStep, /Save and test connection/);
assert.match(connectionStep, /setup-03-researchtube\.png/);
assert.doesNotMatch(installationStep,/agent-port|ResearchTubeAgent\.exe|We also recommend/);
const agentStep = settings.slice(settings.indexOf("<h3>Step 5 —"), settings.indexOf('<h3 id="silent-automation-heading">'));
assert.match(agentStep,/agent\/ResearchTubeAgent\.exe/);
assert.match(agentStep,/Basic YouTube features work without the Local Agent/);
assert.match(agentStep,/“<code>python researchtube_agent\.py<\/code>”/);
assert.match(agentStep,/“<code>python3 researchtube_agent\.py<\/code>”/);
assert.match(agentStep,/id="agent-port"/);
assert.match(agentStep,/id="test-agent"/);
assert.match(agentStep,/id="agent-result"/);
const silentStep = settings.slice(settings.indexOf('<h3 id="silent-automation-heading">'), settings.indexOf("<h3>Step 7 —"));
assert.match(silentStep,/id="silent-automation-flag"/);
assert.match(silentStep,/id="copy-silent-automation-flag"/);
assert.match(silentStep,/Restart the Local Agent/);
for (const status of ["OpenAI Tunnel", "Local Agent", "Ready", "Interface", "Silent file automation", "Enabled"]) assert.ok(silentStep.includes(status), status);
const setupBody = settings.slice(settings.indexOf('<details id="setup-guide"'), settings.indexOf('</details>'));
for (const id of ["agent-port", "test-agent", "agent-result", "silent-automation-flag", "copy-silent-automation-flag"]) {
  assert.equal((settings.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `${id} must remain unique`);
  assert.ok(setupBody.includes(`id="${id}"`), `${id} must be inside the guide`);
}
assert.match(settings, /<\/details>\s*<section>\s*<h2>Diagnostics<\/h2>/);
assert.match(style, /\.setup-guide > summary::marker \{ color:#ff0000; \}/);
const pluginStep = settings.slice(settings.indexOf("<h3>Step 7 —"), settings.indexOf("<h3>Step 8 —"));
assert.ok(pluginStep.indexOf("Local Agent is running") < pluginStep.indexOf("ChatGPT Plugins"));
assert.match(guide,/chrome\.tabs\.create\(\{ url: "chrome:\/\/extensions\/", active: true \}\)/);
const extensionsHandler = guide.slice(guide.indexOf('$("open-chrome-extensions").addEventListener'), guide.indexOf('$("test-connection").addEventListener'));
let prevented = false;
let opened = null;
new Function("$", "chrome", "console", extensionsHandler)(
  () => ({ addEventListener(type, handler) { assert.equal(type, "click"); handler({ preventDefault() { prevented = true; } }); } }),
  { tabs: { create(options) { opened = options; return Promise.resolve(); } } },
  console
);
assert.equal(prevented, true);
assert.deepEqual(opened, { url: "chrome://extensions/", active: true });

console.log("Setup guide: ok");

/* Exercise the popup status renderer with representative connection states. */
const renderSource = script.slice(script.indexOf("function renderConnectionStatus(state) {"),script.indexOf("async function loadConnectionStatus()"));
const shortTunnelSource = script.slice(script.indexOf("function shortTunnel(id) {"),script.indexOf("function version(value)"));
const render = new Function("state","nodes",
  "const $ = (id) => nodes[id];" + shortTunnelSource + renderSource + "renderConnectionStatus(state);");
for (const {connection, configured, visible, expected} of [
  {connection:{state:"not-configured",errorCode:"NOT_CONFIGURED"},configured:false,visible:true,expected:"Not Configured"},
  {connection:{state:"unchecked"},configured:true,visible:true,expected:"Not tested"},
  {connection:{state:"failed",errorCode:"API_KEY_INVALID"},configured:true,visible:true,expected:"API key rejected"},
  {connection:{state:"failed",errorCode:"TUNNEL_NOT_FOUND"},configured:true,visible:true,expected:"Tunnel not found"},
  {connection:{state:"failed",errorCode:"NETWORK_ERROR"},configured:true,visible:true,expected:"Network error"},
  {connection:{state:"ready"},configured:true,visible:false,expected:"tunnel_1234"}
]) {
  const nodes={"tunnel-status":{className:""},"tunnel-status-value":{textContent:""},"tunnel-help":{hidden:true}};
  render({connection,configured,tunnelId:"tunnel_1234"},nodes);
  assert.equal(nodes["tunnel-help"].hidden,!visible);
  assert.equal(nodes["tunnel-status-value"].textContent,expected);
}
console.log("Tunnel Help visibility states: ok");

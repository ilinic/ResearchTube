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
assert.equal(paths.length,5);
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

import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const root = p => new URL("../" + p, import.meta.url);
const [popup, script, settings, guide, style] = await Promise.all(
  ["popup.html","popup.js","onboarding.html","onboarding.js","onboarding.css"].map(p => readFile(root(p),"utf8")));
assert.match(popup,/id="tunnel-help"[^>]*hidden>Help/);
assert.match(script,/notConfigured = !state\.configured/);
assert.match(script,/tunnel-status-value/);
assert.match(script,/getURL\("onboarding.html"\) \+ "#setup-guide"/);
assert.match(settings,/<details id="setup-guide" class="setup-guide">/);
assert.doesNotMatch(settings,/<details id="setup-guide"[^>]*open\b/);
assert.match(guide,/guide\.open = true/);
assert.match(guide,/scrollIntoView/);
assert.match(style,/\.setup-image img/);
const paths=[...settings.matchAll(/src="(images\/setup-[^"]+\.png)"/g)].map(x=>x[1]);
assert.equal(paths.length,5);
for (const path of paths) {const img=await readFile(root(path));assert.equal(img.subarray(0,8).toString("hex"),"89504e470d0a1a0a");}
console.log("Setup guide: ok");

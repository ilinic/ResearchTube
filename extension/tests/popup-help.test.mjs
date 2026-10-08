import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
const bundle = await readFile(new URL("../dist/background.js", import.meta.url), "utf8");
const guide = await readFile(new URL("../../docs/HELP.md", import.meta.url), "utf8");
const guideUrl = source.match(/const RESEARCHTUBE_HELP_GUIDE_URL = "([^"]+)";/)[1];
assert.equal(guideUrl, "https://github.com/ilinic/ResearchTube/blob/main/docs/HELP.md");
const prompt = source.match(/const RESEARCHTUBE_HELP_PROMPT = `([^`]+)`;/)[1].replace("${RESEARCHTUBE_HELP_GUIDE_URL}", guideUrl);
assert.ok(prompt.length < 300);
assert.match(prompt, /in my language/);
assert.match(prompt, /setup, usage and troubleshooting/);
assert.doesNotMatch(prompt, /@ResearchTube|sessionId|tabId/);
for (const topic of ["Developer Mode", "Plus", "Tunnels Read + Use", "--silent-debugger-extension-api", "Shortcut → Target", "system_agent_status", "site_get_images", "Custom Tools"]) assert.ok(guide.includes(topic), topic);

for (const [name, script] of [["source", source], ["bundle", bundle]]) {
  const start = script.indexOf("async function openResearchTubeHelp()");
  const end = script.indexOf("function cdpAttachmentStateExpression", start);
  assert.ok(start > 0 && end > start, name);
  const fn = script.slice(start, end);
  assert.doesNotMatch(fn, /browserAgent|agentJsonRequest|getSettings|storedServiceTab|startComposerWatchdog/, "help startup must not depend on the research connection or start an ongoing watchdog");
  async function run({ failAt, navigated = false, edited = false } = {}) {
    const events = []; let sends = 0;
    const record = async (label, id) => { events.push([label, id]); if (failAt === label) throw new Error(label); };
    const context = {
      EXTERNAL_URLS: { chatgptNewChat: "https://chatgpt.com/" }, RESEARCHTUBE_HELP_PROMPT: prompt,
      chrome: { tabs: { create: async options => { events.push(["create", JSON.parse(JSON.stringify(options))]); return { id: 77 }; } } },
      waitForChatGPTTab: async id => { await record("load", id); return { id }; },
      cdpAttach: id => record("attach", id), cdpDetach: id => record("detach", id),
      cdpCommand: (id, method) => record(method, id), cdpPrepareBackgroundChat: id => record("prepare", id),
      cdpWaitForTextComposer: id => record("composer", id),
      requireCurrentChatTarget: async target => { assert.equal(target.tabId, 77); assert.equal(target.newChat, true); assert.equal(target.chatPath, "/"); await record("guard", target.tabId); if (navigated) throw new Error("navigation"); },
      prepareCurrentChatComposer: async (target, policy) => { assert.equal(policy, "clear"); await record("clear", target.tabId); },
      cdpSetComposerText: async (id, text) => { assert.equal(text, prompt); await record("insert", id); },
      cdpComposerTextExpression: text => text,
      cdpEvaluate: async id => { await record("verify", id); return { value: !edited }; },
      cdpSendComposerText: async (id, text, guard) => { assert.equal(text, prompt); await guard(); await record("send", id); sends++; },
      cdpLog: () => {}, cdpError: message => new Error(message), localAgentError: (_code, message) => new Error(message),
    };
    vm.runInNewContext(fn + "\nglobalThis.openHelp = openResearchTubeHelp;", context);
    let result, error;
    try { result = await context.openHelp(); } catch (caught) { error = caught; }
    return { events, sends, result, error };
  }
  const ok = await run();
  assert.equal(ok.error, undefined, name);
  assert.equal(ok.result.chatTabId, 77);
  assert.equal(ok.sends, 1);
  assert.deepEqual(ok.events[0], ["create", { url: "https://chatgpt.com/", active: true }]);
  assert.equal(ok.events.at(-1)[0], "detach");
  assert.ok(ok.events.every(([label, id]) => label === "create" || id === 77), "only the owned new tab is addressed");
  for (const failure of [{ failAt: "composer" }, { failAt: "insert" }, { navigated: true }, { edited: true }, { failAt: "send" }]) {
    const failed = await run(failure);
    assert.ok(failed.error, name + JSON.stringify(failure));
    assert.equal(failed.sends, 0);
    assert.equal(failed.events.at(-1)[0], "detach");
    if (failure.navigated) assert.ok(!failed.events.some(([label]) => label === "clear" || label === "insert"));
  }
  const noAttach = await run({ failAt: "attach" });
  assert.ok(noAttach.error); assert.equal(noAttach.sends, 0);
  assert.ok(!noAttach.events.some(([label]) => label === "detach"));
}

// Exercise the actual internal message handler's popup-only authorization.
const handlerStart = source.indexOf('if (message?.type === "open-help")');
const handlerEnd = source.indexOf('if (message?.type === "study-site")', handlerStart);
const handler = source.slice(handlerStart, handlerEnd);
let launches = 0, response;
const context = {
  chrome: { runtime: { id: "extension", getURL: name => "chrome-extension://extension/" + name } },
  openResearchTubeHelp: async () => { launches++; return { ok: true }; },
  cdpErrorLog() {}, safeErrorMessage: error => String(error),
};
vm.runInNewContext("globalThis.handle = function(message,sender,sendResponse){" + handler + "};", context);
for (const sender of [{ id: "page" }, { id: "extension", tab: { id: 1 }, url: "chrome-extension://extension/popup.html" }, { id: "extension", url: "chrome-extension://extension/settings.html" }]) {
  assert.equal(context.handle({ type: "open-help" }, sender, value => { response = value; }), false);
  assert.equal(response.ok, false);
}
assert.equal(launches, 0);
assert.equal(context.handle({ type: "open-help" }, { id: "extension", url: "chrome-extension://extension/popup.html" }, value => { response = value; }), true);
await new Promise(resolve => setImmediate(resolve));
assert.equal(launches, 1); assert.equal(response.ok, true);
console.log("Popup Help: active new chat, fixed concise guide prompt, offline setup, exact-target/edit guards, cleanup and popup sender authorization in source/shipped worker: ok");

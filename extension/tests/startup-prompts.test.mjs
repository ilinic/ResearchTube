import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { DEFAULT_STARTUP_PROMPTS, normalizeStartupPrompts, renderStartupPrompt } from '../startup-prompts.js';
import { fixture } from './fixtures/browser-agent-fixture.mjs';

const config = JSON.parse(await readFile(new URL('../../agent/agent-config.json', import.meta.url), 'utf8'));
for (const [key, value] of Object.entries(DEFAULT_STARTUP_PROMPTS)) {
  assert.equal(config[key].value, value, 'shipped and offline defaults agree');
  assert.match(value, /in English/, 'active prompts explicitly request English');
  assert.equal(config[key + '1'].value, value.replace('in English', 'in my language'), 'original variants remain unchanged');
}
assert.deepEqual(normalizeStartupPrompts(), DEFAULT_STARTUP_PROMPTS);
assert.equal(renderStartupPrompt('describeThisVideoPrompt', { describeThisVideoPrompt: '[video_title]\n[video_link] → [chat_tab_id] [chat_tab_id]' }, {
  video_title: 'Кириллица 🐈 [chat_tab_id] $&', video_link: 'https://www.youtube.com/watch?v=MxJLoHLhlQM', chat_tab_id: 22
}), 'Кириллица 🐈 [chat_tab_id] $&\nhttps://www.youtube.com/watch?v=MxJLoHLhlQM → 22 22', 'substituted values are literal and never expanded again');
assert.equal(renderStartupPrompt('studyThisSitePrompt', { studyThisSitePrompt: 'Plain text [not a placeholder]' }, {}), 'Plain text [not a placeholder]');
for (const input of [null, [], { extra: 'text' }, { studyThisSitePrompt: '' }, { studyThisSitePrompt: 3 }, { studyThisSitePrompt: 'x'.repeat(16001) }, { studyThisSitePrompt: '[video_link]' }, { describeThisVideoPrompt: '[session_id]' }]) {
  assert.throws(() => normalizeStartupPrompts(input), e => e.code === 'AGENT_INVALID_RESPONSE');
}
assert.equal(normalizeStartupPrompts({ studyThisSitePrompt: '🐈'.repeat(16000) }).studyThisSitePrompt.length, 32000);
assert.throws(() => renderStartupPrompt('describeThisVideoPrompt', {}, {}), e => e.code === 'AGENT_INVALID_RESPONSE');

const site = fixture();
site.host.promptTemplates = async () => ({ studyThisSitePrompt: 'Исследуй [site_title]\n[site_link] site=[site_tab_id] chat=[chat_tab_id] group=[group_id]' });
await site.agent.start(10);
assert.equal(site.events.find(e => e[0] === 'prompt')[2], 'Исследуй Site\nhttps://site.test/article site=21 chat=22 group=100');
site.host.promptTemplates = async () => ({ studyThisSitePrompt: 'Updated chat=[chat_tab_id]' });
await site.agent.start(10);
assert.equal(site.events.filter(e => e[0] === 'prompt').at(-1)[2], 'Updated chat=24', 'new launches use the current Agent snapshot');
const badSite = fixture();
badSite.host.promptTemplates = async () => ({ studyThisSitePrompt: '[typo]' });
await assert.rejects(badSite.agent.start(10), e => e.code === 'AGENT_INVALID_RESPONSE');
assert.ok(!badSite.events.some(e => e[0] === 'duplicate' || e[0] === 'createChat'), 'invalid template creates no tabs');

// Exercise the actual bundled popup video path, including config reads and Send.
const event = { addListener() {} };
const context = vm.createContext({ URL, Intl, TextEncoder, TextDecoder, AbortController, crypto: webcrypto,
  setTimeout, clearTimeout, console: { info() {} },
  chrome: { runtime: { getManifest: () => ({ version: '9.8.7' }), id: 'extension', getURL: p => p, onInstalled: event, onStartup: event, onMessage: event },
    tabs: {}, alarms: { onAlarm: event }, storage: { local: { get: async () => ({}) } } }
});
vm.runInContext(await readFile(new URL('../dist/background.js', import.meta.url), 'utf8'), context);
const requests = [], sent = [], created = [];
let supplied = { describeThisVideoPrompt: 'Describe [video_title]\n[video_link] chat=[chat_tab_id]' }, nextTab = 72;
context.agentJsonRequest = async path => { requests.push(path); return supplied; };
context.chrome.tabs.create = async options => { created.push(options); return { id: nextTab++ }; };
context.waitForChatGPTTab = async id => ({ id });
for (const name of ['cdpAttach', 'cdpDetach', 'cdpCommand', 'cdpPrepareBackgroundChat', 'cdpWaitForTextComposer', 'prepareCurrentChatComposer', 'sleep', 'requireCurrentChatTarget', 'startComposerWatchdog']) context[name] = async () => {};
context.cdpSetComposerText = async (id, prompt) => sent.push(['insert', id, prompt]);
context.cdpEvaluate = async () => ({ value: true });
context.cdpSendComposerText = async (id, prompt, guard) => { await guard(); sent.push(['send', id, prompt]); };
const source = { id: 10, index: 3, title: 'Песня 🐈 - YouTube', url: 'https://www.youtube.com/watch?v=MxJLoHLhlQM&feature=share' };
await context.describeYouTubeVideoInChatGPT(source);
assert.deepEqual(requests, ['/internal/prompt-templates']);
assert.deepEqual(sent, [['insert', 72, 'Describe Песня 🐈\nhttps://www.youtube.com/watch?v=MxJLoHLhlQM chat=72'], ['send', 72, 'Describe Песня 🐈\nhttps://www.youtube.com/watch?v=MxJLoHLhlQM chat=72']]);
assert.equal(created[0].active, false);
supplied = { describeThisVideoPrompt: 'Updated [video_link] [chat_tab_id]' };
await context.describeYouTubeVideoInChatGPT({ ...source, url: 'https://www.youtube.com/shorts/abcdefghijk' });
assert.equal(sent.at(-1)[2], 'Updated https://www.youtube.com/watch?v=abcdefghijk 73');

for (const code of ['AGENT_UNAVAILABLE', 'NOT_FOUND']) {
  context.agentJsonRequest = async () => { throw Object.assign(new Error('Unavailable'), { code }); };
  assert.deepEqual(JSON.parse(JSON.stringify(await context.configuredStartupPrompts())), DEFAULT_STARTUP_PROMPTS);
}
context.agentJsonRequest = async () => ({});
assert.deepEqual(JSON.parse(JSON.stringify(await context.configuredStartupPrompts())), DEFAULT_STARTUP_PROMPTS);
for (const code of ['CONFIG_INVALID', 'AGENT_INVALID_RESPONSE']) {
  context.agentJsonRequest = async () => { throw Object.assign(new Error('Invalid'), { code }); };
  await assert.rejects(context.configuredStartupPrompts(), e => e.code === code);
}
context.agentJsonRequest = async () => ({ describeThisVideoPrompt: '[typo]' });
await assert.rejects(context.describeYouTubeVideoInChatGPT({ ...source, url: 'https://www.youtube.com/watch?v=12345678901' }), e => e.code === 'AGENT_INVALID_RESPONSE');
assert.equal(created.length, 2, 'invalid video template creates no chat');
console.log('configured startup prompts: ok');

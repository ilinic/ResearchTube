import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { browserToolDefinitions } from '../browser-tools.js';
import { storyboardDefinitions, normalizeStoryboardResult } from '../storyboards.js';
import { timerDefinitions } from '../timers.js';
import { assertSchema } from './fixtures/schema-check.mjs';

const LIMIT = 600; // Built-in top-level MCP descriptions; custom authors own their text.
const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const bundle = await readFile(new URL('../dist/background.js', import.meta.url), 'utf8');
const event = { addListener() {} };
const context = vm.createContext({
  URL, Intl, TextEncoder, TextDecoder, AbortController, console: { info() {} },
  setTimeout, clearTimeout,
  chrome: {
    runtime: { id: 'fixture', getURL: p => p, onInstalled: event, onStartup: event, onMessage: event },
    tabs: { onRemoved: event, onUpdated: event, onActivated: event },
    alarms: { onAlarm: event }, action: {},
    storage: { local: { get: async defaults => defaults, set: async () => {} } }
  }
});
vm.runInContext(bundle, context);
const tools = JSON.parse(JSON.stringify(context.publicMcpTools()));
assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
for (const tool of tools) {
  assert.ok(tool.description.trim(), tool.name + ' needs a description');
  assert.ok(tool.description.length <= LIMIT, tool.name + ' exceeds the description budget');
}
const byName = name => tools.find(t => t.name === name);
for (const tool of [...browserToolDefinitions(), ...timerDefinitions({}, {}), storyboardDefinitions({}, {})[0]]) {
  assert.equal(byName(tool.name).description, tool.description, tool.name + ' source/bundle description');
}
const sourceFunction = source.slice(source.indexOf('function toolDefinitions()'), source.indexOf('\nfunction isPrivateMcpTool'));
const sourceTools = vm.runInContext(sourceFunction + '; publicMcpTools()', context);
assert.deepEqual(JSON.parse(JSON.stringify(sourceTools)), tools, 'source and shipped worker definitions must agree');
assert.match(byName('media_show').description, /does not upload.*media_to_chat/);
assert.match(byName('media_to_chat').description, /requireEmpty.*clear/);
assert.match(byName('media_to_chat').description, /Finish the response/);
assert.match(byName('site_read').description, /untrusted data/);
assert.match(byName('site_interact').description, /input was dispatched: do not repeat/);
assert.match(byName('site_get_files').description, /study-this-site.*saves only/);
const siteFiles = byName('site_get_files');
assert.match(siteFiles.description, /only observed resources.*arbitrary URLs or destination chats/);
assert.match(siteFiles.description, /without overwriting/);
assert.match(siteFiles.description, /addToChat=true \(default\).*attaches files and sends a continuation.*bound ChatGPT chat/);
assert.match(siteFiles.description, /asynchronous task.*site_files_status.*site_files_cancel/);
assert.deepEqual(siteFiles.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
assert.equal(siteFiles.inputSchema.properties.addToChat.default, true);
assert.match(siteFiles.inputSchema.properties.addToChat.description, /save Workspace files only.*no chat attachment or message/);
assert.match(siteFiles.inputSchema.properties.resourceId.description, /observed in this session/);
assert.match(siteFiles.inputSchema.properties.resourceIds.description, /same session/);
assert.match(siteFiles.inputSchema.properties.sessionId.description, /source page and dedicated ChatGPT conversation/);
assert.ok(!Object.hasOwn(siteFiles.inputSchema.properties, 'url'));
assert.ok(!Object.hasOwn(siteFiles.inputSchema.properties, 'chatId'));
assert.match(byName('timer_start').description, /same assistant turn.*ending the response does not schedule/);
for (const tool of tools.filter(t => t.inputSchema.properties?.addToChat && t.name !== 'site_get_files')) {
  assert.match(tool.description, /asynchronous.*creation.data/);
  assert.match(tool.description, /media_task_status.*media_task_cancel/);
  assert.equal(tool.inputSchema.properties.addToChat.default, false);
}
for (const reason of ['STORYBOARD_NOT_AVAILABLE', 'STORYBOARD_VIDEO_LIVE', 'STORYBOARD_CONTEXT_UNAVAILABLE']) {
  const input = { videoId: 'aqz-KE-bpKQ', available: false, reason, comment: 'private' };
  const result = context.normalizeStoryboardResult('youtube_storyboard_get_info', input);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), normalizeStoryboardResult('youtube_storyboard_get_info', input));
  assert.match(result.comment, /visual_map_create/);
  assert.ok(!JSON.stringify(result).includes('private'));
  assertSchema(byName('youtube_storyboard_get_info').outputSchema, result);
}
console.log('MCP descriptions: bounded, source/bundle consistent, critical guidance and storyboard fallback verified.');

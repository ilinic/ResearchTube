import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createChatBindings, needsChatTarget, chatToolDefinitions } from '../chat-bindings.js';

const key = 'a'.repeat(64), other = 'b'.repeat(64);
function fixture() {
  let time = 1000, sequence = 0, valid = true, tabId = 7, pins = 0;
  const timers = new Map();
  const target = { tabId, bindingId: randomUUID(), documentId: 'doc', conversationId: 'chat' };
  const host = { now: () => time, id: () => `tsk_${String(++sequence).padStart(10, '0')}`, uuid: randomUUID, extensionId: 'extension', isChat: url => url === 'https://chatgpt.com/c/chat',
    setTimeout: fn => { const id = randomUUID(); timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    pin: async id => { pins++; assert.equal(id, tabId); return { ...target, tabId }; },
    verify: async value => { if (!valid || value.documentId !== target.documentId) throw Object.assign(new Error('changed'), { code: 'BROWSER_TARGET_CHANGED' }); },
    live: () => { if (!valid) throw Error('changed'); }, connectGroup: async () => ({ group: { groupId: 9 } }) };
  const manager = createChatBindings(host);
  const sender = () => ({ id: 'extension', tab: { id: tabId, url: 'https://chatgpt.com/c/chat' } });
  return { manager, host, timers, sender, pins: () => pins, expire: () => { time += 30001; }, invalidate: () => { valid = false; },
    restore: () => { valid = true; tabId = 81; target.tabId = 81; target.documentId = 'new-doc'; target.bindingId = randomUUID(); } };
}
const bind = async (f, session = key) => { const started = await f.manager.start(session); await f.manager.bind(started.metadata, f.sender()); return started; };
{
  const f = fixture();
  assert.equal(await f.manager.target(key), null);
  const started = await f.manager.start(key);
  assert.equal(started.task.phase, 'awaitingChat'); assert.equal(f.pins(), 0);
  assert.doesNotMatch(JSON.stringify(started.task), /bindingToken|documentId|conversationId|aaaaaa/);
  assert.deepEqual((await f.manager.start(key)).metadata, started.metadata, 'concurrent starts reuse pending capability');
  await assert.rejects(f.manager.bind({ ...started.metadata, bindingToken: randomUUID() }, f.sender()));
  await assert.rejects(f.manager.bind(started.metadata, { ...f.sender(), id: 'other-extension' }));
  await assert.rejects(f.manager.bind(started.metadata, { id: 'extension', tab: { id: 7, url: 'chrome-extension://extension/settings.html' } }), { code: 'CHAT_BINDING_INVALID' });
  await assert.rejects(f.manager.bind(started.metadata, { id: 'extension', tab: { id: 7, url: 'https://chatgpt.com/' } }), { code: 'CHAT_BINDING_NOT_READY' });
  assert.equal(f.manager.status(started.task.taskId, key).status, 'working', 'new chat URL can settle within the binding deadline');
  await f.manager.bind(started.metadata, f.sender());
  assert.equal(f.manager.status(started.task.taskId, key).status, 'completed');
  assert.equal((await f.manager.target(key)).tabId, 7);
  assert.equal(await f.manager.target(other), null, 'different conversation cannot inherit a target');
  assert.throws(() => f.manager.status(started.task.taskId, other));
  assert.equal((await f.manager.start(key)).metadata, null, 'valid connection needs no new widget capability');
  await f.manager.bind(started.metadata, f.sender());
  await assert.rejects(f.manager.bind(started.metadata, { id: 'extension', tab: { id: 8, url: 'https://chatgpt.com/c/chat' } }), { code: 'BROWSER_TARGET_MISMATCH' });
  f.invalidate(); assert.equal(await f.manager.target(key), null);
  f.restore(); const replacement = await bind(f);
  assert.equal((await f.manager.target(key)).tabId, 81, 'renumbered Chrome tab binds by fresh sender, without old tab ID');
  assert.notEqual(replacement.metadata.bindingToken, started.metadata.bindingToken);
  f.manager.reset(); assert.equal(await f.manager.target(key), null, 'socket/worker restart never reuses old documents');
}
for (const action of ['expire', 'cancel', 'reset']) {
  const f = fixture(), started = await f.manager.start(key);
  if (action === 'cancel') assert.equal(f.manager.cancel(started.task.taskId, key).cancelled, true);
  else if (action === 'expire') f.expire(); else f.manager.reset();
  await assert.rejects(f.manager.bind(started.metadata, f.sender()));
  assert.equal(await f.manager.target(key), null);
}
{
  const f = fixture(), started = await f.manager.start(key); let release;
  f.host.pin = () => new Promise(resolve => { release = resolve; });
  const binding = f.manager.bind(started.metadata, f.sender());
  f.manager.cancel(started.task.taskId, key); release({ tabId: 7 });
  await assert.rejects(binding); assert.equal(await f.manager.target(key), null, 'cancellation during Chrome I/O wins');
}
assert.equal(needsChatTarget('youtube_get_transcript', {}), false);
assert.equal(needsChatTarget('media_capture_frame', { addToChat: false }), false);
assert.equal(needsChatTarget('media_capture_frame', { addToChat: true }), true);
assert.equal(needsChatTarget('site_read', {}), true);
assert.equal(needsChatTarget('media_view', {}), true);
assert.equal(needsChatTarget('timer_start', { notifyInChat: true }), true);
await assert.rejects(fixture().manager.start(undefined), { code: 'CHAT_SESSION_UNAVAILABLE' });
const transformed = chatToolDefinitions([{ name: 'media_view', inputSchema: { properties: { tabId: {} } }, _meta: { ui: { resourceUri: 'ui://researchtube/chat-target-v9.html' }, 'openai/outputTemplate': 'ui://researchtube/chat-target-v9.html' } }]);
assert.equal(transformed[0]._meta.ui, undefined); assert.equal(transformed[0].inputSchema.properties.tabId, undefined);
console.log('Lazy chat bindings: session isolation, sender authority, reuse, restart, expiry and cancellation passed');

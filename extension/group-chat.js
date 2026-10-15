import { browserError } from './browser-tools.js';

export function isGroupChatView(tab) {
  try {
    const url = new URL(tab.url);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && /^\/group-chat\/gc_[A-Za-z0-9_-]{22}\/?$/.test(url.pathname);
  } catch { return false; }
}
const id = value => Number.isSafeInteger(value) && value >= 0;
const uuid = () => crypto.randomUUID().replaceAll('-', '');
const roomPattern = /^gc_[A-Za-z0-9_-]{22}$/;
const invalid = () => { throw browserError('AGENT_INVALID_RESPONSE', 'Invalid Board response.'); };

export function normalizeGroupHistory(data) {
  if (!data || !Array.isArray(data.entries) || data.entries.length > 100 || !id(data.latestId) ||
      typeof data.hasMore !== 'boolean' || typeof data.hasOlder !== 'boolean' ||
      ![data.firstId, data.lastId].every(value => value === null || id(value))) invalid();
  let previous = 0;
  const entries = data.entries.map(entry => {
    if (!entry || !id(entry.id) || entry.id <= previous || entry.id > data.latestId || !id(entry.senderTabId) ||
        typeof entry.time !== 'string' || entry.time.length > 40 || !Number.isFinite(Date.parse(entry.time)) ||
        typeof entry.text !== 'string' || entry.text.length > 24000) invalid();
    previous = entry.id;
    return { id: entry.id, time: entry.time, senderTabId: entry.senderTabId, text: entry.text };
  });
  if (entries.length && (data.firstId !== entries[0].id || data.lastId !== entries.at(-1).id) || !entries.length && data.firstId !== null) invalid();
  const result = { entries, firstId: data.firstId, lastId: data.lastId, latestId: data.latestId, hasMore: data.hasMore, hasOlder: data.hasOlder };
  // Preserve the existing one-whole-publication exception for heavily escaped
  // text. Never acknowledge a cursor and then reject its valid single entry.
  if (JSON.stringify(result).length > (entries.length === 1 ? 75000 : 33000)) invalid();
  return result;
}

export function createGroupChatController(host) {
  const syncing = new Map();
  const call = (action, body) => {
    if (!host.groupChatRequest) throw browserError('AGENT_UNAVAILABLE', 'Shared Board requires the Local Agent.');
    return host.groupChatRequest(action, body, { timeoutMs: ['sync', 'summary'].includes(action) ? 2000 : 10000 });
  };
  async function sync(group) {
    const work = (syncing.get(group.groupId) || Promise.resolve()).catch(() => {}).then(async () => {
      const members = [...group.members.values()].filter(tab => !isGroupChatView(tab)).map(tab => ({
        tabId: tab.id, role: /^https:\/\/chatgpt\.com(?:\/|$)/.test(tab.url || '') ? 'chatgpt' : 'site',
        title: String(tab.title || '').slice(0, 200), url: host.safeUrl(tab.url).slice(0, 600),
        chatPath: (host.conversationPath(tab.url) || '').slice(0, 200)
      }));
      const signature = JSON.stringify([members, group.state, Boolean(group.freshJournal), Boolean(group.resumeJournal)]);
      if (group.roomId && group.boardSnapshot === signature) return;
      const snapshotId = uuid();
      let result;
      for (let offset = 0; offset < members.length || offset === 0; offset += 8) {
        result = await call('sync', {
          owner: host.owner || 'researchtube', chromeGroupId: group.groupId, roomId: group.roomId || null,
          snapshotId, offset, members: members.slice(offset, offset + 8), complete: offset + 8 >= members.length,
          state: group.state, fresh: Boolean(group.freshJournal), resume: Boolean(group.resumeJournal)
        });
      }
      if (!result || !roomPattern.test(result.roomId) || !['starting', 'running', 'idle', 'stopped', 'failed'].includes(result.state)) invalid();
      group.roomId = result.roomId; group.freshJournal = false; group.resumeJournal = false;
      if (['stopped', 'failed'].includes(result.state)) group.state = group.phase = result.state;
      group.boardSnapshot = JSON.stringify([members, group.state, false, false]);
    });
    syncing.set(group.groupId, work);
    try { return await work; } finally { if (syncing.get(group.groupId) === work) syncing.delete(group.groupId); }
  }
  async function identity(group, chatTabId) {
    const chatPath = group.members.get(chatTabId)?.chatPath;
    await host.check(group, chatTabId, chatPath, { allowStopped: true });
    await sync(group);
    await host.check(group, chatTabId, chatPath, { allowStopped: true });
    return { roomId: group.roomId, chatTabId, chatPath };
  }
  async function post(group, input) {
    const context = await identity(group, input.chatTabId);
    const { chatTabId, ...rest } = context;
    const result = await call('post', { ...rest, senderTabId: chatTabId, text: input.text, requestId: uuid() });
    if (result?.status !== 'recorded' || !id(result.messageId) || result.messageId < 1) invalid();
    return { chatTabId, groupId: group.groupId, messageId: result.messageId, status: 'recorded' };
  }
  async function read(group, input) {
    const context = await identity(group, input.chatTabId);
    const data = await call('read', { ...context, ...Object.fromEntries(['afterId', 'beforeId', 'limit'].filter(key => input[key] !== undefined).map(key => [key, input[key]])) });
    return { chatTabId: input.chatTabId, groupId: group.groupId, ...normalizeGroupHistory(data) };
  }
  async function summary(group, chatTabId) {
    const context = await identity(group, chatTabId);
    const data = await call('summary', context);
    if (!data || !id(data.unreadCount) || !id(data.latestId)) invalid();
    return data.unreadCount ? { unreadCount: data.unreadCount, latestId: data.latestId } : null;
  }
  async function open(group, chatTabId) {
    if (chatTabId !== undefined) await identity(group, chatTabId);
    else await sync(group); // Explicit startup before either chat has been saved.
    const tab = await host.openGroupView(group, group.roomId);
    if (!id(tab?.id)) invalid();
    return { groupId: group.groupId, tabId: tab.id };
  }
  return { sync, post, read, summary, open };
}

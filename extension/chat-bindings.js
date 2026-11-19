import { pruneCompletedTasks } from './task-history.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const SESSION = /^[a-f0-9]{64}$/;

// A session is a routing hint, never authority to pick a Chrome tab. Only the
// capability returned to our widget plus Chrome's sender identity can bind it.
export function createChatBindings(host) {
  const sessions = new Map(), tasks = new Map();
  const now = () => host.now();
  function session(value) {
    if (typeof value !== 'string' || !SESSION.test(value)) throw fail('CHAT_SESSION_UNAVAILABLE', 'This MCP client did not supply conversation metadata. Chat-targeted actions require ChatGPT conversation metadata.');
    return value;
  }
  function finish(task, status, code = null) {
    task.status = status; task.phase = status;
    if (status === 'completed') task.progressPercent = 100;
    task.error = code ? { code, message: 'The chat connection ended. No alternate tab was selected.' } : null;
    task.updatedAt = new Date(now()).toISOString();
    host.clearTimeout(task.timer); task.timer = null;
  }
  function expire(task) {
    if (task.status === 'working' && task.deadline <= now()) finish(task, 'failed', 'CHAT_BINDING_TIMEOUT');
  }
  function document(task) {
    expire(task);
    return { taskId: task.taskId, status: task.status, phase: task.phase, progressPercent: task.progressPercent,
      pollIntervalMs: 500, chatTabId: task.target?.tabId ?? null, group: task.group ?? null, error: task.error };
  }
  function own(taskId, key) {
    const task = tasks.get(taskId);
    if (!task || task.session !== session(key)) throw fail('CHAT_BINDING_NOT_FOUND', 'The chat connection task was not found in this conversation.');
    return task;
  }
  async function target(key) {
    const value = sessions.get(session(key));
    if (!value) return null;
    try { await host.verify(value); return value; }
    catch { sessions.delete(key); return null; }
  }
  async function start(key, resumeGroup = false) {
    session(key);
    const bound = await target(key);
    if (bound) {
      const task = { taskId: host.id(), session: key, status: 'completed', phase: 'completed', progressPercent: 100,
        createdAt: new Date(now()).toISOString(),
        target: bound, group: resumeGroup ? (await host.connectGroup(bound.tabId, () => host.live(bound))).group : null };
      await host.verify(bound); tasks.set(task.taskId, task); pruneCompletedTasks(tasks, 200);
      return { task: document(task), metadata: null };
    }
    for (const task of tasks.values()) {
      expire(task);
      if (task.session === key && task.status === 'working') {
        task.resumeGroup ||= resumeGroup;
        return { task: document(task), metadata: metadata(task) };
      }
    }
    pruneCompletedTasks(tasks, 200);
    if ([...tasks.values()].filter(task => task.status === 'working').length >= 100) throw fail('BROWSER_BUSY', 'Too many chat connections are pending.');
    const task = { taskId: host.id(), session: key, resumeGroup, token: host.uuid(), deadline: now() + 30000,
      status: 'working', phase: 'awaitingChat', progressPercent: 0, target: null, group: null, error: null,
      createdAt: new Date(now()).toISOString() };
    task.timer = host.setTimeout(() => expire(task), 30000); tasks.set(task.taskId, task);
    return { task: document(task), metadata: metadata(task) };
  }
  function metadata(task) { return { taskId: task.taskId, bindingToken: task.token, mode: 'connection' }; }
  async function bind(message, sender) {
    const task = tasks.get(message?.taskId);
    let origin;
    try { origin = new URL(sender?.tab?.url).origin; } catch { /* refused below */ }
    if (!task || Object.keys(message).some(key => !['type', 'taskId', 'bindingToken', 'mode'].includes(key)) ||
        message.mode !== 'connection' || task.token !== message.bindingToken ||
        sender?.id !== host.extensionId || !Number.isSafeInteger(sender.tab?.id) || origin !== 'https://chatgpt.com')
      throw fail('CHAT_BINDING_INVALID', 'A valid widget capability and Chrome sender are required.');
    expire(task);
    if (task.status === 'working' && !host.isChat(sender.tab.url)) throw fail('CHAT_BINDING_NOT_READY', 'Waiting for the saved ChatGPT conversation.');
    if (task.status === 'completed') {
      if (task.target.tabId !== sender.tab.id) throw fail('BROWSER_TARGET_MISMATCH', 'The connection belongs to another tab.');
      await host.verify(task.target); return { ok: true };
    }
    if (task.status !== 'working') throw fail('CHAT_BINDING_EXPIRED', 'The connection task ended.');
    if (task.binding) {
      if (task.bindingTab !== sender.tab.id) throw fail('BROWSER_TARGET_MISMATCH', 'Another tab is binding this capability.');
      return task.binding;
    }
    task.bindingTab = sender.tab.id;
    const work = async () => {
      const bound = await host.pin(sender.tab.id, sender.tab.url);
      expire(task);
      if (task.status !== 'working') throw fail('CHAT_BINDING_EXPIRED', 'The connection task ended.');
      const previous = sessions.get(task.session);
      if (previous && previous.bindingId !== bound.bindingId) {
        try { await host.verify(previous); throw fail('BROWSER_CONTEXT_AMBIGUOUS', 'This session is already bound to another document.'); }
        catch (error) { if (error.code === 'BROWSER_CONTEXT_AMBIGUOUS') throw error; }
      }
      task.target = bound;
      if (task.resumeGroup) task.group = (await host.connectGroup(bound.tabId, () => {
        expire(task); if (task.status !== 'working') throw fail('CHAT_BINDING_EXPIRED', 'The connection task ended.'); host.live(bound);
      })).group;
      await host.verify(bound); expire(task);
      if (task.status !== 'working') throw fail('CHAT_BINDING_EXPIRED', 'The connection task ended.');
      sessions.set(task.session, bound); finish(task, 'completed');
      return { ok: true };
    };
    task.binding = work().catch(error => {
      if (task.status === 'working' && error.code === 'BROWSER_CONTEXT_REQUIRED') throw fail('CHAT_BINDING_NOT_READY', 'Waiting for a stable ChatGPT document.');
      if (task.status === 'working') finish(task, 'failed', /^[A-Z][A-Z0-9_]+$/.test(error.code || '') ? error.code : 'BROWSER_UNAVAILABLE');
      throw error;
    })
      .finally(() => { task.binding = null; });
    return task.binding;
  }
  function reset() {
    sessions.clear();
    for (const task of tasks.values()) if (task.status === 'working') finish(task, 'failed', 'BROWSER_BINDING_CHANGED');
  }
  return { start, bind, target, reset,
    invalidate: target => { for (const [key, bound] of sessions) if (bound.bindingId === target.bindingId) sessions.delete(key); },
    status: (taskId, key) => document(own(taskId, key)),
    cancel: (taskId, key) => { const task = own(taskId, key); expire(task); const cancelled = task.status === 'working'; if (cancelled) finish(task, 'cancelled'); return { task: document(task), cancelled }; }
  };
}

export function needsChatTarget(name, args) {
  return name.startsWith('site_') || name === 'media_view' || args.addToChat === true || args.notifyInChat === true;
}

// Keep source-site tab IDs (from site_list_tabs) distinct from private chat IDs.
export function chatToolDefinitions(definitions) {
  return definitions.map(value => {
    const tool = JSON.parse(JSON.stringify(value)), properties = tool.inputSchema.properties ?? {};
    if (tool.name.startsWith('site_')) delete properties.chatTabId;
    if (!tool.name.startsWith('site_') && tool.name !== 'system_get_diagnostics') delete properties.tabId;
    tool.inputSchema.required = (tool.inputSchema.required || []).filter(key => Object.hasOwn(properties, key));
    if (tool.name === 'timer_start') properties.notifyInChat = { type: 'boolean', default: false, description: 'Notify this conversation on completion only if idle. Requires an automatic chat connection; default false needs no widget.' };
    if (tool.name !== 'system_get_chat_context' && tool._meta?.['openai/outputTemplate']?.includes('/chat-target-')) {
      delete tool._meta['openai/outputTemplate']; delete tool._meta.ui;
    }
    return tool;
  });
}

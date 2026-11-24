import { browserError } from './browser-tools.js';
import { safePageUrl } from './browser-page.js';

// A loose tab gets its own private scope, not a shared group of all loose tabs.
export const tabScopeKey = tab => Number.isSafeInteger(tab.groupId) && tab.groupId >= 0 ? tab.groupId : -(tab.id + 2);
const webTab = tab => /^https?:\/\//.test(tab.url || '');
export const isChatTab = tab => /^https:\/\/chatgpt\.com(?:\/|$)/.test(tab.url || '');

// Chrome membership defines a shared workspace; each saved ChatGPT tab can call tools and be a target.
export function createBrowserGroups(host) {
  const groups = new Map(), creating = new Map();
  const pathOf = tab => isChatTab(tab) ? host.conversationPath(tab.url) : null;
  async function get(groupId, options) {
    if (groups.has(groupId)) return groups.get(groupId);
    if (!creating.has(groupId)) creating.set(groupId, (async () => {
      const group = { groupId, connected: false, revision: 0, state: 'running', phase: 'running', error: null,
        members: new Map(), targets: new Map(), seen: new Map(), marked: new Map(), chatTabs: [], refreshing: Promise.resolve(),
        options: options || await host.studyOptions(), startup: null };
      groups.set(groupId, group);
      return group;
    })().finally(() => creating.delete(groupId)));
    return creating.get(groupId);
  }
  async function saveState(group) {
    if (!group.connected || group.groupId < 0) return;
    const record = { groupId: group.groupId, state: group.state };
    const signature = JSON.stringify(record);
    for (const tab of group.chatTabs) {
      if (group.marked.get(tab.id) === signature) continue;
      try { await host.writeOwner(tab.id, record); group.marked.set(tab.id, signature); }
      catch (error) {
        host.log?.('group state mirror unavailable', {groupId:group.groupId,tabId:tab.id});
      }
    }
  }
  function project(group, chatTabId, offset = 0, limit = 50) {
    const tabs = [...group.members.values()].map(member => {
      const target = group.targets.get(member.id);
      return { tabId: member.id, role: isChatTab(member) ? 'chatgpt' : 'site',
        title: String(member.title || '').slice(0, 500), url: safePageUrl(member.url),
        state: target?.error ? 'failed' : target?.attached ? 'running' : group.state === 'starting' ? 'starting' : 'available', error: target?.error || null };
    });
    const state = group.state === 'running' && !tabs.some(tab => tab.tabId !== chatTabId) ? 'idle' : group.state;
    return { groupId: group.groupId, chatTabId, revision: group.revision, state,
      totalTabs: tabs.length, nextOffset: offset + limit < tabs.length ? offset + limit : null, tabs: tabs.slice(offset, offset + limit), error: group.error };
  }
  function reportChanges(group, chatTabId, full = false) {
    const snapshot = new Map([...group.members.values()].map(tab => [tab.id, {
      tabId: tab.id, role: isChatTab(tab) ? 'chatgpt' : 'site', title: String(tab.title || '').slice(0, 500)
    }]));
    const previous = group.seen.get(chatTabId), chatPath = group.members.get(chatTabId)?.chatPath;
    let groupChanges;
    if (!full) {
      if (!previous || previous.chatPath !== chatPath) groupChanges = {revision:group.revision,resyncRequired:true};
      else {
        const added = [...snapshot.values()].filter(tab => !previous.snapshot.has(tab.tabId));
        const removedTabIds = [...previous.snapshot.keys()].filter(tabId => !snapshot.has(tabId));
        const roleChanged = [...snapshot.values()].some(tab => previous.snapshot.has(tab.tabId) && previous.snapshot.get(tab.tabId).role !== tab.role);
        if (roleChanged) groupChanges = {revision:group.revision,resyncRequired:true};
        else if (added.length || removedTabIds.length) groupChanges = added.length + removedTabIds.length <= 20
          ? {revision:group.revision,added,removedTabIds} : {revision:group.revision,resyncRequired:true};
      }
    }
    const revision = group.revision;
    return { groupChanges, commit() {
      if (group.members.get(chatTabId)?.chatPath !== chatPath) return;
      const current = group.seen.get(chatTabId);
      if (!current || current.chatPath !== chatPath || current.revision <= revision) group.seen.set(chatTabId,{chatPath,revision,snapshot});
    } };
  }
  function acknowledge(group, chatTabId) { reportChanges(group, chatTabId, true).commit(); }
  async function refresh(group, {claimTabId = null, checkPending = () => {}} = {}) {
    const work = group.refreshing.catch(() => {}).then(async () => {
      const queried = group.groupId < 0
        ? [await host.getTab(-group.groupId - 2).catch(() => null)].filter(Boolean)
        : await host.queryTabs(group.groupId);
      const liveTabs = queried.filter(tab => Number.isSafeInteger(tab.id) && tabScopeKey(tab) === group.groupId);
      const tabs = liveTabs.filter(tab => /^https?:\/\//.test(tab.url || ''));
      group.chatTabs = tabs.filter(isChatTab);
      if (!group.connected) {
        const reads = group.groupId < 0 ? [] : await Promise.allSettled(group.chatTabs.map(tab => host.readOwner(tab.id)));
        const records = reads.filter(result => result.status === 'fulfilled').map(result => result.value).filter(record => record?.groupId === group.groupId);
        if (records.length) {
          group.connected = true;
          if (records.some(record => ['stopped','failed','starting'].includes(record.state))) group.state = group.phase = 'stopped';
        } else if (claimTabId !== null) {
          checkPending();
          if (!group.chatTabs.some(tab => tab.id === claimTabId)) throw browserError('TAB_LEFT_GROUP','The initiating chat left its group.');
          group.connected = true;
        }
      }
      const next = new Map(tabs.map(tab => [tab.id,{...tab,chatPath:pathOf(tab)}]));
      const before = group.members;
      const added = [...next.keys()].filter(id => !before.has(id)), removed = [...before.keys()].filter(id => !next.has(id));
      const changedChats = [...next.values()].filter(tab => before.has(tab.id) && before.get(tab.id).chatPath !== tab.chatPath);
      group.members = next;
      for (const id of removed) { group.marked.delete(id); group.seen.delete(id); await host.removed(group,id,'TAB_LEFT_GROUP'); }
      for (const tab of changedChats) { group.seen.delete(tab.id); await host.conversationChanged(group,tab.id); }
      if (group.state === 'starting' && group.startup) {
        // Newly created background tabs can have an empty/about:blank URL until
        // navigation commits. Only actual group departure/closure stops startup;
        // startChat separately verifies the intended origin before typing.
        const startupId = group.startup.chatTabId;
        if (!liveTabs.some(tab => tab.id === startupId)) {
          const live = await host.getTab(startupId).catch(() => null);
          if (!live || live.groupId !== group.groupId) await host.startupLeft(group);
        }
      }
      if (!liveTabs.length && group.state !== 'starting') groups.delete(group.groupId);
      if (added.length || removed.length || [...next.values()].some(tab => before.has(tab.id) && (before.get(tab.id).url !== tab.url || before.get(tab.id).title !== tab.title)) || group.revision === 0) {
        group.revision++;
        host.log?.('group changed',{groupId:group.groupId,revision:group.revision,addedTabIds:added,removedTabIds:removed});
      }
      if (group.connected && !['stopped','failed'].includes(group.state)) await host.updateStatus?.([...next.keys()],{state:group.state,phase:group.phase,statusMessage:'Tab group automation is active.',error:null});
      await saveState(group);
      return group;
    });
    group.refreshing = work.catch(() => {});
    return work;
  }
  async function forChat(chatTabId, {allowStarting = false, claim = false, checkPending} = {}) {
    const tab = await host.getTab(chatTabId).catch(() => { throw browserError('TAB_CLOSED','The initiating ChatGPT tab is closed.'); });
    if (!isChatTab(tab)) throw browserError('BROWSER_INVALID','chatTabId must identify a ChatGPT tab.');
    const group = await get(tabScopeKey(tab));
    await refresh(group, {claimTabId:claim ? chatTabId : null,checkPending});
    if (!group.connected) throw browserError('BROWSER_GROUP_NOT_CONNECTED','Connect this group with system_get_chat_context.');
    const member = group.members.get(chatTabId);
    if (!member || !isChatTab(member)) throw browserError('TAB_LEFT_GROUP','The initiating ChatGPT tab left its group.');
    if (!allowStarting && (!member.chatPath || /\/c\/local-chatgpt(?:%3A|:)/i.test(member.chatPath)))
      throw browserError('BROWSER_SESSION_NOT_READY','Wait for ChatGPT to save this conversation before using site tools.');
    return {group,member};
  }
  async function check(group, tabId, chatPath = null, {allowStopped = false} = {}) {
    if (!allowStopped && ['stopped','failed'].includes(group.state)) throw browserError(group.error?.code || 'BROWSER_SESSION_STOPPED',group.error?.message || 'Group automation stopped. Reconnect the grouped chat with system_get_chat_context.');
    const tab = await host.getTab(tabId).catch(() => {throw browserError('TAB_CLOSED','The selected tab closed; other tabs remain available.');});
    if (tabScopeKey(tab) !== group.groupId) throw browserError('TAB_LEFT_GROUP','The selected tab is no longer in this group.');
    if (chatPath && pathOf(tab) !== chatPath) throw browserError('BROWSER_CHAT_CHANGED','The initiating conversation changed. No replacement destination was selected.');
    if (!/^https?:\/\//.test(tab.url || '')) throw browserError('BROWSER_UNAVAILABLE','Only ordinary HTTP/HTTPS sites can be controlled.');
    return tab;
  }
  async function targetGroup(tab) {
    const group = await get(tabScopeKey(tab));
    await refresh(group);
    await check(group, tab.id);
    if (group.state === 'starting') throw browserError('BROWSER_SESSION_NOT_READY','The selected group is still starting.');
    return group;
  }
  // Metadata only; never attach, activate, or change other tabs during discovery.
  async function inventory(group, offset = 0, limit = 50) {
    const tabs = (await (host.queryAllTabs?.() ?? Promise.resolve([]))).filter(tab => Number.isSafeInteger(tab.id) && (tabScopeKey(tab) !== group.groupId || !webTab(tab)));
    const windowId = tab => Number.isSafeInteger(tab.windowId) ? tab.windowId : -1;
    const groupId = tab => Number.isSafeInteger(tab.groupId) && tab.groupId >= 0 ? tab.groupId : null;
    tabs.sort((a,b) => windowId(a)-windowId(b) || (groupId(a) ?? Number.MAX_SAFE_INTEGER)-(groupId(b) ?? Number.MAX_SAFE_INTEGER) || (a.index ?? a.id)-(b.index ?? b.id) || a.id-b.id);
    const names = new Map((await (host.queryTabGroups?.() ?? Promise.resolve([])).catch(() => [])).map(item => [item.id, String(item.title || '').slice(0,200)]));
    const sections = new Map();
    for (const tab of tabs.slice(offset,offset+limit)) {
      const gid = groupId(tab), wid = windowId(tab), key = wid + ':' + gid;
      if (!sections.has(key)) sections.set(key,{windowId:wid,groupId:gid,title:gid === null ? 'Ungrouped tabs' : names.get(gid) || 'Group ' + gid,tabs:[]});
      const readable = webTab(tab);
      sections.get(key).tabs.push({tabId:tab.id,role:isChatTab(tab)?'chatgpt':'site',title:readable?String(tab.title || '').slice(0,500):'Restricted browser tab',url:readable?safePageUrl(tab.url):'',access:readable?'read-only':'restricted'});
    }
    let hash = 2166136261;
    for (const tab of tabs) for (const c of JSON.stringify([tab.id,windowId(tab),groupId(tab),webTab(tab)?tab.title:null,safePageUrl(tab.url),names.get(groupId(tab))])) hash = Math.imul(hash ^ c.charCodeAt(0),16777619);
    return {revision:hash>>>0,totalTabs:tabs.length,nextOffset:offset+limit<tabs.length?offset+limit:null,sections:[...sections.values()]};
  }
  async function changed() { await Promise.allSettled([...groups.values()].map(group => refresh(group))); }
  function documentChanged(tabId) { for (const group of groups.values()) group.marked.delete(tabId); }
  return {get,forChat,refresh,check,project,reportChanges,acknowledge,saveState,documentChanged,changed,targetGroup,inventory,values:()=>groups.values()};
}

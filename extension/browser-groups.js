import { browserError } from './browser-tools.js';
import { safePageUrl } from './browser-page.js';

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
    if (!group.connected) return;
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
      const tabs = (await host.queryTabs(group.groupId)).filter(tab => Number.isSafeInteger(tab.id) && /^https?:\/\//.test(tab.url || ''));
      group.chatTabs = tabs.filter(isChatTab);
      if (!group.connected) {
        const reads = await Promise.allSettled(group.chatTabs.map(tab => host.readOwner(tab.id)));
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
      if (group.state === 'starting' && group.startup && !isChatTab(next.get(group.startup.chatTabId) || {})) await host.startupLeft(group);
      if (!next.size && !group.chatTabs.length) groups.delete(group.groupId);
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
    if (!Number.isSafeInteger(tab.groupId) || tab.groupId < 0) throw browserError('BROWSER_GROUP_NOT_FOUND','Place the initiating ChatGPT tab and the sites in one Chrome tab group.');
    const group = await get(tab.groupId);
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
    if (tab.groupId !== group.groupId) throw browserError('TAB_LEFT_GROUP','The selected tab is no longer in this group.');
    if (chatPath && pathOf(tab) !== chatPath) throw browserError('BROWSER_CHAT_CHANGED','The initiating conversation changed. No replacement destination was selected.');
    if (!/^https?:\/\//.test(tab.url || '')) throw browserError('BROWSER_UNAVAILABLE','Only ordinary HTTP/HTTPS sites can be controlled.');
    return tab;
  }
  async function changed() { await Promise.allSettled([...groups.values()].map(group => refresh(group))); }
  function documentChanged(tabId) { for (const group of groups.values()) group.marked.delete(tabId); }
  return {get,forChat,refresh,check,project,reportChanges,acknowledge,saveState,documentChanged,changed,values:()=>groups.values()};
}

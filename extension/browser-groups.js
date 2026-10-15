import { browserError } from "./browser-tools.js";
import { isGroupChatView } from "./group-chat.js";
import { safePageUrl } from "./browser-page.js";

export const isChatTab = tab => /^https:\/\/chatgpt\.com(?:\/|$)/.test(tab.url || "");

// Chrome owns membership. Per-conversation reported snapshots are volatile;
// after worker recreation callers receive a passive resync request.
export function createBrowserGroups(host) {
  const groups = new Map(), creating = new Map();
  const pathOf = tab => isChatTab(tab) ? host.conversationPath(tab.url) : null;
  async function get(groupId, options) {
    if (groups.has(groupId)) return groups.get(groupId);
    if (!creating.has(groupId)) creating.set(groupId, (async () => {
      const group = { groupId, revision: 0, state: "running", phase: "running", error: null,
        members: new Map(), targets: new Map(), seen: new Map(), refreshing: Promise.resolve(),
        options: options || await host.studyOptions(), startup: null };
      groups.set(groupId, group);
      return group;
    })().finally(() => creating.delete(groupId)));
    return creating.get(groupId);
  }
  function project(group, offset = 0, limit = 50) {
    const tabs = [...group.members.values()].map(member => {
      const target = group.targets.get(member.id);
      return { tabId: member.id, role: isGroupChatView(member) ? "service" : isChatTab(member) ? "chatgpt" : "site",
        title: String(member.title || "").slice(0, 500), url: safePageUrl(member.url),
        state: target?.error ? "failed" : target?.attached ? "running" : group.state === "starting" ? "starting" : "available",
        error: target?.error || null };
    });
    const state = group.state === "running" && !tabs.some(tab => tab.role === "site") ? "idle" : group.state;
    return { groupId: group.groupId, revision: group.revision, state, totalTabs: tabs.length, nextOffset: offset + limit < tabs.length ? offset + limit : null, tabs: tabs.slice(offset, offset + limit), error: group.error };
  }
  function reportChanges(group, chatTabId, chatPath, full = false) {
    const snapshot = new Map([...group.members.values()].filter(tab => !isGroupChatView(tab)).map(tab => [tab.id, {
      tabId: tab.id, role: isChatTab(tab) ? "chatgpt" : "site", title: String(tab.title || "").slice(0, 500)
    }]));
    const previous = group.seen.get(chatTabId);
    let groupChanges;
    if (!full) {
      if (!previous || previous.chatPath !== chatPath) groupChanges = { revision: group.revision, resyncRequired: true };
      else {
        const added = [...snapshot.values()].filter(tab => !previous.snapshot.has(tab.tabId) || previous.snapshot.get(tab.tabId).role !== tab.role);
        const removedTabIds = [...previous.snapshot.keys()].filter(tabId => !snapshot.has(tabId) || snapshot.get(tabId).role !== previous.snapshot.get(tabId).role);
        if (added.length || removedTabIds.length) {
          // Keep passive metadata small even for arbitrarily large groups.
          groupChanges = added.length + removedTabIds.length <= 20
            ? { revision: group.revision, added, removedTabIds }
            : { revision: group.revision, resyncRequired: true };
        }
      }
    }
    const revision = group.revision;
    return { groupChanges, commit() {
      const current = group.seen.get(chatTabId);
      if (!current || current.chatPath !== chatPath || current.revision <= revision)
        group.seen.set(chatTabId, { chatPath, revision, snapshot });
    } };
  }
  function acknowledge(group, chatTabId) {
    reportChanges(group, chatTabId, group.members.get(chatTabId)?.chatPath, true).commit();
  }
  async function refresh(group) {
    const work = group.refreshing.catch(() => {}).then(async () => {
      const tabs = (await host.queryTabs(group.groupId)).filter(tab => Number.isSafeInteger(tab.id) && /^https?:\/\//.test(tab.url || ""));
      const next = new Map(tabs.map(tab => [tab.id, { ...tab, chatPath: pathOf(tab) }]));
      const before = group.members;
      const added = [...next.keys()].filter(id => !before.has(id));
      const removed = [...before.keys()].filter(id => !next.has(id));
      const changedChats = [...next.values()].filter(tab => before.has(tab.id) && before.get(tab.id).chatPath !== tab.chatPath);
      for (const id of removed) {
        group.seen.delete(id);
        await host.removed(group, id, "TAB_LEFT_GROUP");
      }
      for (const tab of changedChats) { group.seen.delete(tab.id); await host.conversationChanged(group, tab.id); }
      group.members = next;
      if (!next.size) groups.delete(group.groupId);
      if (added.length || removed.length || [...next.values()].some(tab => before.has(tab.id) && (before.get(tab.id).url !== tab.url || before.get(tab.id).title !== tab.title)) || changedChats.length || group.revision === 0) {
        group.revision++;
        host.log?.("group changed", { groupId: group.groupId, revision: group.revision, addedTabIds: added, removedTabIds: removed });
      }
      if (!["stopped", "failed"].includes(group.state)) await host.updateStatus?.([...next.keys()], {
        state: group.state, phase: group.phase, statusMessage: "Tab group automation is active.", error: null
      });
      try { await host.onGroupSnapshot?.(group); }
      catch {
        try { host.diagnostic?.({stage:"board.sync",code:"AGENT_UNAVAILABLE"})?.catch?.(() => {}); host.log?.("Board sync unavailable", {groupId:group.groupId}); } catch {}
      }
      return group;
    });
    group.refreshing = work.catch(() => {});
    return work;
  }
  async function forChat(chatTabId, { allowStarting = false } = {}) {
    const tab = await host.getTab(chatTabId).catch(() => { throw browserError("TAB_CLOSED", "The initiating ChatGPT tab is closed."); });
    if (!isChatTab(tab)) throw browserError("BROWSER_INVALID", "chatTabId must identify a ChatGPT tab.");
    if (!Number.isSafeInteger(tab.groupId) || tab.groupId < 0) throw browserError("BROWSER_GROUP_NOT_FOUND", "Place this ChatGPT tab and the sites in the same Chrome tab group.");
    const group = await get(tab.groupId);
    await refresh(group);
    const member = group.members.get(chatTabId);
    if (!member) throw browserError("TAB_LEFT_GROUP", "The initiating tab left its group.");
    if (!allowStarting && (!member.chatPath || /\/c\/local-chatgpt(?:%3A|:)/i.test(member.chatPath)))
      throw browserError("BROWSER_SESSION_NOT_READY", "Wait for ChatGPT to save this conversation before using group tools.");
    return { group, member };
  }
  async function check(group, tabId, chatPath = null, { allowStopped = false } = {}) {
    if (!allowStopped && ["stopped", "failed"].includes(group.state)) throw browserError(group.error?.code || "BROWSER_SESSION_STOPPED", group.error?.message || "Group automation stopped. Reconnect with system_get_chat_context.");
    const tab = await host.getTab(tabId).catch(() => { throw browserError("TAB_CLOSED", "The selected participant closed; other group tabs remain available."); });
    if (tab.groupId !== group.groupId) throw browserError("TAB_LEFT_GROUP", "The selected participant is no longer in this tab group.");
    if (chatPath && (!isChatTab(tab) || pathOf(tab) !== chatPath)) throw browserError("BROWSER_CHAT_CHANGED", "The selected ChatGPT conversation changed. No replacement destination was selected.");
    if (isGroupChatView(tab)) throw browserError("BROWSER_INVALID", "The Board view is read-only; use site_board_read.");
    if (!/^https?:\/\//.test(tab.url || "")) throw browserError("BROWSER_UNAVAILABLE", "Only ordinary HTTP/HTTPS tabs can be controlled.");
    return tab;
  }
  async function changed() { await Promise.allSettled([...groups.values()].map(group => refresh(group))); }
  return { get, forChat, refresh, check, project, acknowledge, reportChanges, changed, values: () => groups.values() };
}

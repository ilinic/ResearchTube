import { browserError } from "./browser-tools.js";
import { isGroupChatView } from "./group-chat.js";
import { safePageUrl } from "./browser-page.js";

export const isChatTab = tab => /^https:\/\/chatgpt\.com(?:\/|$)/.test(tab.url || "");

// Chrome is the source of membership. Only live automation metadata, pending
// notifications and task routing live here; nothing is written to storage.
export function createBrowserGroups(host) {
  const groups = new Map(), creating = new Map();
  const pathOf = tab => isChatTab(tab) ? host.conversationPath(tab.url) : null;
  async function get(groupId, options) {
    if (groups.has(groupId)) return groups.get(groupId);
    if (!creating.has(groupId)) creating.set(groupId, (async () => {
      const group = { groupId, revision: 0, state: "running", phase: "running", error: null,
        members: new Map(), targets: new Map(), seen: new Map(), pending: new Map(), refreshing: Promise.resolve(),
        options: options || await host.studyOptions(), startup: null, notifying: false };
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
  function acknowledge(group, chatTabId) {
    group.seen.set(chatTabId, group.revision);
    group.pending.delete(chatTabId);
  }
  function scheduleNotifications(group) { host.journalWake?.(group); }
  async function refresh(group) {
    const work = group.refreshing.catch(() => {}).then(async () => {
      const tabs = (await host.queryTabs(group.groupId)).filter(tab => Number.isSafeInteger(tab.id) && /^https?:\/\//.test(tab.url || ""));
      const next = new Map(tabs.map(tab => [tab.id, { ...tab, chatPath: pathOf(tab) }]));
      const before = group.members;
      const added = [...next.keys()].filter(id => !before.has(id));
      const removed = [...before.keys()].filter(id => !next.has(id));
      const changedChats = [...next.values()].filter(tab => before.has(tab.id) && before.get(tab.id).chatPath !== tab.chatPath);
      for (const id of removed) {
        group.pending.delete(id); group.seen.delete(id);
        await host.removed(group, id, "TAB_LEFT_GROUP");
      }
      for (const tab of changedChats) await host.conversationChanged(group, tab.id);
      group.members = next;
      if (!next.size) groups.delete(group.groupId);
      if (added.length || removed.length || [...next.values()].some(tab => before.has(tab.id) && (before.get(tab.id).url !== tab.url || before.get(tab.id).title !== tab.title)) || changedChats.length || group.revision === 0) {
        group.revision++;
        if (group.revision > 1) for (const tab of next.values()) if (isChatTab(tab)) group.pending.set(tab.id, group.revision);
        host.log?.("group changed", { groupId: group.groupId, revision: group.revision, addedTabIds: added, removedTabIds: removed });
      }
      if (!["stopped", "failed"].includes(group.state)) await host.updateStatus?.([...next.keys()], {
        state: group.state, phase: group.phase, statusMessage: "Tab group automation is active.", error: null
      });
      await host.onGroupSnapshot?.(group);
      scheduleNotifications(group);
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
  async function check(group, tabId, chatPath = null) {
    if (["stopped", "failed"].includes(group.state)) throw browserError(group.error?.code || "BROWSER_SESSION_STOPPED", group.error?.message || "Group automation stopped. Reconnect with system_get_chat_context.");
    const tab = await host.getTab(tabId).catch(() => { throw browserError("TAB_CLOSED", "The selected participant closed; other group tabs remain available."); });
    if (tab.groupId !== group.groupId) throw browserError("TAB_LEFT_GROUP", "The selected participant is no longer in this tab group.");
    if (chatPath && (!isChatTab(tab) || pathOf(tab) !== chatPath)) throw browserError("BROWSER_CHAT_CHANGED", "The selected ChatGPT conversation changed. No replacement destination was selected.");
    if (isGroupChatView(tab)) throw browserError("BROWSER_INVALID", "The journal view is read-only; use site_chat_read.");
    if (!/^https?:\/\//.test(tab.url || "")) throw browserError("BROWSER_UNAVAILABLE", "Only ordinary HTTP/HTTPS tabs can be controlled.");
    return tab;
  }
  async function changed() { await Promise.allSettled([...groups.values()].map(group => refresh(group))); }
  return { get, forChat, refresh, check, project, acknowledge, changed, scheduleNotifications, values: () => groups.values() };
}

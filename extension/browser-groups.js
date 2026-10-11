import { browserError } from "./browser-tools.js";
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
      return { tabId: member.id, role: isChatTab(member) ? "chatgpt" : "site",
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
  function scheduleNotifications(group, delay = 1000) {
    if (group.notifying || !group.pending.size || ["starting", "stopped", "failed"].includes(group.state)) return;
    group.notifying = true;
    host.scheduleDelay(async () => {
      try {
        await refresh(group);
        for (const [chatTabId] of group.pending) {
          const member = group.members.get(chatTabId);
          if (!member || !isChatTab(member) || !member.chatPath) { group.pending.delete(chatTabId); continue; }
          const revision = group.pending.get(chatTabId);
          if ((group.seen.get(chatTabId) || 0) >= revision) { group.pending.delete(chatTabId); continue; }
          const text = `ResearchTube tab group changed (revision ${revision}, ${group.members.size} participants). Use chatTabId: ${chatTabId}. Refresh the group tab list and continue your current task when appropriate.`;
          const valid = async () => {
            if (group.pending.get(chatTabId) !== revision || (group.seen.get(chatTabId) || 0) >= revision)
              throw browserError("BROWSER_NOTIFICATION_OBSOLETE", "The group update was already received or superseded.");
            await check(group, chatTabId, member.chatPath);
          };
          try {
            const result = await host.notifyChat(chatTabId, text, { chatPath: member.chatPath, beforeSend: valid });
            if ((result?.sent || result?.committed || result?.inserted) && group.pending.get(chatTabId) === revision) {
              group.seen.set(chatTabId, revision); group.pending.delete(chatTabId);
              if (!result.sent) host.log?.("group notification unconfirmed", { groupId: group.groupId, chatTabId, revision });
            }
          } catch { /* Busy/edited chats retry; source data remains in Chrome. */ }
        }
      } finally {
        group.notifying = false;
        scheduleNotifications(group, 2000);
      }
    }, delay);
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
        group.pending.delete(id); group.seen.delete(id);
        await host.removed(group, id, "TAB_LEFT_GROUP");
      }
      for (const tab of changedChats) await host.conversationChanged(group, tab.id);
      group.members = next;
      if (!next.size) groups.delete(group.groupId);
      if (added.length || removed.length || changedChats.length || group.revision === 0) {
        group.revision++;
        if (group.revision > 1) for (const tab of next.values()) if (isChatTab(tab)) group.pending.set(tab.id, group.revision);
        host.log?.("group changed", { groupId: group.groupId, revision: group.revision, addedTabIds: added, removedTabIds: removed });
      }
      if (!["stopped", "failed"].includes(group.state)) await host.updateStatus?.([...next.keys()], {
        state: group.state, phase: group.phase, statusMessage: "Tab group automation is active.", error: null
      });
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
    if (!/^https?:\/\//.test(tab.url || "")) throw browserError("BROWSER_UNAVAILABLE", "Only ordinary HTTP/HTTPS tabs can be controlled.");
    return tab;
  }
  async function changed() { await Promise.allSettled([...groups.values()].map(group => refresh(group))); }
  return { get, forChat, refresh, check, project, acknowledge, changed, scheduleNotifications, values: () => groups.values() };
}

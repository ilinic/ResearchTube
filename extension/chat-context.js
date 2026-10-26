import { browserError } from "./browser-tools.js";

// Explicit local group context. Connection setup never mounts a chat widget.
export function createChatContext(host) {
  async function verify(target) {
    const tab = await host.getTab(target.tabId).catch(() => { throw browserError("TAB_CLOSED", "The bound ChatGPT tab closed."); });
    if (host.conversationPath(tab.url) !== target.chatPath) throw browserError("BROWSER_CHAT_CHANGED", "The bound conversation changed. Connect this chat again.");
    if (target.groupId != null && tab.groupId !== target.groupId) throw browserError("TAB_LEFT_GROUP", "The chat moved to another group. Connect it again.");
    const matches = (await host.queryTabs()).filter(item => host.conversationPath(item.url)?.split("/c/").pop() === target.chatPath.split("/c/").pop());
    if (matches.length !== 1 || matches[0].id !== target.tabId) throw browserError("BROWSER_CONTEXT_AMBIGUOUS", "This conversation is open in multiple tabs. Close its duplicate and retry.");
  }
  async function direct(chatTabId) {
    if (!Number.isSafeInteger(chatTabId) || chatTabId < 0) throw browserError("INVALID_ARGUMENT", "Provide the exact chatTabId from the startup prompt.");
    const tab = await host.getTab(chatTabId);
    const target = { tabId: chatTabId, chatPath: host.conversationPath(tab.url) };
    if (!target.chatPath) throw browserError("BROWSER_CONTEXT_REQUIRED", "The specified tab is not a saved ChatGPT conversation.");
    await verify(target);
    const context = await host.connect(chatTabId, () => {});
    await verify(target);
    return { taskId: host.id(), status: "completed", phase: "connected", progressPercent: 100, pollIntervalMs: 1000, chatTabId,
      group: context.group, error: null };
  }
  return { direct };
}

import { browserError } from './browser-tools.js';

// This lives in the Extension's isolated world of each grouped ChatGPT page.
// It survives worker suspension, is invisible to page JS, and never touches the
// Composer. Mirrors on ignored chats prevent takeover when the owner closes.
export function siteOwnerPage(record) {
  if (location.origin !== 'https://chatgpt.com') return null;
  const key = '__researchtubeSiteOwner';
  if (record !== undefined) globalThis[key] = { ...record };
  const value = globalThis[key];
  return value ? { groupId: value.groupId, ownerTabId: value.ownerTabId, state: value.state } : null;
}
const valid = value => value && Number.isSafeInteger(value.groupId) && value.groupId >= 0 &&
  Number.isSafeInteger(value.ownerTabId) && value.ownerTabId >= 0 && ['starting','running','stopped','failed'].includes(value.state);

export function createBrowserOwner(host) {
  async function read(tabId) {
    const result = await host.execute({ target: { tabId }, world: 'ISOLATED', func: siteOwnerPage });
    const value = result?.[0]?.result;
    if (value === null) return null;
    if (!valid(value)) throw browserError('BROWSER_UNAVAILABLE', 'The site controller marker could not be read. Reconnect the leading chat.');
    return { groupId: value.groupId, ownerTabId: value.ownerTabId, state: value.state };
  }
  async function write(tabId, record) {
    if (!valid(record)) throw browserError('BROWSER_INVALID', 'Invalid site controller identity.');
    const tab = await host.getTab(tabId);
    if (tab.groupId !== record.groupId || !/^https:\/\/chatgpt\.com(?:\/|$)/.test(tab.url || ''))
      throw browserError('TAB_LEFT_GROUP', 'The controller marker target left the group.');
    const result = await host.execute({ target: { tabId }, world: 'ISOLATED', func: siteOwnerPage, args: [record] });
    const value = result?.[0]?.result;
    if (!valid(value) || value.groupId !== record.groupId || value.ownerTabId !== record.ownerTabId || value.state !== record.state)
      throw browserError('BROWSER_UNAVAILABLE', 'Chrome did not confirm the site controller marker.');
    const current = await host.getTab(tabId);
    if (current.groupId !== record.groupId || !/^https:\/\/chatgpt\.com(?:\/|$)/.test(current.url || ''))
      throw browserError('TAB_LEFT_GROUP', 'The controller marker target changed during binding.');
  }
  return { read, write };
}

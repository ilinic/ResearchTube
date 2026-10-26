import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const [settings, script, popup] = await Promise.all([read('settings.html'), read('settings.js'), read('popup.js')]);
assert.doesNotMatch(settings + script, /tunnel|api-key|connection-mode|set-connection-mode|legacy-connection|No separate|not needed/i);
assert.match(settings, /https:\/\/rtube.win/);
assert.match(settings, /custom MCP server/);
assert.match(settings, /OAuth/);
for (const id of ['agent-port', 'test-agent', 'agent-result', 'silent-automation-flag', 'copy-silent-automation-flag', 'copy-diagnostics', 'clear-diagnostics', 'mcp-tools']) {
  assert.equal((settings.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, id);
}
const renderSource = popup.slice(popup.indexOf('function renderConnectionStatus(state) {'), popup.indexOf('async function loadConnectionStatus()'));
for (const [cloud, text, style] of [
  [{ state: 'not-configured', configured: false }, 'Waiting for connection', 'warn'],
  [{ state: 'connecting', configured: true }, 'Connecting…', 'warn'],
  [{ state: 'ready', configured: true }, 'Connected', 'good'],
  [{ state: 'error', configured: true, errorCode: 'EXTENSION_REPLACED' }, 'Disconnected', 'bad'],
  [{ state: 'offline', configured: true }, 'Offline', 'warn'],
  ...['BROWSER_ACCOUNT_MISMATCH', 'BROWSER_SIGN_IN_REQUIRED', 'CLOUD_UNAVAILABLE'].map(errorCode => [{ state: 'error', configured: true, errorCode }, 'Sign-in or connection error', 'bad'])
]) {
  const nodes = { 'server-status-value': {}, 'server-status': {} };
  vm.runInNewContext(renderSource + 'renderConnectionStatus(state)', { state: { cloud }, $: id => nodes[id] });
  assert.equal(nodes['server-status-value'].textContent, text);
  assert.equal(nodes['server-status'].className, style);
}
console.log('Simplified Settings and public popup connection states: ok');

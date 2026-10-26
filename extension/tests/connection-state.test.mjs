import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

for (const file of ['background.js', 'dist/background.js']) {
  const source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\/v1\/tunnels|CONTROL_PLANE_BASE_URL|function pollOnce|function saveConnection/);
  const data = { tunnelId: 'old-id', runtimeApiKey: 'old-secret', connectionMode: 'tunnel', agentPort: 17844, mcpToolPreferences: { enabledByName: {} } };
  const cloud = { state: 'ready', configured: true, errorCode: null, serverUrl: 'https://rtube.win' };
  const removed = [], alarms = [];
  let starts = 0;
  const context = {
    DEFAULTS: { agentPort: 17843, youtubeSearchCooldownUntil: 0 }, Date,
    EXTENSION_VERSION: 'test', REQUIRED_AGENT_INTERFACE_VERSION: 83,
    chrome: { storage: { local: {
      get: async defaults => ({ ...defaults, ...data }),
      remove: async keys => { for (const key of keys) { removed.push(key); delete data[key]; } }
    } }, alarms: { clear: async name => alarms.push(['clear', name]), create: async name => alarms.push(['create', name]) } },
    cloudConnection: { status: async () => cloud, ensureAccount: async () => { starts++; } },
    normalizeAgentPort: port => port, refreshActionBadge: async () => {},
    getAgentStatus: async () => { throw Error('Status should not contact Agent'); }
  };
  const statusCode = source.slice(source.indexOf('async function getConfig()'), source.indexOf('function normalizeAgentPort('));
  const bootstrap = source.slice(source.indexOf('async function bootstrapConnection()'), source.indexOf('async function configuredStartupPrompts()'));
  vm.runInNewContext(statusCode + bootstrap, context);
  const status = await context.getPublicConnectionState({ includeAgent: false });
  assert.equal(status.cloud.state, 'ready');
  assert.equal(status.agentPort, 17844);
  assert.doesNotMatch(JSON.stringify(status), /old-id|old-secret|runtimeApiKey|tunnelId|connectionMode/);
  await context.bootstrapConnection();
  assert.equal(starts, 1, 'Old connection mode cannot prevent public startup');
  for (const key of ['tunnelId', 'runtimeApiKey', 'connectionMode']) assert.ok(removed.includes(key));
  assert.equal(data.agentPort, 17844);
  assert.ok(data.mcpToolPreferences);
  assert.deepEqual(alarms, [['clear', 'tunnel-poll'], ['create', 'public-relay']]);
}
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
assert.ok(!manifest.host_permissions.includes('https://api.openai.com/*'));
console.log('Public connection state and obsolete credential cleanup: ok');

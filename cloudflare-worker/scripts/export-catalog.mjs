// Export the existing Extension's authoritative definitions, never a second
// handwritten catalog. The VM has no browser/network authority.
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
const extension = new URL('../../extension/', import.meta.url);
const version = JSON.parse(await readFile(new URL('manifest.json', extension), 'utf8')).version;
const event = { addListener() {} };
const context = vm.createContext({
  URL, Intl, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout,
  console: { info() {} },
  fetch: async url => {
    const path = String(url);
    if (!path.startsWith('https://extension.invalid/')) throw Error('No network access in catalog export');
    const local = new URL(path.slice('https://extension.invalid/'.length), extension);
    if (!local.href.startsWith(extension.href)) throw Error('Invalid bundled resource');
    return new Response(await readFile(local, 'utf8'));
  },
  chrome: {
    runtime: { getManifest: () => ({ version }), id: 'catalog-export', getURL: p => 'https://extension.invalid/' + p, onInstalled: event, onStartup: event, onMessage: event },
    tabs: { onRemoved: event, onUpdated: event, onActivated: event },
    alarms: { onAlarm: event }, action: {},
    storage: { local: { get: async defaults => defaults, set: async () => {} } }
  }
});
vm.runInContext(await readFile(new URL('dist/background.js', extension), 'utf8'), context);
const tools = JSON.parse(JSON.stringify(context.publicMcpTools()));
const listing = await vm.runInContext('handleMcpRequest({jsonrpc:"2.0",id:1,method:"resources/list"})', context);
const resources = [];
for (const resource of listing.result.resources) {
  const response = await vm.runInContext('readMcpResource(1,' + JSON.stringify(resource.uri) + ')', context);
  if (response.error) throw Error(response.error.message);
  resources.push(response.result.contents[0]);
}
const output = JSON.stringify({ extensionVersion: version, tools, resources }, null, 2) + '\n';
const destination = new URL('../src/catalog.json', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(destination, 'utf8') !== output) throw Error('Run npm run catalog to refresh Extension definitions');
} else await writeFile(destination, output);
console.log(`Catalog: ${tools.length} Extension tools, ${resources.length} UI resources`);

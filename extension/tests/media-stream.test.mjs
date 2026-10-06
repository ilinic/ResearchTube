import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const source = await readFile(new URL('../media-stream.js', import.meta.url), 'utf8');
const { createMediaStreamHandler, MEDIA_STREAM_ROUTE } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const extensionUrl = 'chrome-extension://test/';
let fetchCalls = [], resolves = [], logs = [], clientUrl = `${extensionUrl}media-viewer.html#metadata`;
let upstream;
const handler = createMediaStreamHandler({ extensionUrl,
  getClient: async id => id === 'viewer' ? { url: clientUrl } : null,
  resolveMedia: async path => {
    resolves.push(path);
    if (path !== 'downloads/a movie [clip_1_2].mp4') throw new Error('Rejected host path http://127.0.0.1/private');
    return { metadata: {mediaKind: 'video', mimeType: 'video/mp4'}, localAgentImageUrl: 'http://127.0.0.1:17843/private' };
  },
  fetchMedia: async (url, options) => { fetchCalls.push({url, options}); return upstream; },
  log: (stage, details) => logs.push({stage, details})
});
const path = 'downloads/a movie [clip_1_2].mp4';
const url = `${extensionUrl.slice(0, -1)}${MEDIA_STREAM_ROUTE}?path=${encodeURIComponent(path)}&reload=attempt1`;
async function invoke({requestUrl = url, clientId = 'viewer', method = 'GET', range, referrer, signal} = {}) {
  const request = new Request(requestUrl, { method, headers: range === undefined ? {} : { Range: range }, referrer, signal });
  let response;
  handler({ request, clientId, respondWith(value) { response = value; } });
  return response ? await response : null;
}
// Passing a still-open stream proves headers/initial bytes are available before
// the source finishes. No body collector or additional copy is allowed.
let feed;
const body = new ReadableStream({start(controller) { feed = controller; controller.enqueue(new Uint8Array([1,2,3])); }});
upstream = {status: 206, headers: new Headers({'Content-Length': '6', 'Content-Range': 'bytes 2-7/10000000000', 'Accept-Ranges':'bytes'}), body,
  blob() { throw new Error('Whole-file buffering forbidden'); }, arrayBuffer() { throw new Error('Whole-file buffering forbidden'); }};
const response = await invoke({range: 'bytes=2-7'});
assert.equal(response.status, 206);
assert.equal(response.url, '', 'no private HTTP response URL reaches the media element');
assert.equal(response.body, body, 'the original readable stream is forwarded');
assert.equal(response.headers.get('Content-Range'), 'bytes 2-7/10000000000');
assert.equal(response.headers.get('Content-Type'), 'video/mp4');
assert.equal(response.headers.get('Cache-Control'), 'no-store');
assert.equal(fetchCalls[0].options.headers.get('Range'), 'bytes=2-7');
assert.equal(fetchCalls[0].options.credentials, 'omit');
assert.equal(fetchCalls[0].options.redirect, 'error');
assert.deepEqual(resolves, [path]);
const reader = response.body.getReader();
assert.deepEqual([...((await reader.read()).value)], [1,2,3]);
feed.enqueue(new Uint8Array([4,5,6])); feed.close();
assert.deepEqual([...((await reader.read()).value)], [4,5,6]);
assert.equal((await reader.read()).done, true);
for (const range of ['bytes=23-', 'bytes=-20']) {
  upstream = new Response(new Uint8Array([9]), {status:206,headers:{'Content-Range':'bytes 23-23/100'}});
  assert.equal((await invoke({range})).status, 206);
  assert.equal(fetchCalls.at(-1).options.headers.get('Range'), range);
}
upstream = new Response(null, {status:416,headers:{'Content-Range':'bytes */100','Content-Length':'0'}});
const unsatisfied = await invoke({range:'bytes=999-1000'});
assert.equal(unsatisfied.status,416); assert.equal(unsatisfied.headers.get('Content-Range'),'bytes */100');
let cancelled = false;
upstream = {status:200,headers:new Headers({'Content-Length':'100'}),body:new ReadableStream({cancel(){cancelled=true;}})};
const head = await invoke({method:'HEAD'});
assert.equal(head.body,null); assert.equal(head.headers.get('Content-Length'),'100'); assert.equal(cancelled,true);
cancelled = false;
upstream = {status:200,headers:new Headers(),body:new ReadableStream({cancel(){cancelled=true;}})};
await (await invoke()).body.cancel(); assert.equal(cancelled,true,'media cancellation cancels the original Agent body');
const calls = fetchCalls.length;
assert.equal((await invoke({clientId:'unknown'})).status,403);
clientUrl='https://chatgpt.com/'; assert.equal((await invoke()).status,403);
clientUrl=`${extensionUrl}popup.html`; assert.equal((await invoke()).status,403);
clientUrl=`${extensionUrl}media-viewer.html`;
assert.equal((await invoke({clientId:'',referrer:'https://chatgpt.com/'})).status,403);
assert.equal((await invoke({method:'POST'})).status,405);
assert.equal((await invoke({range:'bytes=0-2,5-7'})).status,400);
assert.equal((await invoke({requestUrl:`${url}&url=http://127.0.0.1/private`})).status,400);
assert.equal((await invoke({requestUrl:`${url}&path=other.mp4`})).status,400);
assert.equal(fetchCalls.length,calls,'invalid callers/requests never reach Agent fetch');
const invalidPath = await invoke({requestUrl: `${extensionUrl.slice(0,-1)}${MEDIA_STREAM_ROUTE}?path=..%2Fsecret`});
assert.equal(invalidPath.status,502); assert.ok(!(await invalidPath.text()).includes('127.0.0.1'));
const aborted = new AbortController(); aborted.abort();
assert.equal((await invoke({signal:aborted.signal})).status,400);
assert.equal(await invoke({requestUrl:`${extensionUrl}media-viewer.js`}),null,'packaged assets are not intercepted');
assert.equal(await invoke({requestUrl:'https://chatgpt.com/_researchtube/workspace-media?path=a.mp4'}),null);
assert.ok(!JSON.stringify(logs).includes('127.0.0.1'));
upstream=new Response(new Uint8Array([1]));
assert.equal((await invoke({clientId:'',referrer:`${extensionUrl}media-viewer.html`})).status,200);

// The shipped worker installs the handler synchronously and can resolve a
// fresh range without a saved URL map after worker restart.
const bundle = await readFile(new URL('../dist/background.js',import.meta.url),'utf8');
const listeners=new Map();
const context=vm.createContext({URL,Request,Response,Headers,console,setTimeout,clearTimeout,crypto:webcrypto,
  addEventListener(type,fn){listeners.set(type,fn);},clients:{get:async()=>({url:`${extensionUrl}media-viewer.html`})},
  chrome:{runtime:{getURL:path=>`${extensionUrl}${path.replace(/^\//,'')}`,onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}},alarms:{onAlarm:{addListener(){}}}}
});
vm.runInContext(bundle,context);
assert.equal(typeof listeners.get('fetch'),'function');
context.showWorkspaceImage=async()=>({metadata:{mediaKind:'audio',mimeType:'audio/mpeg'},localAgentImageUrl:'http://127.0.0.1/audio'});
context.fetch=async()=>new Response(new Uint8Array([7]),{status:206,headers:{'Content-Range':'bytes 0-0/1'}});
let shipped;
listeners.get('fetch')({request:new Request(url,{headers:{Range:'bytes=0-0'}}),clientId:'viewer',respondWith(value){shipped=value;}});
assert.equal((await shipped).status,206); assert.equal((await shipped).headers.get('Content-Type'),'audio/mpeg');
console.log('Media stream: native Range, 206/416/HEAD, progressive bytes, cancellation, private viewer binding and shipped handler passed');

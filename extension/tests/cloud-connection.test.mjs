import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createCloudConnection, cloudConversation } from '../cloud-connection.js';

const BASE='https://rt.test', EXT='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const credential={installationId:randomUUID(),installationToken:randomUUID()+randomUUID()};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(initial=credential) {
  const data={connectionMode:'public',researchtubeCloudCredential:initial},sessionData={},sockets=[],timers=new Map(),intervals=new Map(),calls=[],dispatches=[],invalidated=[];
  let time=100000,documentId='doc-1',copies=1,handler=async()=>({jsonrpc:'2.0',result:{content:[{type:'text',text:'ok'}]}}),deny=false;
  const tab={id:7,url:'https://chatgpt.com/c/chat-1'};
  const storage=object=>({get:async defaults=>({...defaults,...structuredClone(object)}),set:async value=>Object.assign(object,structuredClone(value)),remove:async key=>{delete object[key];}});
  const host={origin:BASE,uuid:randomUUID,now:()=>time,random:()=>0,
    chrome:{runtime:{id:EXT},storage:{local:storage(data),session:storage(sessionData)},
      tabs:{get:async()=>({...tab}),query:async()=>copies===1?[tab]:[tab,{...tab,id:8}],create:async options=>({id:99,...options}),update:async(id,options)=>({id,...options}),remove:async()=>{}},
      scripting:{executeScript:async()=>[{frameId:0,documentId,result:{url:tab.url}}]}},
    fetch:async(url,options)=>{
      calls.push({url,options});
      if(deny)return Response.json({error:{code:'SECRET'}},{status:401});
      if(url.endsWith('/api/relay-ticket'))return Response.json({ticket:randomUUID()+randomUUID(),expiresAt:time+15000});
      if(url.endsWith('/api/browser/bind'))return Response.json({bindingId:randomUUID(),expiresAt:time+3600000});
      if(url.endsWith('/api/installation/check'))return Response.json({installationId:credential.installationId});
      return Response.json({ok:true});
    },
    webSocket:url=>{const ws={url,readyState:0,sent:[],send(text){this.sent.push(text);},open(){this.readyState=1;this.onopen?.();},close(){this.readyState=3;this.onclose?.();}};sockets.push(ws);return ws;},
    setTimeout:(fn,ms)=>{const id=randomUUID();timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    setInterval:(fn,ms)=>{const id=randomUUID();intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),
    invalidated:target=>invalidated.push(target),dispatch:async request=>{dispatches.push(request);return handler(request);}
  };
  const connection=createCloudConnection(host);
  const sender={id:EXT,frameId:0,tab};
  async function online(){await connection.start();sockets.at(-1).open();await flush();return sockets.at(-1);}
  async function bind(){await connection.bind({nonce:randomUUID()+randomUUID()},sender);return {...JSON.parse(calls.findLast(c=>c.url.endsWith('/api/browser/bind')).options.body).target,
    bindingId:JSON.parse(calls.findLast(c=>c.url.endsWith('/api/browser/bind')).reply||'null')};}
  // Capture the server's actual binding receipt for subsequent relay requests.
  const originalFetch=host.fetch;
  let bound;
  host.fetch=async(...args)=>{const response=await originalFetch(...args);if(args[0].endsWith('/api/browser/bind'))bound=await response.clone().json();return response;};
  async function connected(){const ws=await online();await bind();return {ws,target:{tabId:7,documentId,conversationId:'chat-1',installationId:credential.installationId,session:'s-1',...bound}};}
  function request(target,name='youtube_get_video',args={videoId:'aqz-KE-bpKQ'}){return {type:'request',requestId:randomUUID(),target,request:{jsonrpc:'2.0',method:'tools/call',params:{name,arguments:args}}};}
  const receive=async(ws,value)=>{ws.onmessage({data:JSON.stringify(value)});await flush();await flush();await flush();};
  return {connection,host,data,sessionData,sockets,timers,intervals,calls,dispatches,invalidated,sender,online,connected,request,receive,
    navigate:()=>{documentId='new-document';},duplicate:()=>{copies=2;},advance:ms=>{time+=ms;},deny:()=>{deny=true;},handle:fn=>{handler=fn;}};
}
assert.equal(cloudConversation('https://chatgpt.com/g/g-id/c/chat-1'),'chat-1');
assert.equal(cloudConversation('https://evil.test/c/chat-1'),null);
{
 const f=fixture(null);await f.connection.start();assert.equal(f.calls.length,0);assert.equal((await f.connection.status()).configured,false);
}
{
 const f=fixture();await Promise.all([f.connection.start(),f.connection.start(),f.connection.start()]);
 assert.equal(f.sockets.length,1,'simultaneous wakeups share one connection');
 f.sockets[0].open();await flush();assert.equal((await f.connection.status()).state,'ready');
 assert.equal(f.calls[0].options.credentials,'omit');assert.equal(f.calls[0].options.redirect,'error');
 assert.equal(f.calls[0].options.headers.Authorization,'Bearer '+credential.installationToken);
 assert.ok(!f.sockets[0].url.includes(credential.installationToken));
 assert.ok(!JSON.stringify(await f.connection.status()).includes(credential.installationToken));
 for(const interval of f.intervals.values())interval.fn();assert.equal(f.sockets[0].sent.at(-1),'ping');
 await f.connection.suspend();assert.equal(f.intervals.size,0);
}
{
 const f=fixture();const {ws,target}=await f.connected();const command=f.request(target);
 f.handle(async request=>{assert.equal(request.id,command.requestId);assert.equal(f.connection.targetForRequest(request.id).documentId,target.documentId);return {result:{content:[{type:'text',text:'ok'}]}};});
 await f.receive(ws,command);assert.equal(f.dispatches.length,1);assert.equal(JSON.parse(ws.sent.at(-1)).result.content[0].text,'ok');
 await f.receive(ws,command);assert.equal(f.dispatches.length,1,'duplicate commands never execute twice');
 await f.receive(ws,f.request(target,'timer_start',{durationSeconds:1,tabId:99}));assert.equal(f.dispatches.length,1,'foreign delivery tab is rejected');
 await f.receive(ws,{type:'invalidate',bindingId:target.bindingId});assert.equal(f.invalidated.length,1);
 await assert.rejects(f.connection.verifyTarget(target),{code:'BROWSER_BINDING_CHANGED'});
 await f.receive(ws,f.request(target));assert.equal(f.dispatches.length,1);
}
for(const change of ['navigate','duplicate']){
 const f=fixture();const {ws,target}=await f.connected();f[change]();await f.receive(ws,f.request(target));assert.equal(f.dispatches.length,0,change+' must refuse before dispatch');
}
{
 const f=fixture();const {ws,target}=await f.connected();f.handle(async()=>{f.navigate();return {result:{content:[{type:'text',text:'wrong document'}]}};});
 await f.receive(ws,f.request(target));assert.ok(JSON.parse(ws.sent.at(-1)).error,'navigation during work suppresses its result');
}
{
 const f=fixture();const {target}=await f.connected();await f.connection.tabChanged(7);await assert.rejects(f.connection.verifyTarget(target));
 assert.ok(f.calls.some(call=>call.url.endsWith('/api/browser/release')));
}
{
 const f=fixture();const {ws,target}=await f.connected();ws.close();await flush();assert.equal(f.invalidated.length,1);assert.ok([...f.timers.values()].some(t=>t.ms>=5000));
 await assert.rejects(f.connection.verifyTarget(target));
}
{
 const f=fixture();f.deny();await f.connection.start();assert.equal((await f.connection.status()).errorCode,'EXTENSION_AUTHENTICATION_REQUIRED');
 await f.connection.start();assert.equal(f.calls.length,1,'revoked credentials do not reconnect endlessly');
}
{
 const f=fixture(null);await f.connection.beginEnrollment();const pending=f.sessionData.researchtubeCloudEnrollment;
 const sender={frameId:0,tab:{id:pending.tabId},url:BASE+'/setup?'+new URLSearchParams({extensionId:EXT,nonce:pending.nonce})};
 const ready={type:'researchtube_setup_ready',nonce:pending.nonce};
 await assert.rejects(f.connection.external(ready,{...sender,url:'https://evil.test/setup'}));
 await assert.rejects(f.connection.external(ready,{...sender,tab:{id:55}}));
 await assert.rejects(f.connection.external(ready,{...sender,frameId:1}));
 assert.equal((await f.connection.external(ready,sender)).extensionOrigin,'chrome-extension://'+EXT);
 await f.connection.external({type:'researchtube_setup_complete',nonce:pending.nonce,...credential},sender);
 assert.deepEqual(f.data.researchtubeCloudCredential,credential);
 await assert.rejects(f.connection.external(ready,sender),'enrollment receipt is single-use');
 await f.connection.disconnect();assert.equal(f.data.researchtubeCloudCredential,undefined);
}

{
 const f=fixture(null);await f.connection.beginEnrollment();const pending=f.sessionData.researchtubeCloudEnrollment;
 const sender={frameId:0,tab:{id:pending.tabId},url:BASE+'/setup?'+new URLSearchParams({extensionId:EXT,nonce:pending.nonce})};
 let completeCheck;const original=f.host.fetch;
 f.host.fetch=(url,...rest)=>url.endsWith('/api/installation/check')?new Promise(resolve=>{completeCheck=resolve;}):original(url,...rest);
 const work=f.connection.external({type:'researchtube_setup_complete',nonce:pending.nonce,...credential},sender);
 const refused=assert.rejects(work,{code:'ENROLLMENT_INVALID'});
 await flush();await f.connection.disconnect();completeCheck(Response.json({installationId:credential.installationId}));await refused;
 assert.equal(f.data.researchtubeCloudCredential,undefined,'late pairing cannot restore access after Disconnect');
}

// Authenticate the actual emitting iframe and exact sandbox origin.
const bridge=await readFile(new URL('../chatgpt-cloud-bridge.js',import.meta.url),'utf8');
{
 let listener;const messages=[],replies=[],child={postMessage:value=>replies.push(value)};
 const top={addEventListener:(_,fn)=>{listener=fn;}};
 vm.runInNewContext(bridge,{window:top,URL,document:{querySelectorAll:()=>[{contentWindow:child}]},chrome:{runtime:{sendMessage:async value=>{messages.push(value);return {ok:true};}}}});
 const event={source:child,origin:'https://x.web-sandbox.oaiusercontent.com',data:{source:'researchtube-cloud-binding',nonce:randomUUID()+randomUUID()}};
 listener({...event,source:{}});listener({...event,origin:'https://evil.test'});await flush();assert.equal(messages.length,0);
 listener(event);await flush();assert.equal(messages.length,1);assert.equal(replies[0].ok,true);
 listener(event);await flush();assert.equal(messages.length,1,'widget retries only acknowledge an already completed binding');
}
const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
const id=[...createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
assert.equal(id,'jnnhjpkdhmghpbgfcalbhmkagdeelgnp','unpacked profiles share the server-allowlisted extension identity');
assert.deepEqual(manifest.externally_connectable.matches,['https://rtube.win/*']);
console.log('Public connection: pairing, private credentials, single-flight reconnect, exact documents, duplicate chats, replay, invalidation and widget origins: ok');

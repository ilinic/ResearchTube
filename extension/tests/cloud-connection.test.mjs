import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
      if(url.endsWith('/api/relay-ticket'))return Response.json({ticket:randomUUID()+randomUUID(),expiresAt:time+15000,capabilities:{directTools:1}});
      if(url.endsWith('/api/installation/check'))return Response.json({installationId:credential.installationId});
      return Response.json({ok:true});
    },
    webSocket:url=>{const ws={url,readyState:0,sent:[],send(text){this.sent.push(text);},open(){this.readyState=1;this.onopen?.();},close(){this.readyState=3;this.onclose?.();}};sockets.push(ws);return ws;},
    setTimeout:(fn,ms)=>{const id=randomUUID();timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    setInterval:(fn,ms)=>{const id=randomUUID();intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),
    accepts:()=>true,invalidated:target=>invalidated.push(target),dispatch:async request=>{dispatches.push(request);return handler(request);}
  };
  const connection=createCloudConnection(host);
  const sender={id:EXT,frameId:0,tab};
  async function online(){await connection.start();sockets.at(-1).open();sockets.at(-1).onmessage({data:"direct-tools-ready"});await flush();return sockets.at(-1);}
  const receive=async(ws,value)=>{ws.onmessage({data:typeof value === "string" ? value : JSON.stringify(value)});await flush();await flush();await flush();};
  return {connection,host,data,sessionData,sockets,timers,intervals,calls,dispatches,invalidated,sender,online,receive,
    navigate:()=>{documentId='new-document';},duplicate:()=>{copies=2;},advance:ms=>{time+=ms;},deny:()=>{deny=true;},handle:fn=>{handler=fn;}};
}
assert.equal(cloudConversation('https://chatgpt.com/g/g-id/c/chat-1'),'chat-1');
assert.equal(cloudConversation('https://evil.test/c/chat-1'),null);
{
 const f=fixture(null);await f.connection.start();assert.equal(f.calls.length,0);
}
{
 const f=fixture();await Promise.all([f.connection.start(),f.connection.start(),f.connection.start()]);
 assert.equal(f.sockets.length,1);const ws=f.sockets[0];ws.open();await flush();
 assert.equal((await f.connection.status()).state,'connecting','not ready until protocol is acknowledged');
 assert.equal(ws.sent[0],'direct-tools-v1');await f.receive(ws,'direct-tools-ready');
 assert.equal((await f.connection.status()).state,'ready');
 assert.equal(f.calls[0].options.credentials,'omit');assert.equal(f.calls[0].options.redirect,'error');
 assert.ok(!ws.url.includes(credential.installationToken));
 assert.ok(!JSON.stringify(await f.connection.status()).includes(credential.installationToken));
 for(const interval of f.intervals.values())interval.fn();assert.equal(ws.sent.at(-1),'ping');
 await f.connection.suspend();assert.equal(f.intervals.size,0);
}
const request=(name,args={},installationId=credential.installationId)=>({type:'request',requestId:randomUUID(),installationId,
 request:{jsonrpc:'2.0',method:'tools/call',params:{name,arguments:args}}});
{
 const f=fixture(),ws=await f.online();f.duplicate();
 f.host.chrome.scripting.executeScript=async()=>{throw Error('Public research must not inspect ChatGPT');};
 const command=request('youtube_get_transcript',{videoId:'aqz-KE-bpKQ'});
 await f.receive(ws,command);assert.equal(f.dispatches.length,1);
 assert.equal(JSON.parse(ws.sent.at(-1)).result.content[0].text,'ok');
 await f.receive(ws,command);assert.equal(f.dispatches.length,1,'no replay');
 assert.equal(f.connection.targetForRequest(command.requestId),null);
 assert.equal(f.calls.some(call=>call.url.includes('/api/browser/')),false,'no conversation handshake');
 await f.receive(ws,request('media_probe',{workspacePath:'video.mp4'}));assert.equal(f.dispatches.length,2,'local reads do not require a chat');
}
{
 const f=fixture(),ws=await f.online();let target;
 f.handle(async command=>{target=f.connection.targetForRequest(command.id);return {result:{content:[{type:'text',text:'done'}]}};});
 await f.receive(ws,request('timer_start',{durationSeconds:1,tabId:7}));
 assert.equal(target.tabId,7);assert.equal(target.documentId,'doc-1');
 await f.connection.verifyTarget(target);
 f.navigate();await assert.rejects(f.connection.verifyTarget(target),{code:'BROWSER_TARGET_MISMATCH'});
 assert.equal(f.dispatches.length,1);
}
for(const change of ['duplicate','navigate']){
 const f=fixture(),ws=await f.online();
 if(change==='duplicate')f.duplicate();
 else f.handle(async()=>{f.navigate();return {result:{content:[{type:'text',text:'wrong document'}]}};});
 await f.receive(ws,request('timer_start',{durationSeconds:1,tabId:7}));
 assert.ok(JSON.parse(ws.sent.at(-1)).result.isError);
 assert.equal(f.dispatches.length,change==='duplicate'?0:1);
}
{
 const f=fixture(),ws=await f.online();let target;
 f.handle(async command=>{target=f.connection.targetForRequest(command.id);return {result:{content:[]}};});
 await f.receive(ws,request('media_view',{files:[{workspacePath:'a.png'}],tabId:7}));
 assert.ok(target);await f.connection.tabChanged(7);await assert.rejects(f.connection.verifyTarget(target));
 assert.equal(f.invalidated.length,1);
}
for(const [name,args] of [['media_view',{files:[{workspacePath:'a.png'}]}],['media_clip',{workspacePath:'a.mp4',addToChat:true}],['system_get_chat_context',{}]]){
 const f=fixture(),ws=await f.online();await f.receive(ws,request(name,args));
 assert.equal(f.dispatches.length,0);assert.equal(JSON.parse(ws.sent.at(-1)).result.structuredContent.error.code,'BROWSER_CONTEXT_REQUIRED');
}
{
 const f=fixture(),ws=await f.online();f.host.accepts=()=>false;
 await f.receive(ws,request('unknown_tool'));assert.equal(f.dispatches.length,0);
 assert.equal(JSON.parse(ws.sent.at(-1)).result.structuredContent.error.code,'INVALID_ARGUMENT');
}
{
 const f=fixture(),ws=await f.online();let release;
 f.host.accepts=()=>new Promise(resolve=>{release=resolve;});
 const work=f.receive(ws,request('youtube_get_video',{videoId:'aqz-KE-bpKQ'}));await flush();
 await f.receive(ws,{type:'disconnect',code:'EXTENSION_REPLACED'});release(true);await work;
 assert.equal(f.dispatches.length,0,'replacement during request validation prevents execution');
}
for(const mutate of [command=>({...command,installationId:randomUUID()}),command=>({...command,target:{tabId:7}}),command=>({...command,request:{...command.request,method:'eval'}})]){
 const f=fixture(),ws=await f.online();await f.receive(ws,mutate(request('youtube_get_video',{videoId:'x'})));
 assert.equal(f.dispatches.length,0);assert.equal(ws.readyState,3);
}
{
 const f=fixture(),ws=await f.online();ws.close();await flush();
 assert.equal((await f.connection.status()).state,'offline');assert.equal((await f.connection.status()).errorCode,'CLOUD_DISCONNECTED');
 assert.ok([...f.timers.values()].some(t=>t.ms>=5000));
}
{
 const f=fixture(),ws=await f.online();await f.receive(ws,{type:'disconnect',code:'EXTENSION_REPLACED'});
 assert.equal(ws.readyState,3);assert.equal(f.data.researchtubeCloudCredential.revoked,true);
 assert.equal((await f.connection.status()).errorCode,'EXTENSION_REPLACED');
 f.host.profileStatus=async()=>({state:"signed-out"});
 const count=f.calls.length;await f.connection.start();await f.connection.ensureAccount();
 assert.equal(f.calls.length,count,'replaced extension never takes the account back');
 assert.equal((await f.connection.status()).errorCode,'EXTENSION_REPLACED','replacement status survives wakeups');
 assert.equal(f.timers.size,0);
}
{
 const f=fixture();f.deny();await f.connection.start();assert.equal((await f.connection.status()).errorCode,'EXTENSION_AUTHENTICATION_REQUIRED');
 await f.connection.ensureAccount();assert.equal(f.calls.length,1);
}
{
 const f=fixture(null);f.host.profileStatus=async()=>({state:'signed-out'});
 await f.connection.ensureAccount();assert.equal(f.calls.length,0);assert.equal(f.sessionData.researchtubeCloudEnrollment,undefined);
 assert.equal((await f.connection.status()).errorCode,'BROWSER_SIGN_IN_REQUIRED');
}
{
 const f=fixture(null);const automatic=f.connection.ensureAccount();await flush();
 const pending=f.sessionData.researchtubeCloudEnrollment;
 assert.equal(pending.automatic,true);assert.equal(pending.pairingNonce,undefined);
 const sender={frameId:0,tab:{id:pending.tabId},url:BASE+'/setup?'+new URLSearchParams({extensionId:EXT,nonce:pending.nonce})};
 await assert.rejects(f.connection.external({type:'researchtube_setup_ready',nonce:pending.nonce},{...sender,url:'https://evil.test/setup'}));
 const ready=await f.connection.external({type:'researchtube_setup_ready',nonce:pending.nonce},sender);assert.equal(ready.automatic,true);
 await f.connection.external({type:'researchtube_setup_complete',nonce:pending.nonce,...credential},sender);await automatic;
 assert.deepEqual(f.data.researchtubeCloudCredential,credential);
 await assert.rejects(f.connection.external({type:'researchtube_setup_ready',nonce:pending.nonce},sender),'single use');
 await f.connection.disconnect();await f.connection.ensureAccount();assert.equal(f.data.researchtubeCloudCredential,undefined);
 assert.equal(f.sessionData.researchtubeCloudEnrollment,undefined,'disconnect remains disabled');
}
{
 const f=fixture(null);await f.connection.beginEnrollment();const pending=f.sessionData.researchtubeCloudEnrollment;
 const sender={frameId:0,tab:{id:pending.tabId},url:BASE+'/setup?'+new URLSearchParams({extensionId:EXT,nonce:pending.nonce})};
 let completeCheck;const original=f.host.fetch;
 f.host.fetch=(url,...rest)=>url.endsWith('/api/installation/check')?new Promise(resolve=>{completeCheck=resolve;}):original(url,...rest);
 const work=f.connection.external({type:'researchtube_setup_complete',nonce:pending.nonce,...credential},sender);
 const refused=assert.rejects(work,{code:'ENROLLMENT_INVALID'});
 await flush();await f.connection.disconnect();completeCheck(Response.json({installationId:credential.installationId}));await refused;
 assert.equal(f.data.researchtubeCloudCredential,undefined,'late receipt cannot undo disconnect');
}
{
 const f=fixture(null);
 for(const sender of [{frameId:1,tab:{id:7},url:BASE+'/account'},{frameId:0,tab:{id:7},url:'https://evil.test/account'},{id:EXT,frameId:0,tab:{id:7},url:BASE+'/account'}])
   await assert.rejects(f.connection.external({type:'researchtube_account_ready'},sender));
 assert.equal(f.sessionData.researchtubeCloudEnrollment,undefined);
}
const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
const id=[...createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
assert.equal(id,'jnnhjpkdhmghpbgfcalbhmkagdeelgnp');
assert.deepEqual(manifest.externally_connectable.matches,['https://rtube.win/*']);
assert.ok(!manifest.content_scripts.some(script=>script.js.includes('chatgpt-cloud-bridge.js')));
console.log('Direct account connection: no chat widget, first productive call, exact local documents, replay rejection, replacement, status and enrollment passed');

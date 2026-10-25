import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServerConnection, SERVER_ORIGIN } from '../server-connection.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const target={tabId:7,documentId:'top-document',conversationId:'saved-chat'};
function fixture() {
  let config={connectionMode:'server',serverInstallationId:randomUUID(),serverInstallationToken:randomUUID()+randomUUID()}, live={...target}, clock=1000;
  const calls=[],executed=[],invalidated=[],states=[],sockets=[],timers=new Map(),intervals=new Map();let sequence=0;
  class Socket extends EventTarget {
    readyState=0; sent=[];
    constructor(){super();queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
    send(value){this.sent.push(JSON.parse(value));}
    close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
    receive(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
  }
  const host={extensionId:'a'.repeat(32),config:async()=>({...config}),now:()=>clock,random:()=>0,
    setTimeout:(fn,delay)=>{const id=++sequence;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
    setInterval:(fn,delay)=>{const id=++sequence;intervals.set(id,{fn,delay});return id;},clearInterval:id=>intervals.delete(id),
    socket:url=>{assert.match(url,/^wss:\/\/rtube.win\/relay\?ticket=/);assert.ok(!url.includes(config.serverInstallationToken));const s=new Socket();sockets.push(s);return s;},
    fetch:async(url,options)=>{
      calls.push({url,options});assert.equal(options.headers.Authorization,'Bearer '+config.serverInstallationToken);
      assert.equal(options.redirect,'error');
      if(url.endsWith('/api/relay-ticket'))return Response.json({ticket:randomUUID()+randomUUID(),expiresAt:clock+15000});
      if(url.endsWith('/api/browser/bind'))return Response.json({bindingId:randomUUID(),expiresAt:clock+3600000});
      return Response.json({revoked:true});
    },
    identity:async id=>{assert.equal(id,7);return {...live};},
    tool:name=>({inputSchema:{properties:name==='site_read'?{chatTabId:{},tabId:{}}:{tabId:{}}}}),
    execute:async(request,context)=>{executed.push({request,context});return {jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:'ok'}]}};},
    invalidate:async b=>invalidated.push(b),status:async s=>{states.push(s);config.lastServerConnection=s;},clearCredential:async()=>{config.serverInstallationToken='';}
  };
  const connection=createServerConnection(host);
  async function bind(){const nonce=randomUUID()+randomUUID();await connection.bind(nonce,{id:host.extensionId,tab:{id:7}});return {nonce,binding:JSON.parse(calls.findLast(c=>c.url.endsWith('/api/browser/bind')).options.body)};}
  async function command(name='youtube_search',args={}) {
    const bindCall=calls.findLast(c=>c.url.endsWith('/api/browser/bind'));
    // The private binding is exposed only to the execution callback below; get
    // the server-issued ID from the fixture's response, not from a tab guess.
    const message={type:'request',requestId:randomUUID(),target:{...target,installationId:config.serverInstallationId,bindingId:host.lastBindingId,expiresAt:clock+3600000,session:'chat-1'},request:{jsonrpc:'2.0',method:'tools/call',params:{name,arguments:args}}};
    sockets.at(-1).receive(message);for(let i=0;i<8;i++)await tick();return message;
  }
  const original=host.fetch;
  host.fetch=async(...args)=>{const r=await original(...args);if(args[0].endsWith('/api/browser/bind'))host.lastBindingId=(await r.clone().json()).bindingId;return r;};
  return {connection,host,calls,executed,invalidated,states,sockets,timers,intervals,bind,command,
    mode:value=>{config.connectionMode=value;},live:value=>{live=value;},advance:ms=>{clock+=ms;},config:()=>config};
}
{
  const f=fixture();f.mode('tunnel');assert.equal((await f.connection.connect()).ok,false);assert.equal(f.calls.length,0);
}
{
  const f=fixture();assert.deepEqual(await f.connection.connect(),{ok:true});await f.bind();
  const request=await f.command('media_capture_frame');
  assert.equal(f.executed.length,1);assert.equal(f.executed[0].request.id,request.requestId);assert.equal(f.executed[0].request.params.arguments.tabId,7);
  assert.equal(f.sockets[0].sent.at(-1).type,'response');
  f.sockets[0].receive(request);await tick();assert.equal(f.executed.length,1,'duplicate request is never replayed');
  await f.command('media_capture_frame',{tabId:9});assert.equal(f.executed.length,1,'cannot override delivery destination');
  await f.command('site_read',{tabId:42});assert.equal(f.executed[1].request.params.arguments.tabId,42);assert.equal(f.executed[1].request.params.arguments.chatTabId,7);
  const immutable=f.executed[0].context;
  f.live({...target,documentId:'replacement'});await assert.rejects(f.connection.verify(immutable),/document changed/);
  assert.equal(f.invalidated.length,1);await f.connection.stop();
}
{
  const f=fixture();await f.connection.connect();const {nonce}=await f.bind();
  await f.connection.bind(nonce,{id:f.host.extensionId,tab:{id:7}});assert.equal(f.calls.filter(c=>c.url.endsWith('/api/browser/bind')).length,1,'duplicate widget receipt does not enroll a new route');
  await assert.rejects(f.connection.bind(nonce,{id:'foreign',tab:{id:7}}),/Invalid browser widget/);
  await f.command();const immutable=f.executed[0].context;
  f.sockets[0].receive({type:'invalidate',bindingId:immutable.bindingId});await tick();
  await assert.rejects(f.connection.verify(immutable));await f.connection.stop();
}
{
  const f=fixture();await f.connection.connect();await f.bind();await f.command();const context=f.executed[0].context;
  f.mode('tunnel');await f.connection.stop();await assert.rejects(f.connection.verify(context));
  assert.equal(f.intervals.size,0);assert.equal(f.executed.length,1);assert.equal(f.timers.size,0);
}
{
  const f=fixture();await f.connection.connect();await f.bind();await f.command();const context=f.executed[0].context;
  f.sockets[0].close();for(let i=0;i<5;i++)await tick();
  assert.equal(f.invalidated.length,1);assert.equal(f.executed.length,1);
  assert.ok([...f.timers.values()].some(t=>t.delay>=5000),'reconnect respects ticket backoff');
  await assert.rejects(f.connection.verify(context));await f.connection.stop();
}
{
  const f=fixture();await f.connection.connect();assert.equal([...f.intervals.values()][0].delay,20000);
  [...f.intervals.values()][0].fn();assert.equal(f.sockets[0].sent.at(-1).type,'ping');
  await f.connection.disconnect();assert.equal(f.config().serverInstallationToken,'');assert.ok(f.calls.some(c=>c.url.endsWith('/api/installations/revoke-current')));
}
{
  const f=fixture();let requests=0;
  f.host.fetch=async()=>{requests++;return Response.json({error:{code:'EXTENSION_AUTHENTICATION_REQUIRED'}},{status:401});};
  assert.equal((await f.connection.connect()).ok,false);assert.equal((await f.connection.connect()).ok,false);
  assert.equal(requests,1,'revoked credentials are not retried by alarms');assert.equal(f.timers.size,0);
  const restarted=createServerConnection(f.host);assert.equal((await restarted.connect()).ok,false);assert.equal(requests,1,'credential refusal survives a service-worker restart');
}
console.log('Server transport: exact binding/document, independent source tabs, deduplication, invalidation, mode changes, heartbeat and revocation passed');

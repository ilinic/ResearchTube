import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const bundle=await readFile(new URL('../dist/background.js',import.meta.url),'utf8');
const widget=await readFile(new URL('../ui/chat-target-v1.html',import.meta.url),'utf8');
const bridge=await readFile(new URL('../chatgpt-chat-target-bridge.js',import.meta.url),'utf8');
const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
const script=manifest.content_scripts.find(item=>item.js.includes('chatgpt-chat-target-bridge.js'));
assert.equal(script.all_frames,true);assert.equal(script.match_origin_as_fallback,true);assert.equal(script.match_about_blank,true);
assert.equal(script.run_at,'document_start');
assert.equal(script.css,undefined,'the binding script must not inject host-hiding CSS');
const tabA={id:42,windowId:1,url:'https://chatgpt.com/c/origin',active:false};
const tabB={id:81,windowId:2,url:'https://chatgpt.com/c/other',active:true};
function worker() {
 let listener;
 let now=Date.now();
 const tabs=new Map([[42,{...tabA}],[81,{...tabB}]]);
 const storage={},alarms=new Map(),mutations=[],queries=[];
 class Clock extends Date {static now(){return now;}}
 const context=vm.createContext({URL,Intl,TextEncoder,TextDecoder,AbortController,crypto:webcrypto,Date:Clock,setTimeout,clearTimeout,
  console:{info(){},warn(){},error(){}},
  chrome:{runtime:{id:'extension-id',getURL:path=>path,onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(fn){listener=fn;}}},
   alarms:{onAlarm:{addListener(){}},create:async(name,value)=>alarms.set(name,value),clear:async name=>alarms.delete(name)},
   tabs:{query:async query=>{queries.push(query);assert.deepEqual(JSON.parse(JSON.stringify(query)),{},'never query active or last-focused tabs');return [...tabs.values()];},get:async id=>{if(!tabs.has(id))throw new Error('closed');return tabs.get(id);}},
   storage:{local:{get:async()=>storage,set:async value=>Object.assign(storage,value)}}}
 });
 vm.runInContext(bundle,context);
 context.configuredToolLimits=async()=>({mediaToChatMaxFiles:5});
 context.refreshTaskHistorySettings=async()=>{};
 context.reportMcpToolToAgent=async()=>{};
 context.recordCommandDiagnostic=async()=>{};
 context.refreshActionBadge=async()=>{};context.setActionBadge=async()=>{};
 context.isMcpToolEnabled=async()=>true;
 context.resolveLibraryStoreFiles=async files=>({localPaths:['/private/report.pdf'],submittedFiles:files,skippedFiles:[]});
 context.cdpAttachFilesNow=async (_paths,options)=>{await context.requireCurrentChatTarget(options.currentChatTarget);mutations.push({...options.currentChatTarget});};
 context.cdpErrorLog=()=>{};
 context.fetch=async path=>({ok:true,text:async()=>path.includes('chat-target')?widget:'media-viewer-widget'});
 return {context,tabs,storage,alarms,mutations,queries,advance(ms){now+=ms;},
  receive:(message,sender)=>new Promise(resolve=>{assert.equal(listener(message,sender,resolve),true);}),
  start:async()=>{
   const result=await context.handleMcpRequest({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'media_to_chat',arguments:{files:[{workspacePath:'report.pdf'}],composerPolicy:'clear'}}});
   assert.equal(result.result.isError,false);
   const {task}=result.result.structuredContent;
   const metadata=result.result._meta['researchtube/chatTarget'];
   assert.ok(metadata.bindingToken);
   assert.ok(!JSON.stringify(result.result.structuredContent).includes(metadata.bindingToken),'capability stays out of model-visible output');
   assert.ok(!result.result.content[0].text.includes(metadata.bindingToken));
   assert.ok(!('target' in task));
   return {task,metadata};
  }
 };
}
const sender=(tab=tabA)=>({id:'extension-id',tab});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
// The other tab/window is active even before start. No destination is guessed.
const current=worker();const started=await current.start();
assert.equal(current.mutations.length,0);assert.equal(current.queries.length,0);
await current.context.drainMediaToChatQueue();assert.equal(current.mutations.length,0);
assert.equal((await current.context.mediaToChatStatus(started.task.taskId)).status,'queued');
vm.runInContext('mediaToChatDraining=true',current.context);
const ack=await current.receive({type:'researchtube_chat_target_bind',...started.metadata},sender());
assert.equal(ack.ok,true);
// Switch focus in both windows after binding: the stored target must not move.
current.tabs.get(42).active=false;current.tabs.get(81).active=true;
await assert.rejects(current.context.bindMediaToChatTarget(started.metadata,sender(tabB)),error=>error.code==='MEDIA_TO_CHAT_TARGET_CHANGED');
vm.runInContext('mediaToChatDraining=false',current.context);
await current.context.drainMediaToChatQueue();
assert.deepEqual(current.mutations,[{tabId:42,chatPath:'/c/origin'}]);
assert.equal((await current.context.mediaToChatStatus(started.task.taskId)).status,'completed');
assert.equal(current.alarms.size,0);
// Missing handshake returns a meaningful terminal status without changing any tab.
const missing=worker();const notBound=await missing.start();missing.advance(30_001);
const failed=await missing.context.mediaToChatStatus(notBound.task.taskId);
assert.equal(failed.status,'failed');assert.match(failed.error,/MEDIA_TO_CHAT_TARGET_NOT_FOUND/);
assert.equal(missing.mutations.length,0);
assert.equal((await missing.receive({type:'researchtube_chat_target_bind',...notBound.metadata},sender())).ok,false,'late widget may not revive failed tasks');
// Missing/closed tab before binding or while queued must not fall back to tab B.
for(const beforeBinding of [true,false]) {
 const closed=worker();const item=await closed.start();vm.runInContext('mediaToChatDraining=true',closed.context);
 if(!beforeBinding) await closed.context.bindMediaToChatTarget(item.metadata,sender());
 closed.tabs.delete(42);
 if(beforeBinding) await assert.rejects(closed.context.bindMediaToChatTarget(item.metadata,sender()),e=>e.code==='MEDIA_TO_CHAT_TARGET_NOT_FOUND');
 vm.runInContext('mediaToChatDraining=false',closed.context);await closed.context.drainMediaToChatQueue();
 const status=await closed.context.mediaToChatStatus(item.task.taskId);
 assert.equal(status.status,'failed');assert.match(status.error,/MEDIA_TO_CHAT_TARGET_NOT_FOUND/);
 assert.equal(closed.mutations.length,0);
}
const changed=worker();const moving=await changed.start();vm.runInContext('mediaToChatDraining=true',changed.context);
await changed.context.bindMediaToChatTarget(moving.metadata,sender());changed.tabs.get(42).url=tabB.url;
vm.runInContext('mediaToChatDraining=false',changed.context);await changed.context.drainMediaToChatQueue();
assert.match((await changed.context.mediaToChatStatus(moving.task.taskId)).error,/MEDIA_TO_CHAT_TARGET_CHANGED/);assert.equal(changed.mutations.length,0);
const duplicate=worker();const ambiguous=await duplicate.start();duplicate.tabs.set(99,{id:99,url:'https://chatgpt.com/g/example/c/origin'});
await assert.rejects(duplicate.context.bindMediaToChatTarget(ambiguous.metadata,sender()),e=>e.code==='MEDIA_TO_CHAT_TARGET_AMBIGUOUS');
assert.match((await duplicate.context.mediaToChatStatus(ambiguous.task.taskId)).error,/MEDIA_TO_CHAT_TARGET_AMBIGUOUS/);assert.equal(duplicate.mutations.length,0);
// Page-supplied tab IDs cannot replace Chrome's sender identity; private nonce is required.
const invalid=worker();const protectedTask=await invalid.start();
await assert.rejects(invalid.context.bindMediaToChatTarget({...protectedTask.metadata,bindingToken:'wrong'},sender()),e=>e.code==='MEDIA_TO_CHAT_TARGET_NOT_FOUND');
await assert.rejects(invalid.context.bindMediaToChatTarget(protectedTask.metadata,{id:'another-extension',tab:tabA}),e=>e.code==='MEDIA_TO_CHAT_TARGET_NOT_FOUND');
assert.equal(invalid.mutations.length,0);
await invalid.context.mediaToChatCancel(protectedTask.task.taskId);
assert.equal(invalid.alarms.size,0);
await assert.rejects(invalid.context.bindMediaToChatTarget(protectedTask.metadata,sender()),e=>e.code==='MEDIA_TO_CHAT_TARGET_NOT_FOUND');
// Tools/list and resources/read expose the correct task template, not a media viewer.
const tool=current.context.publicMcpTools().find(tool=>tool.name==='media_to_chat');
assert.equal(tool._meta.ui.resourceUri,'ui://researchtube/chat-target-v4.html');
const resources=await current.context.handleMcpRequest({id:2,method:'resources/list'});
assert.ok(resources.result.resources.some(item=>item.uri===tool._meta.ui.resourceUri));
const resource=await current.context.readMcpResource(3,tool._meta.ui.resourceUri);
assert.equal(resource.result.contents[0].text,widget);
const mediaResource=resources.result.resources.find(item=>item.uri!==tool._meta.ui.resourceUri);
assert.equal((await current.context.readMcpResource(4,mediaResource.uri)).result.contents[0]._meta.ui.prefersBorder,true,'media_show remains a visible viewer');

// A visible compact row uses documented sizing; media presentation is separate.
assert.equal(resource.result.contents[0]._meta.ui.prefersBorder,false);
assert.equal(resource.result.contents[0]._meta['openai/widgetPrefersBorder'],false);
assert.deepEqual(JSON.parse(JSON.stringify(resource.result.contents[0]._meta['openai/ui'])),{availableDisplayModes:['inline']});
assert.equal((await current.context.readMcpResource(5,mediaResource.uri)).result.contents[0]._meta['openai/ui'],undefined,'media viewer display modes remain unchanged');
assert.match(widget,/<body><span class="brand">ResearchTube<\/span>/);
assert.match(widget,/id="status" role="status">Adding files to chat…/);
assert.match(widget,/html,body\{height:32px;margin:0;padding:0/);
assert.doesNotMatch(widget,/<body[^>]*(?:hidden|aria-hidden)|visibility:hidden|height:0|<(?:(?:img|video|audio|button))\b/);
assert.doesNotMatch(bridge,/\.style\.|\.setAttribute\(|\.closest\(|surface-collapsed|data-mcp-app-portal-target/,'the bridge must not mutate or size host containers');

// Run the real widget and content script together with a fake clock. The
// supported protocol is tested without depending on any host CSS or labels.
function pageHarness({metadata=null,runtime=null,withBridge=true,helper=true,top=false}={}) {
 const events=new Map(),attributes=new Map(),timers=[],posts=[],sizes=[],logs=[],pageMessages=[],frames=[],observers=[],cleared=new Set();
 let now=1_000, observerScan;
 class Clock extends Date {static now(){return now;}}
 const status={textContent:'Adding files to chat…'};
 const anchor={setAttribute:(key,value)=>attributes.set(key,value),getAttribute:key=>attributes.get(key),removeAttribute:key=>attributes.delete(key)};
 const window={parent:{postMessage:message=>posts.push(message)},openai:{toolResponseMetadata:metadata},
  addEventListener:(name,handler)=>{const handlers=events.get(name)??[];handlers.push(handler);events.set(name,handlers);},
  dispatchEvent:event=>{for(const handler of events.get(event.type)??[])handler(event);}};
 if(top) {window.top=window;window.parent=window;window.postMessage=message=>posts.push(message);}
 if(helper) window.openai.notifyIntrinsicHeight=value=>{assert.equal(typeof value,'number','ChatGPT height helper accepts a number');sizes.push(value);};
 const page=vm.createContext({window,document:{getElementById:id=>id==='anchor'?anchor:status,querySelector:()=>attributes.has('data-researchtube-chat-target')?anchor:null,querySelectorAll:()=>frames},
  URL,Date:Clock,Set,Map,JSON,Promise,console:{info:line=>logs.push(line)},
  CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},
  MutationObserver:class {constructor(fn){observerScan=fn;this.fn=fn;observers.push(this);}observe(root,options){this.root=root;this.options=options;}disconnect(){this.root=null;}},
  setInterval:fn=>{timers.push(fn);return timers.length;},clearInterval:id=>cleared.add(id),
  chrome:{runtime:{sendMessage:message=>{pageMessages.push(message);return runtime?runtime(message):Promise.resolve({ok:true});}}}
 });
 if(withBridge) vm.runInContext(bridge,page);
 vm.runInContext(widget.match(/<script>([\s\S]*?)<\/script>/)[1],page);
 const message=value=>window.dispatchEvent({type:'message',source:window.parent,data:value});
 return {window,page,frames,posts,sizes,logs,pageMessages,attributes,anchor,status,observers,scan:()=>observerScan?.(),
  tickAll:()=>timers.forEach((fn,index)=>{if(!cleared.has(index+1))fn();}),
  tick:()=>timers[0](),advance:ms=>now+=ms,message,
  globals:value=>window.dispatchEvent({type:'openai:set_globals',detail:{globals:{toolResponseMetadata:value}}}),
  local:value=>window.dispatchEvent({type:'researchtube-chat-target-result',detail:value})
 };
}
const domWorker=worker();const domTask=await domWorker.start();vm.runInContext('mediaToChatDraining=true',domWorker.context);
const h=pageHarness({runtime:message=>domWorker.receive(message,sender())});
assert.equal(h.pageMessages.length,0,'initial empty metadata must not invent a tab binding');
h.message({jsonrpc:'2.0',id:'researchtube-chat-target-initialize',result:{}});
assert.ok(h.posts.some(message=>message.method==='ui/notifications/size-changed' && message.params.height===32));
assert.ok(h.sizes.length>0);assert.ok(h.sizes.every(value=>value===32));
h.window.openai.toolResponseMetadata={mcp_tool_result:{_meta:{'researchtube/chatTarget':domTask.metadata}}};
h.tick();await settle();await settle();
assert.equal(h.pageMessages.length,1);assert.equal(h.pageMessages[0].taskId,domTask.task.taskId);assert.equal('tabId' in h.pageMessages[0],false);
assert.equal(h.attributes.has('data-researchtube-chat-target'),false);
assert.ok(!h.posts.some(message=>message.method==='tools/call'),'binding must not call another model tool');
assert.equal(h.status.textContent,'Adding files to chat…','binding must not falsely claim Send completion');
const callsAfterBound=h.pageMessages.length;h.tick();assert.equal(h.pageMessages.length,callsAfterBound,'successful handshake stops polling');
// Late content-script injection must recover the private marker without an event.
const late=pageHarness({metadata:{'researchtube/chatTarget':domTask.metadata},withBridge:false});
assert.equal(late.pageMessages.length,0);assert.equal(late.attributes.has('data-researchtube-chat-target'),true);
vm.runInContext(bridge,late.page);await settle();await settle();
assert.equal(late.pageMessages.length,1);assert.equal(late.attributes.has('data-researchtube-chat-target'),false);
// Host notifications work without the optional window.openai height helper.
const standard=pageHarness({helper:false});
standard.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{_meta:{'researchtube/chatTarget':domTask.metadata}}});await settle();
assert.equal(standard.pageMessages.length,1);
standard.message({jsonrpc:'2.0',id:'researchtube-chat-target-initialize',result:{}});
standard.message({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme:'dark'}});
assert.ok(standard.posts.filter(item=>item.method==='ui/notifications/size-changed').length>=2);
// A transient synchronous runtime failure is retried. Unrelated replies are ignored.
let attempts=0;
const retry=pageHarness({runtime:()=>{if(++attempts===1)throw new Error('stale extension context');return Promise.resolve({ok:true});}});
retry.globals({_meta:{'researchtube/chatTarget':domTask.metadata}});await settle();await settle();
assert.equal(retry.attributes.has('data-researchtube-chat-target'),true);
retry.local({source:'researchtube-chat-target-widget',taskId:'tsk_XXXXXXXXXX',ok:true});
assert.equal(retry.attributes.has('data-researchtube-chat-target'),true);
retry.tick();await settle();await settle();assert.equal(attempts,2);assert.equal(retry.attributes.has('data-researchtube-chat-target'),false);
// Stable binding errors stop and show a short message without resizing the row.
const rejected=pageHarness({runtime:()=>Promise.resolve({ok:false,errorCode:'MEDIA_TO_CHAT_TARGET_NOT_FOUND',error:'closed'})});
rejected.globals({'researchtube/chatTarget':domTask.metadata});await settle();await settle();rejected.tick();
assert.equal(rejected.pageMessages.length,1);assert.match(rejected.logs[0],/MEDIA_TO_CHAT_TARGET_NOT_FOUND/);
assert.equal(rejected.attributes.has('data-researchtube-chat-target'),false);
assert.equal(rejected.status.textContent,'Unable to add files. Check task status.');
assert.ok(rejected.sizes.every(value=>value===32));
const timeout=pageHarness({withBridge:false});timeout.advance(30_001);timeout.tick();
assert.match(timeout.logs[0],/timed out/);assert.equal(timeout.pageMessages.length,0);
assert.equal(timeout.status.textContent,'Unable to identify this chat. Check task status.');
// The bridge can bind through the exact child frame without changing any
// iframe, portal, spacer or conversation styles, even with a 480px host reserve.
const parent=pageHarness({top:true});
const replies=[];
const ready={source:'researchtube-chat-target-widget',...domTask.metadata};
const child={postMessage:message=>replies.push(message)};
function untouchedHost() {
 return {style:{setProperty(){throw new Error('host style changed');}},
  setAttribute(){throw new Error('host attribute changed');},
  closest(){throw new Error('host ancestors inspected');},
  parentElement:{style:{setProperty(){throw new Error('conversation style changed');}}}};
}
const ownFrame={...untouchedHost(),contentWindow:child};
const unrelated={...untouchedHost(),contentWindow:{}};
parent.frames.push(unrelated,ownFrame);
parent.window.dispatchEvent({type:'message',source:{},origin:'null',data:ready});await settle();
parent.window.dispatchEvent({type:'message',source:child,origin:'https://unrelated.example',data:ready});await settle();
assert.equal(parent.pageMessages.length,0,'unknown source or origin must not bind');
parent.window.dispatchEvent({type:'message',source:child,origin:'null',data:ready});await settle();await settle();
assert.equal(parent.pageMessages.length,1);
assert.ok(replies.some(item=>item.type==='binding-result' && item.ok));
assert.equal(parent.frames.length,2,'host nodes remain mounted');
assert.equal(parent.observers.length,0,'the top conversation must not be observed or restyled');
assert.ok(parent.posts.every(item=>item.jsonrpc==='2.0'),'no private sizing relay goes through ancestor frames');
// The documented sandbox origin also binds without modifying its host frame.
const sandbox=pageHarness({top:true});const sandboxChild={postMessage(){}};
sandbox.frames.push({...untouchedHost(),contentWindow:sandboxChild});
sandbox.window.dispatchEvent({type:'message',source:sandboxChild,origin:'https://mcp-app-test.web-sandbox.oaiusercontent.com',data:ready});await settle();
assert.equal(sandbox.pageMessages.length,1);
console.log('chat target: visible 32px row, numeric height helper, no host CSS mutations, bounded retries and fixed tab binding passed');

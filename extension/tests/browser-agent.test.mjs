import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createBrowserAgent,waitForBrowserDocument,waitForBrowserConversation} from '../browser-agent.js';
import {browserToolDefinitions,validateBrowserInput} from '../browser-tools.js';
import {assertSchema} from './fixtures/schema-check.mjs';
globalThis.crypto ||= webcrypto;
const definitions=browserToolDefinitions();
const checkSchema=(name,value)=>assertSchema(definitions.find(tool=>tool.name===name).outputSchema,value,name);
const attr=value=>({value});
const ax=(nodeId,role,name,childIds=[],backendDOMNodeId=Number(nodeId)+100)=>({nodeId,role:attr(role),name:attr(name),childIds,backendDOMNodeId,ignored:false});
const initialTree=[ax('1','RootWebArea','Site',['2']),ax('2','generic','',['3','4','5','6','7']),ax('3','heading','Article',['8']),ax('4','image','Diagram'),ax('5','textbox','Search'),ax('6','combobox','Choice'),ax('7','button','Open'),ax('8','StaticText','Detailed content',['9']),ax('9','InlineTextBox','Detailed content')];
for(const raw of initialTree)for(const child of raw.childIds)initialTree.find(node=>node.nodeId===child).parentId=raw.nodeId;
function fixture(){
 let nextTab=20,tree=structuredClone(initialTree),clock=1_700_000_000_000;
 const tabs=new Map([[10,{id:10,url:'https://site.test/article?token=PRIVATE',title:'Site',active:true,index:3,windowId:2}]]);
 const events=[],scheduled=[],uploads=[],saved=[],logs=[],domValues=new Map();let closed=false,failOriginal=false,tooLarge=false,onAttach=null,onSave=null;
 const host={now:()=>clock,sleep:async()=>{clock+=500;await new Promise(resolve=>setImmediate(resolve));},getTab:async id=>{if(!tabs.has(id))throw Error('closed');return tabs.get(id);},
 duplicateTab:async id=>{const tab={...tabs.get(id),id:++nextTab,active:false,index:4};tabs.set(tab.id,tab);events.push(['duplicate',id]);return tab;},restoreSource:async id=>events.push(['restore',id]),
 createChatTab:async(source,agent)=>{const tab={id:++nextTab,url:'https://chatgpt.com/',index:5,windowId:2,active:false};tabs.set(tab.id,tab);events.push(['createChat',source.id,agent.id]);return tab;},waitReady:async id=>events.push(['documentReady',id]),
 attach:async id=>events.push(['attach',id]),detach:async id=>events.push(['detach',id]),conversationPath:url=>url.match(/\/c\/[^/]+/)?.[0]||null,
 startChat:async(id,prompt)=>{events.push(['prompt',id,prompt]);tabs.get(id).url='https://chatgpt.com/c/study'+id;return '/c/study'+id;},
 updateStatus:async(ids,status)=>events.push(['toolbar',ids,structuredClone(status)]),resourceLimit:async()=>1024,historyLimit:()=>2,schedule:work=>scheduled.push(work),log:(label,value)=>logs.push({label,value}),
 saveResource:async(taskId,bytes,mimeType)=>{saved.push({taskId,bytes,mimeType});await onSave?.();return {workspacePath:`browser-resources/${taskId}.png`,mimeType:'image/png',sizeBytes:bytes.length};},
 resolveFiles:async paths=>paths.map(path=>'/PRIVATE/'+path),
 attachFiles:async(files,options)=>{uploads.push({files,options});options.checkCancelled();await options.onPhase('composerAccepted');await onAttach?.(options);await options.beforeSend();options.checkCancelled();options.onSendCommit();},
 command:async(tabId,method,params={},childSessionId)=>{events.push([method,tabId,params,childSessionId]);if(closed)throw Error('detached');
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:childSessionId?'childFrame':'main',url:tabs.get(tabId)?.url}}};
  if(method==='Page.createIsolatedWorld')return {executionContextId:44};
  if(method==='Page.addScriptToEvaluateOnNewDocument')return {identifier:'overlay'};
  if(method==='Accessibility.getFullAXTree')return {nodes:structuredClone(tree)};
  if(method==='Accessibility.getPartialAXTree')return {nodes:structuredClone(tree.filter(node=>node.backendDOMNodeId===params.backendNodeId))};
  if(method==='DOM.resolveNode')return {object:{objectId:String(params.backendNodeId)}};
  if(method==='Runtime.callFunctionOn'){
   const id=Number(params.objectId),args=params.arguments.map(arg=>arg.value);
   if(params.functionDeclaration.includes('function inspectBrowserElement'))return {result:{value:{tag:id===104?'img':id===105?'input':id===106?'select':'div',attributes:[],bounds:{x:10,y:20,width:50,height:40},resources:id===104?[{kind:'image',url:'https://cdn.test/image.png?signature=PRIVATE',rendering:null}]:[],editable:id===105,password:false}}};
   if(params.functionDeclaration.includes('elementFromPoint'))return {result:{value:true}};
   if(params.functionDeclaration.includes('this.options'))return {result:{value:args[0]==='a'}};
   if(params.functionDeclaration.includes('this.value'))return {result:{value:domValues.get(id)}};
   return {result:{value:null}};
  }
  if(method==='DOM.focus'){host.focus=params.backendNodeId;return {};}
  if(method==='Input.insertText'){domValues.set(host.focus,params.text);return {};}
  if(method==='DOM.getBoxModel')return {model:{content:[10,20,60,20,60,60,10,60]}};
  if(method==='Page.getLayoutMetrics')return {cssVisualViewport:{pageX:0,pageY:0,clientWidth:800,clientHeight:600}};
  if(method==='Network.loadNetworkResource'){if(failOriginal)throw Error('CORS');return {resource:{success:true,stream:'stream',headers:{'Content-Type':'image/png'}}};}
  if(method==='IO.read')return {data:Buffer.from(tooLarge?new Uint8Array(1025):[137,80,78,71,13,10,26,10]).toString('base64'),base64Encoded:true,eof:true};
  if(method==='Page.getResourceContent')throw Error('cache missing');
  if(method==='Page.captureScreenshot')return {data:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')};
  return {};
 }
 };
 const agent=createBrowserAgent(host);
 const run=async(name,args)=>{const result=await agent.execute(name,args);checkSchema(name,result);return result;};
 return {agent,run,host,tabs,events,scheduled,uploads,saved,logs,setTree:value=>tree=value,setOriginalFailure:()=>failOriginal=true,setTooLarge:()=>tooLarge=true,onAttach:fn=>onAttach=fn,onSave:fn=>onSave=fn};
}
const f=fixture();const started=await f.agent.start(10),sessionId=started.session.sessionId;
assert.match(sessionId,/^bas_[A-Za-z0-9_-]{10}$/);checkSchema('browser_session_status',started.session);
assert.deepEqual(f.events.filter(e=>['duplicate','restore','createChat'].includes(e[0])).map(e=>e[0]),['duplicate','restore','createChat']);
assert.equal(f.tabs.size,3);assert.equal(f.tabs.get(10).url,'https://site.test/article?token=PRIVATE');
assert.ok(!f.events.some(e=>e[0]==='Accessibility.getFullAXTree'),'startup does not require a full AX read');
assert.ok(!f.events.some(e=>['Runtime.addBinding','Page.addScriptToEvaluateOnNewDocument','Page.createIsolatedWorld'].includes(e[0])),'no controls injected into studied page');
assert.ok(f.events.findIndex(e=>e[0]==='Emulation.setFocusEmulationEnabled') < f.events.findIndex(e=>e[0]==='documentReady'),'focus emulation precedes waiting');
assert.deepEqual(Object.keys(f.agent.localStatus(21)).sort(),['error','phase','state','statusMessage']);assert.equal(f.agent.localStatus(10),null,'the source is not controlled');
const obs=await f.run('browser_observe',{sessionId,mode:'full'});
assert.equal(obs.nodes.length,7,'ignore generic wrappers and redundant inline text without losing hierarchy');
assert.equal(obs.page.url,'https://site.test/article');assert.ok(!JSON.stringify(obs).includes('PRIVATE'));
const byRole=role=>obs.nodes.find(node=>node.role===role);
assert.deepEqual(byRole('heading').childIds,[byRole('StaticText').nodeId]);assert.equal(byRole('StaticText').parentId,byRole('heading').nodeId);
const text=await f.run('browser_get_text',{sessionId,nodeId:byRole('heading').nodeId,limit:8});assert.equal(text.text,'Detailed');assert.equal(text.nextOffset,8);
const slice=await f.run('browser_get_children',{sessionId,nodeId:obs.roots[0],depth:1,maxNodes:2});assert.equal(slice.nodes.length,2);assert.equal(slice.nextOffset,2);
const inspect=await f.run('browser_get_node',{sessionId,nodeId:byRole('image').nodeId});const resourceId=inspect.dom.resources[0].resourceId;
assert.ok(!JSON.stringify(inspect).includes('PRIVATE'));
for(const [action,parameters] of [['hover',{}],['click',{}],['key',{key:'Ctrl+A'}],['scroll',{direction:'down',amount:123}]])await f.run('browser_act',{sessionId,action,nodeId:byRole('button').nodeId,...parameters});
await f.run('browser_act',{sessionId,action:'type',nodeId:byRole('textbox').nodeId,text:'Search text'});
await f.run('browser_act',{sessionId,action:'select',nodeId:byRole('combobox').nodeId,value:'a'});
const inputEvents=f.events.filter(event=>event[0]==='Input.dispatchKeyEvent');assert.ok(inputEvents.some(event=>event[2].code==='KeyA'&&event[2].windowsVirtualKeyCode===65&&event[2].modifiers===2));
await f.run('browser_session_pause',{sessionId});await f.run('browser_observe',{sessionId});await assert.rejects(f.run('browser_act',{sessionId,action:'click',nodeId:byRole('button').nodeId}),{code:'BROWSER_SESSION_PAUSED'});await f.run('browser_session_resume',{sessionId});
const queued=await f.run('browser_get_resource',{sessionId,resourceId});assert.equal(queued.status,'queued');assert.match(queued.taskId,/^tsk_[A-Za-z0-9_-]{10}$/);await f.scheduled.shift()();
const finished=await f.run('browser_resource_status',{sessionId,taskId:queued.taskId});assert.equal(finished.status,'completed');assert.equal(finished.extraction,'original');assert.equal(finished.progressPercent,100);assert.equal(finished.submittedFiles.length,1);
assert.equal(f.uploads[0].options.target.tabId,22);assert.equal(f.uploads[0].options.target.chatPath,'/c/study22');assert.match(f.uploads[0].options.continuation,new RegExp(resourceId));assert.ok(!JSON.stringify(finished).includes('PRIVATE'));
assert.equal((await f.run('browser_resource_cancel',{sessionId,taskId:queued.taskId})).cancelled,false);
const cancellation=await f.run('browser_get_resource',{sessionId,resourceId});assert.equal((await f.run('browser_resource_cancel',{sessionId,taskId:cancellation.taskId})).cancelled,true);await f.scheduled.shift()();assert.equal((await f.run('browser_resource_status',{sessionId,taskId:cancellation.taskId})).status,'cancelled');assert.equal(f.saved.length,1,'queued cancellation creates nothing');
f.setOriginalFailure();const fallback=await f.run('browser_get_resource',{sessionId,resourceId,addToChat:false});await f.scheduled.shift()();assert.equal((await f.run('browser_resource_status',{sessionId,taskId:fallback.taskId})).extraction,'element-screenshot');assert.equal(f.uploads.length,1);
const screenshot=f.events.find(event=>event[0]==='Page.captureScreenshot');assert.equal(screenshot[2].captureBeyondViewport,false);assert.ok(screenshot[2].clip);
await f.agent.onEvent({tabId:21},'Page.frameNavigated',{frame:{id:'main',url:'https://site.test/next'}});f.tabs.get(21).url='https://site.test/next';
await assert.rejects(f.run('browser_get_node',{sessionId,nodeId:byRole('image').nodeId}),{code:'PAGE_CHANGED'});
await f.run('browser_observe',{sessionId});
await f.agent.onEvent({tabId:21},'Target.attachedToTarget',{sessionId:'child',targetInfo:{type:'iframe'}});assert.ok(f.events.some(event=>event[0]==='Target.setAutoAttach'&&event[3]==='child'));
await f.agent.onRemoved(10);assert.equal((await f.run('browser_session_status',{sessionId})).state,'running','closing original source leaves duplicated session running');
await f.run('browser_session_stop',{sessionId});assert.equal(f.tabs.size,3,'Stop never closes tabs');await assert.rejects(f.run('browser_observe',{sessionId}),{code:'BROWSER_SESSION_STOPPED'});
const g=fixture();const sid=(await g.agent.start(10)).session.sessionId;const image=(await g.run('browser_observe',{sessionId:sid,mode:'full'})).nodes.find(node=>node.role==='image');
g.setTooLarge();const large=await g.run('browser_get_resource',{sessionId:sid,resourceId:image.resources[0].resourceId});await g.scheduled.shift()();assert.equal((await g.run('browser_resource_status',{sessionId:sid,taskId:large.taskId})).error.code,'BROWSER_RESOURCE_TOO_LARGE');assert.ok(g.events.some(event=>event[0]==='IO.close'));
g.tabs.delete(22);await g.agent.onRemoved(22);assert.equal((await g.run('browser_session_status',{sessionId:sid})).error.code,'TAB_CLOSED');assert.equal(g.uploads.length,0);
const h=fixture();const hsid=(await h.agent.start(10)).session.sessionId;const himage=(await h.run('browser_observe',{sessionId:hsid,mode:'full'})).nodes.find(node=>node.role==='image');
const htask=await h.run('browser_get_resource',{sessionId:hsid,resourceId:himage.resources[0].resourceId});h.onAttach(async()=>{await h.run('browser_resource_cancel',{sessionId:hsid,taskId:htask.taskId});});await h.scheduled.shift()();const hc=await h.run('browser_resource_status',{sessionId:hsid,taskId:htask.taskId});assert.equal(hc.status,'cancelled');assert.ok(hc.workspacePath);assert.equal(hc.submittedAt,null,'cancellation preserves saved file and avoids Send');
const changed=structuredClone(initialTree);changed.find(node=>node.nodeId==='7').name.value='Different action';h.setTree(changed);const oldButton=(await h.run('browser_observe',{sessionId:hsid})).nodes.find(node=>node.role==='button');changed.find(node=>node.nodeId==='7').name.value='Repurposed action';await assert.rejects(h.run('browser_act',{sessionId:hsid,action:'click',nodeId:oldButton.nodeId}),{code:'STALE_NODE'});const newButton=(await h.run('browser_observe',{sessionId:hsid})).nodes.find(node=>node.role==='button');assert.notEqual(newButton.nodeId,oldButton.nodeId);

const j=fixture();const jsid=(await j.agent.start(10)).session.sessionId;
await j.agent.control(21,'pause');assert.equal(j.agent.localStatus(22).state,'paused');
await j.agent.control(22,'resume');assert.equal(j.agent.localStatus(21).state,'running');
await assert.rejects(j.agent.control(10,'stop'),{code:'BROWSER_SESSION_NOT_FOUND'});
await j.agent.onEvent({tabId:21},'Runtime.bindingCalled',{name:'researchtubeBrowserControl',executionContextId:44,payload:'{"action":"stop"}'});
assert.equal((await j.run('browser_session_status',{sessionId:jsid})).state,'running','page events cannot spoof popup controls');
const second=(await j.agent.start(10)).session.sessionId;await j.agent.control(24,'pause');
assert.equal((await j.run('browser_session_status',{sessionId:jsid})).state,'running');assert.equal((await j.run('browser_session_status',{sessionId:second})).state,'paused','popup routes each session by exact bound tab');
await j.agent.control(23,'stop');assert.equal(j.agent.localStatus(24).state,'stopped');assert.equal(j.agent.localStatus(21).state,'running');
await j.agent.onDetached({tabId:21});assert.equal((await j.run('browser_session_status',{sessionId:jsid})).error.code,'DEBUGGER_DETACHED');

// A slow site remains status=loading for over 45 seconds, but its interactive
// document is usable; unrelated subresources must not delay prompt creation.
let time=0,reads=0;const readyHost={now:()=>time,sleep:async ms=>{time+=ms;},getTab:async()=>({url:'https://site.test/slow',status:'loading'}),command:async(id,method,params)=>{
 assert.equal(id,31);assert.equal(method,'Runtime.evaluate');reads++;
 if(time===0)throw Error('context replaced');
 return {result:{value:time>=60000}};
}};
await waitForBrowserDocument(readyHost,31);assert.equal(time,60000);assert.ok(reads>1);
time=0;let stopped=false;await assert.rejects(waitForBrowserDocument({...readyHost,sleep:async ms=>{time+=ms;stopped=true;}},31,()=>{if(stopped)throw Object.assign(Error('stopped'),{code:'BROWSER_SESSION_STOPPED'});}),{code:'BROWSER_SESSION_STOPPED'});
await assert.rejects(waitForBrowserDocument({...readyHost,getTab:async()=>{throw Error('closed');}},31),{code:'TAB_CLOSED'});
time=0;await assert.rejects(waitForBrowserDocument({...readyHost,command:async()=>({result:{value:false}})},31,()=>{},{timeoutMs:1000}),{code:'BROWSER_UNAVAILABLE'});
time=0;reads=0;await assert.rejects(waitForBrowserDocument(readyHost,31,()=>{},{timeoutMs:1000,requiredOrigin:'https://chatgpt.com'}),{code:'BROWSER_UNAVAILABLE'});assert.equal(reads,0,'do not evaluate a wrong-origin document');

// Real startup regression: local-chatgpt is a temporary ID, not a saved chat.
const provisional=fixture();let conversationTime=0;
const savedPath='/c/6ac5bd00-4afc-83ec-bc43-af42f6606a3d';
const temporaryPath='/c/local-chatgpt%3Aad857451-d377-4572-b9e2-aee13e7f29e9';
provisional.tabs.set(81,{id:81,url:'https://chatgpt.com/c/other',active:false,windowId:99});
provisional.host.startChat=async(id,prompt,check)=>{
 assert.equal(id,22);assert.match(prompt,/bas_[A-Za-z0-9_-]{10}/);
 return waitForBrowserConversation({now:()=>conversationTime,
  getTab:async tabId=>{assert.equal(tabId,22);return provisional.tabs.get(tabId);},
  conversationPath:provisional.host.conversationPath,log:provisional.host.log,
  sleep:async ms=>{
   conversationTime+=ms;
   for(const tab of provisional.tabs.values())tab.active=tab.id===81;
   provisional.tabs.get(id).url='https://chatgpt.com'+(conversationTime<3000?temporaryPath:savedPath);
   await provisional.agent.onUpdated(id,{url:provisional.tabs.get(id).url});
  }
 },id,check);
};
const provisionalId=(await provisional.agent.start(10)).session.sessionId;
assert.equal(conversationTime,3000,'do not bind a temporary conversation');
assert.equal(provisional.agent.localStatus(22).state,'running');
assert.equal(provisional.logs.filter(e=>e.label==='waiting for saved conversation').length,1);
assert.equal(provisional.logs.find(e=>e.label==='conversation confirmed').value.chatPath,savedPath);
await provisional.agent.onUpdated(22,{url:'https://chatgpt.com'+temporaryPath});
const provisionalImage=(await provisional.run('browser_observe',{sessionId:provisionalId})).nodes.find(node=>node.role==='image');
await provisional.run('browser_get_resource',{sessionId:provisionalId,resourceId:provisionalImage.resources[0].resourceId});
await provisional.scheduled.shift()();
assert.equal(provisional.uploads[0].options.target.chatPath,savedPath);
assert.equal(provisional.uploads[0].options.target.tabId,22);
assert.equal(provisional.tabs.get(81).active,true);
provisional.tabs.get(22).url='https://chatgpt.com/c/unrelated';
await provisional.agent.onUpdated(22,{url:provisional.tabs.get(22).url});
assert.equal(provisional.agent.localStatus(22).error.code,'BROWSER_CHAT_CHANGED','saved conversation still cannot be replaced');
const conversationHost={now:()=>conversationTime,sleep:async ms=>{conversationTime+=ms;},
 getTab:async()=>({url:'https://chatgpt.com'+temporaryPath}),conversationPath:provisional.host.conversationPath};
conversationTime=0;
await assert.rejects(waitForBrowserConversation(conversationHost,22,()=>{},{timeoutMs:1000}),{code:'BROWSER_CHAT_NOT_FOUND'});
conversationTime=0;
await assert.rejects(waitForBrowserConversation({...conversationHost,getTab:async()=>({url:'https://chatgpt.com/c/local-chatgpt:uuid'})},22,()=>{},{timeoutMs:1000}),{code:'BROWSER_CHAT_NOT_FOUND'});
await assert.rejects(waitForBrowserConversation({...conversationHost,getTab:async()=>{throw Error('closed');}},22),{code:'TAB_CLOSED'});
conversationTime=0;
await assert.rejects(waitForBrowserConversation(conversationHost,22,()=>{if(conversationTime>=250)throw Object.assign(Error('stopped'),{code:'BROWSER_SESSION_STOPPED'});}),{code:'BROWSER_SESSION_STOPPED'});
// Cancellation arriving during the last getTab cannot publish a successful binding.
let stopDuringRead=false;
await assert.rejects(waitForBrowserConversation({...conversationHost,getTab:async()=>{stopDuringRead=true;return {url:'https://chatgpt.com'+savedPath};}},22,()=>{if(stopDuringRead)throw Object.assign(Error('stopped'),{code:'BROWSER_SESSION_STOPPED'});}),{code:'BROWSER_SESSION_STOPPED'});
for(const tool of definitions)assert.equal(tool.inputSchema.properties.sessionId.pattern,'^bas_[A-Za-z0-9_-]{10}$');
assert.throws(()=>validateBrowserInput('browser_session_status',{sessionId:'bs_abcdefghij'}),{code:'BROWSER_INVALID'});

const slow=fixture();let release;
slow.host.waitReady=async(id,check)=>{await new Promise(resolve=>{release=resolve;});check();};
const starting=slow.agent.start(10);await new Promise(resolve=>setImmediate(resolve));
assert.equal(slow.agent.localStatus(21).phase,'waitingForPage');await slow.agent.control(22,'stop');release();
await assert.rejects(starting,{code:'BROWSER_SESSION_STOPPED'});assert.ok(!slow.events.some(e=>e[0]==='prompt'));assert.ok(slow.events.some(e=>e[0]==='detach'));assert.equal(slow.agent.localStatus(22).state,'stopped');
const failed=fixture();failed.host.waitReady=async()=>{throw Object.assign(Error('The site document did not become ready.'),{code:'BROWSER_UNAVAILABLE'});};
await assert.rejects(failed.agent.start(10),{code:'BROWSER_UNAVAILABLE',message:'The site document did not become ready.'});
assert.equal(failed.agent.localStatus(22).error.message,'The site document did not become ready.');assert.equal(failed.logs.find(e=>e.label==='startup failed').value.phase,'waitingForPage');
// The user can leave the original window while initialization is waiting.
// Reading/actions/resources stay on the saved agent/chat IDs, not active tabs.
const switched=fixture();let finishLoading;
switched.tabs.set(81,{id:81,url:'https://chatgpt.com/c/other-window',active:false,windowId:99});
switched.host.waitReady=async(id,check)=>{assert.equal(id,21);await new Promise(resolve=>{finishLoading=resolve;});check();};
const switchedStartup=switched.agent.start(10);await new Promise(resolve=>setImmediate(resolve));
for(const tab of switched.tabs.values())tab.active=tab.id===81;
await switched.agent.onUpdated(81,{url:'https://chatgpt.com/c/another-chat'});finishLoading();
const switchedId=(await switchedStartup).session.sessionId;
assert.equal(switched.events.find(e=>e[0]==='prompt')[1],22,'startup prompt stays in the created chat');
await switched.agent.onUpdated(81,{url:'https://chatgpt.com/c/another-chat'});
const switchedObservation=await switched.run('browser_observe',{sessionId:switchedId});
assert.ok(switched.events.filter(e=>e[0]==='Accessibility.getFullAXTree').every(e=>e[1]===21));
const switchedImage=switchedObservation.nodes.find(node=>node.role==='image');
const switchedTask=await switched.run('browser_get_resource',{sessionId:switchedId,resourceId:switchedImage.resources[0].resourceId});
await switched.scheduled.shift()();assert.equal(switched.uploads[0].options.target.tabId,22);assert.equal(switched.uploads[0].options.target.chatPath,'/c/study22');
assert.equal(switched.tabs.get(81).active,true,'automation does not activate its tabs');
assert.equal((await switched.run('browser_session_status',{sessionId:switchedId})).state,'running');
// Chrome may deliver an earlier URL snapshot after bootstrap bound /c/study.
// The actual owned tab, not that queued event, defines the current conversation.
const route=fixture();const routeId=(await route.agent.start(10)).session.sessionId;
await route.agent.onUpdated(22,{url:'https://chatgpt.com/'});
await route.agent.onUpdated(22,{url:'https://chatgpt.com/c/provisional'});
assert.equal((await route.run('browser_session_status',{sessionId:routeId})).state,'running');
assert.equal(route.agent.localStatus(22).state,'running');
assert.ok(route.logs.some(e=>e.label==='outdated conversation event ignored'));
const routeImage=(await route.run('browser_observe',{sessionId:routeId})).nodes.find(node=>node.role==='image');
const routeTask=await route.run('browser_get_resource',{sessionId:routeId,resourceId:routeImage.resources[0].resourceId});await route.scheduled.shift()();
assert.equal(route.uploads[0].options.target.tabId,22);assert.equal(route.uploads[0].options.target.chatPath,'/c/study22','stale events never change the delivery destination');
route.tabs.get(22).url='https://chatgpt.com/c/unrelated';
// Even an event still reporting the bound chat must not mask live navigation.
await route.agent.onUpdated(22,{url:'https://chatgpt.com/c/study22'});
assert.equal((await route.run('browser_session_status',{sessionId:routeId})).state,'failed');
assert.equal(route.agent.localStatus(22).error.code,'BROWSER_CHAT_CHANGED');
const mismatch=route.logs.find(e=>e.label==='conversation mismatch');
assert.equal(mismatch.value.trigger,'tabUpdated');assert.equal(mismatch.value.expectedChatPath,'/c/study22');assert.equal(mismatch.value.actualChatPath,'/c/unrelated');
await assert.rejects(route.run('browser_observe',{sessionId:routeId}),{code:'BROWSER_CHAT_CHANGED'});
const missing=fixture();await missing.agent.start(10);missing.tabs.delete(22);await missing.agent.onUpdated(22,{url:'https://chatgpt.com/c/other'});assert.equal(missing.agent.localStatus(21).error.code,'TAB_CLOSED');
const toolMismatch=fixture();const toolMismatchId=(await toolMismatch.agent.start(10)).session.sessionId;toolMismatch.tabs.get(22).url='https://chatgpt.com/c/another';
await assert.rejects(toolMismatch.run('browser_observe',{sessionId:toolMismatchId}),{code:'BROWSER_CHAT_CHANGED'});
assert.equal(toolMismatch.logs.find(e=>e.label==='conversation mismatch').value.trigger,'tool');
for(const args of [{sessionId,depth:21},{sessionId,offset:-1},{sessionId,unknown:true},{sessionId,mode:'subtree'}])assert.throws(()=>validateBrowserInput('browser_observe',args),{code:'BROWSER_INVALID'});
assert.throws(()=>validateBrowserInput('browser_act',{sessionId,action:'click',nodeId:'n_1_3',text:'bad'}),{code:'BROWSER_INVALID'});
assert.throws(()=>validateBrowserInput('browser_resource_status',{sessionId,taskId:'chat_UUID'}),{code:'BROWSER_INVALID'});
await assert.rejects(f.agent.execute('browser_observe',{sessionId:'bas_abcdefghij'}),{code:'BROWSER_SESSION_NOT_FOUND'});
console.log('Browser Agent: schemas, AX hierarchy, private resources, CDP input, exact tabs, navigation, toolbar, startup readiness, pause, cancellation, fallback and Stop: ok');

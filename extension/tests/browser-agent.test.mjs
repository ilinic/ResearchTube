import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createBrowserAgent,waitForBrowserDocument,waitForBrowserConversation,browserStudyGroupTitle} from '../browser-agent.js';
import {browserToolDefinitions,validateBrowserInput} from '../browser-tools.js';
import {assertSchema} from './fixtures/schema-check.mjs';
globalThis.crypto ||= webcrypto;
const definitions=browserToolDefinitions();
const checkSchema=(name,value)=>assertSchema(definitions.find(tool=>tool.name===name).outputSchema,value,name);
const attr=value=>({value});
const ax=(nodeId,role,name,childIds=[],backendDOMNodeId=Number(nodeId)+100)=>({nodeId,role:attr(role),name:attr(name),childIds,backendDOMNodeId,ignored:false});
const initialTree=[ax('1','RootWebArea','Site',['2']),ax('2','generic','',['3','4','5','6','7']),ax('3','heading','Article',['8']),ax('4','image','Diagram'),ax('5','textbox','Search'),ax('6','combobox','Choice'),ax('7','button','Open'),ax('8','StaticText','Detailed content',['9']),ax('9','InlineTextBox','Detailed content')];
for(const raw of initialTree)for(const child of raw.childIds)initialTree.find(node=>node.nodeId===child).parentId=raw.nodeId;
function fixture({multipleImages=false,nonImages=false}={}){
 let nextTab=20,tree=structuredClone(initialTree),clock=1_700_000_000_000;
 if(multipleImages){
  tree.find(node=>node.nodeId==='2').childIds.push('10','11');
  for(const id of ['10','11'])tree.push({...ax(id,'image','Additional diagram'),parentId:'2'});
 }
 if(nonImages){
  tree.find(node=>node.nodeId==='2').childIds.push('12','13','14');
  for(const [id,role] of [['12','link'],['13','audio'],['14','video']])tree.push({...ax(id,role,'Download '+role),parentId:'2'});
 }
 const media = {
  document: {mimeType:'application/pdf',ext:'pdf',bytes:Buffer.from('%PDF-1.7\nexample')},
  audio: {mimeType:'audio/mpeg',ext:'mp3',bytes:Buffer.from('ID3example')},
  video: {mimeType:'video/mp4',ext:'mp4',bytes:Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109])}
 };
 const tabs=new Map([[10,{id:10,url:'https://site.test/article?token=PRIVATE',title:'Site',active:true,index:3,windowId:2}]]);
 const events=[],scheduled=[],uploads=[],saved=[],logs=[],domValues=new Map();let closed=false,failOriginal=false,tooLarge=false,onAttach=null,onSave=null;
 const host={now:()=>clock,sleep:async()=>{clock+=500;await new Promise(resolve=>setImmediate(resolve));},getTab:async id=>{if(!tabs.has(id))throw Error('closed');return tabs.get(id);},
 duplicateTab:async id=>{const tab={...tabs.get(id),id:++nextTab,active:false,index:4};tabs.set(tab.id,tab);events.push(['duplicate',id]);return tab;},restoreSource:async id=>events.push(['restore',id]),
 createChatTab:async(source,agent)=>{const tab={id:++nextTab,url:'https://chatgpt.com/',index:5,windowId:2,active:false};tabs.set(tab.id,tab);events.push(['createChat',source.id,agent.id]);return tab;},waitReady:async id=>events.push(['documentReady',id]),
 attach:async id=>events.push(['attach',id]),detach:async id=>events.push(['detach',id]),conversationPath:url=>url.match(/\/c\/[^/]+/)?.[0]||null,
 startChat:async(id,prompt)=>{events.push(['prompt',id,prompt]);tabs.get(id).url='https://chatgpt.com/c/study'+id;return '/c/study'+id;},
 shouldGroupTabs:async()=>true,groupTabs:async(ids,title)=>events.push(['group',ids,title]),
 updateStatus:async(ids,status)=>events.push(['toolbar',ids,structuredClone(status)]),resourceLimit:async()=>1024,resourceCountLimit:async()=>5,historyLimit:()=>2,schedule:work=>scheduled.push(work),log:(label,value)=>logs.push({label,value}),
 saveResource:async(taskId,bytes,mimeType,resourceId)=>{saved.push({taskId,bytes,mimeType,resourceId});await onSave?.();return {workspacePath:`study-this-site/${resourceId.replace(/^r_/,"res_")} [${taskId}].${Object.values(media).find(item=>item.mimeType===mimeType)?.ext || 'png'}`,mimeType,sizeBytes:bytes.length};},
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
   if(nonImages && params.functionDeclaration.includes('function inspectBrowserElement') && [112,113,114].includes(id)){
    const kind=id===112?'document':id===113?'audio':'video';
    return {result:{value:{tag:id===112?'a':kind,attributes:[],bounds:{x:10,y:20,width:50,height:40},resources:[{kind,url:'https://cdn.test/'+kind+'?signature=PRIVATE',rendering:null}],editable:false,password:false}}};
   }
   if(params.functionDeclaration.includes('function inspectBrowserElement'))return {result:{value:{tag:[104,110,111].includes(id)?'img':id===105?'input':id===106?'select':'div',attributes:[],bounds:{x:10,y:20,width:50,height:40},resources:[104,110,111].includes(id)?[{kind:'image',url:'https://cdn.test/image.png?signature=PRIVATE',rendering:null}]:[],editable:id===105,password:false}}};
   if(params.functionDeclaration.includes('elementFromPoint'))return {result:{value:true}};
   if(params.functionDeclaration.includes('this.options'))return {result:{value:args[0]==='a'}};
   if(params.functionDeclaration.includes('this.value'))return {result:{value:domValues.get(id)}};
   return {result:{value:null}};
  }
  if(method==='DOM.focus'){host.focus=params.backendNodeId;return {};}
  if(method==='Input.insertText'){domValues.set(host.focus,params.text);return {};}
  if(method==='DOM.getBoxModel')return {model:{content:[10,20,60,20,60,60,10,60]}};
  if(method==='Page.getLayoutMetrics')return {cssVisualViewport:{pageX:0,pageY:0,clientWidth:800,clientHeight:600}};
  if(nonImages && method==='Network.loadNetworkResource'){
   const kind=Object.keys(media).find(kind=>params.url==='https://cdn.test/'+kind+'?signature=PRIVATE');
   if(kind)return {resource:{success:true,stream:kind,headers:{'Content-Type':media[kind].mimeType}}};
  }
  if(nonImages && method==='IO.read' && media[params.handle])return {data:media[params.handle].bytes.toString('base64'),base64Encoded:true,eof:true};
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
const startupPrompt=f.events.find(event=>event[0]==='prompt')[2];
for(const name of ['site_get_images','site_get_files']) assert.ok(startupPrompt.includes(name));
assert.match(startupPrompt,/Use sessionId: bas_[A-Za-z0-9_-]{10} for site tools and tabId: 22 for async tasks\./);
assert.doesNotMatch(startupPrompt,/browser_/);
assert.match(startupPrompt,/in my language/);
assert.match(startupPrompt,/Download and attach relevant images with site_get_images and documents\/audio\/video with site_get_files/);
assert.match(startupPrompt,/site_get_files \(addToChat: true; resourceIds for batches\)/);
assert.match(sessionId,/^bas_[A-Za-z0-9_-]{10}$/);checkSchema('site_session_status',started.session);
assert.deepEqual(f.events.filter(e=>['duplicate','restore','createChat'].includes(e[0])).map(e=>e[0]),['duplicate','restore','createChat']);
assert.deepEqual(f.events.find(e=>e[0]==='group'),['group',[21,22],'RT · Site']);
assert.equal(f.tabs.size,3);assert.equal(f.tabs.get(10).url,'https://site.test/article?token=PRIVATE');
assert.ok(!f.events.some(e=>e[0]==='Accessibility.getFullAXTree'),'startup does not require a full AX read');
assert.ok(!f.events.some(e=>['Runtime.addBinding','Page.addScriptToEvaluateOnNewDocument','Page.createIsolatedWorld'].includes(e[0])),'no controls injected into studied page');
assert.ok(f.events.findIndex(e=>e[0]==='Emulation.setFocusEmulationEnabled') < f.events.findIndex(e=>e[0]==='documentReady'),'focus emulation precedes waiting');
assert.deepEqual(Object.keys(f.agent.localStatus(21)).sort(),['error','phase','state','statusMessage']);assert.equal(f.agent.localStatus(10),null,'the source is not controlled');
const obs=await f.run('site_read',{sessionId,mode:'full'});
assert.equal(obs.nodes.length,7,'ignore generic wrappers and redundant inline text without losing hierarchy');
assert.equal(obs.page.url,'https://site.test/article');assert.ok(!JSON.stringify(obs).includes('PRIVATE'));
const byRole=role=>obs.nodes.find(node=>node.role===role);
assert.deepEqual(byRole('heading').childIds,[byRole('StaticText').nodeId]);assert.equal(byRole('StaticText').parentId,byRole('heading').nodeId);
const text=await f.run('site_get_text',{sessionId,nodeId:byRole('heading').nodeId,limit:8});assert.equal(text.text,'Detailed');assert.equal(text.nextOffset,8);
const slice=await f.run('site_get_children',{sessionId,nodeId:obs.roots[0],depth:1,maxNodes:2});assert.equal(slice.nodes.length,2);assert.equal(slice.nextOffset,2);
const inspect=await f.run('site_get_node',{sessionId,nodeId:byRole('image').nodeId});const resourceId=inspect.dom.resources[0].resourceId;
assert.ok(!JSON.stringify(inspect).includes('PRIVATE'));
for(const [action,parameters] of [['hover',{}],['click',{}],['key',{key:'Ctrl+A'}],['scroll',{direction:'down',amount:123}]])await f.run('site_interact',{sessionId,action,nodeId:byRole('button').nodeId,...parameters});
await f.run('site_interact',{sessionId,action:'type',nodeId:byRole('textbox').nodeId,text:'Search text'});
await f.run('site_interact',{sessionId,action:'select',nodeId:byRole('combobox').nodeId,value:'a'});
const inputEvents=f.events.filter(event=>event[0]==='Input.dispatchKeyEvent');assert.ok(inputEvents.some(event=>event[2].code==='KeyA'&&event[2].windowsVirtualKeyCode===65&&event[2].modifiers===2));
await f.run('site_session_pause',{sessionId});await f.run('site_read',{sessionId});await assert.rejects(f.run('site_interact',{sessionId,action:'click',nodeId:byRole('button').nodeId}),{code:'BROWSER_SESSION_PAUSED'});await f.run('site_session_resume',{sessionId});
const queued=await f.run('site_get_images',{sessionId,resourceId});assert.equal(queued.status,'queued');assert.match(queued.taskId,/^tsk_[A-Za-z0-9_-]{10}$/);await f.scheduled.shift()();
const finished=await f.run('site_files_status',{sessionId,taskId:queued.taskId});assert.equal(finished.status,'completed');assert.equal(finished.extraction,'original');assert.equal(finished.progressPercent,100);assert.equal(finished.submittedFiles.length,1);
assert.equal(f.uploads[0].options.target.tabId,22);assert.equal(f.uploads[0].options.target.chatPath,'/c/study22');assert.match(f.uploads[0].options.continuation,new RegExp(resourceId));assert.ok(!JSON.stringify(finished).includes('PRIVATE'));
assert.equal((await f.run('site_files_cancel',{sessionId,taskId:queued.taskId})).cancelled,false);
const cancellation=await f.run('site_get_images',{sessionId,resourceId});assert.equal((await f.run('site_files_cancel',{sessionId,taskId:cancellation.taskId})).cancelled,true);await f.scheduled.shift()();assert.equal((await f.run('site_files_status',{sessionId,taskId:cancellation.taskId})).status,'cancelled');assert.equal(f.saved.length,1,'queued cancellation creates nothing');
f.setOriginalFailure();const fallback=await f.run('site_get_images',{sessionId,resourceId,addToChat:false});await f.scheduled.shift()();assert.equal((await f.run('site_files_status',{sessionId,taskId:fallback.taskId})).extraction,'element-screenshot');assert.equal(f.uploads.length,1);
const screenshot=f.events.find(event=>event[0]==='Page.captureScreenshot');assert.equal(screenshot[2].captureBeyondViewport,false);assert.ok(screenshot[2].clip);
await f.agent.onEvent({tabId:21},'Page.frameNavigated',{frame:{id:'main',url:'https://site.test/next'}});f.tabs.get(21).url='https://site.test/next';
await assert.rejects(f.run('site_get_node',{sessionId,nodeId:byRole('image').nodeId}),{code:'PAGE_CHANGED'});
await f.run('site_read',{sessionId});
await f.agent.onEvent({tabId:21},'Target.attachedToTarget',{sessionId:'child',targetInfo:{type:'iframe'}});assert.ok(f.events.some(event=>event[0]==='Target.setAutoAttach'&&event[3]==='child'));
await f.agent.onRemoved(10);assert.equal((await f.run('site_session_status',{sessionId})).state,'running','closing original source leaves duplicated session running');
await f.run('site_session_stop',{sessionId});assert.equal(f.tabs.size,3,'Stop never closes tabs');await assert.rejects(f.run('site_read',{sessionId}),{code:'BROWSER_SESSION_STOPPED'});
const g=fixture();const sid=(await g.agent.start(10)).session.sessionId;const image=(await g.run('site_read',{sessionId:sid,mode:'full'})).nodes.find(node=>node.role==='image');
g.setTooLarge();const large=await g.run('site_get_images',{sessionId:sid,resourceId:image.resources[0].resourceId});await g.scheduled.shift()();assert.equal((await g.run('site_files_status',{sessionId:sid,taskId:large.taskId})).error.code,'BROWSER_RESOURCE_TOO_LARGE');assert.ok(g.events.some(event=>event[0]==='IO.close'));
g.tabs.delete(22);await g.agent.onRemoved(22);assert.equal((await g.run('site_session_status',{sessionId:sid})).stopReason.code,'TAB_CLOSED');assert.equal(g.uploads.length,0);
const h=fixture();const hsid=(await h.agent.start(10)).session.sessionId;const himage=(await h.run('site_read',{sessionId:hsid,mode:'full'})).nodes.find(node=>node.role==='image');
const htask=await h.run('site_get_images',{sessionId:hsid,resourceId:himage.resources[0].resourceId});h.onAttach(async()=>{await h.run('site_files_cancel',{sessionId:hsid,taskId:htask.taskId});});await h.scheduled.shift()();const hc=await h.run('site_files_status',{sessionId:hsid,taskId:htask.taskId});assert.equal(hc.status,'cancelled');assert.ok(hc.workspacePath);assert.equal(hc.submittedAt,null,'cancellation preserves saved file and avoids Send');
const changed=structuredClone(initialTree);changed.find(node=>node.nodeId==='7').name.value='Different action';h.setTree(changed);const oldButton=(await h.run('site_read',{sessionId:hsid})).nodes.find(node=>node.role==='button');changed.find(node=>node.nodeId==='7').name.value='Repurposed action';await assert.rejects(h.run('site_interact',{sessionId:hsid,action:'click',nodeId:oldButton.nodeId}),{code:'STALE_NODE'});const newButton=(await h.run('site_read',{sessionId:hsid})).nodes.find(node=>node.role==='button');assert.notEqual(newButton.nodeId,oldButton.nodeId);

// Closure is a normal terminal state for either owned tab, including the
// debugger target_closed event arriving before chrome.tabs.onRemoved.
for(const tabId of [21,22]) {
 const closed=fixture();const closedId=(await closed.agent.start(10)).session.sessionId;
 const img=(await closed.run('site_read',{sessionId:closedId})).nodes.find(n=>n.role==='image');
 const task=await closed.run('site_get_images',{sessionId:closedId,resourceId:img.resources[0].resourceId});
 closed.tabs.delete(tabId);
 if(tabId===21)await closed.agent.onDetached({tabId},'target_closed');
 await closed.agent.onRemoved(tabId);
 const ended=await closed.run('site_session_status',{sessionId:closedId});
 assert.equal(ended.state,'stopped');assert.equal(ended.error,null);assert.equal(ended.stopReason.code,'TAB_CLOSED');
 assert.equal(closed.agent.localStatus(tabId===21?22:21).state,'stopped');
 assert.equal(closed.events.filter(e=>e[0]==='toolbar').at(-1)[2].state,'stopped');
 assert.equal((await closed.run('site_files_status',{sessionId:closedId,taskId:task.taskId})).status,'cancelled');
 await closed.scheduled.shift()();assert.equal(closed.uploads.length,0);assert.equal(closed.saved.length,0);
 await assert.rejects(closed.run('site_read',{sessionId:closedId}),{code:'TAB_CLOSED'});
 assert.equal(closed.tabs.size,2,'the survivor and original source remain open');
}
const detached=fixture();const detachedId=(await detached.agent.start(10)).session.sessionId;
await detached.agent.onDetached({tabId:21},'canceled_by_user');
assert.equal((await detached.run('site_session_status',{sessionId:detachedId})).error.code,'DEBUGGER_DETACHED','actual debugger loss still reports a failure');
const noGroup=fixture();noGroup.host.shouldGroupTabs=async()=>false;await noGroup.agent.start(10);
assert.ok(!noGroup.events.some(e=>e[0]==='group'));
const groupFailure=fixture();groupFailure.host.groupTabs=async()=>{throw Error('unavailable');};
assert.equal((await groupFailure.agent.start(10)).session.state,'running');
assert.ok(groupFailure.logs.some(e=>e.label==='tab grouping unavailable'));
assert.equal(browserStudyGroupTitle({title:'Marketplace - Insulation | Facebook',url:'https://facebook.com/item'}),'RT · Insulation');
assert.equal(browserStudyGroupTitle({title:'  ',url:'https://www.facebook.com/item'}),'RT · facebook.com');
assert.equal(Array.from(browserStudyGroupTitle({title:'😀'.repeat(30)})).length,25,'truncate without breaking Unicode');
assert.equal(browserStudyGroupTitle({title:' Test \n  title | Site '}),'RT · Test title');

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
const provisionalImage=(await provisional.run('site_read',{sessionId:provisionalId})).nodes.find(node=>node.role==='image');
await provisional.run('site_get_images',{sessionId:provisionalId,resourceId:provisionalImage.resources[0].resourceId});
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
assert.throws(()=>validateBrowserInput('site_session_status',{sessionId:'bs_abcdefghij'}),{code:'BROWSER_INVALID'});

const slow=fixture();let release;
slow.host.waitReady=async(id,check)=>{await new Promise(resolve=>{release=resolve;});check();};
const starting=slow.agent.start(10);await new Promise(resolve=>setImmediate(resolve));
assert.equal(slow.agent.localStatus(21).phase,'waitingForPage');await slow.run('site_session_stop',{sessionId:slow.logs.find(e=>e.label==='startup').value.sessionId});release();
await assert.rejects(starting,{code:'BROWSER_SESSION_STOPPED'});assert.ok(!slow.events.some(e=>e[0]==='prompt'));assert.ok(slow.events.some(e=>e[0]==='detach'));assert.equal(slow.agent.localStatus(22).state,'stopped');
const startupClosed=fixture();let releaseClosed;
startupClosed.host.waitReady=async(id,check)=>{await new Promise(resolve=>{releaseClosed=resolve;});check();};
const closingStartup=startupClosed.agent.start(10);await new Promise(resolve=>setImmediate(resolve));
startupClosed.tabs.delete(22);await startupClosed.agent.onRemoved(22);releaseClosed();
const closedStartupResult=await closingStartup;
assert.equal(closedStartupResult.ok,true);assert.equal(closedStartupResult.session.state,'stopped');assert.equal(closedStartupResult.session.error,null);
assert.equal(closedStartupResult.session.stopReason.code,'TAB_CLOSED');assert.ok(!startupClosed.events.some(e=>e[0]==='prompt'));
assert.ok(!startupClosed.logs.some(e=>e.label==='startup failed'));
const savedClosed=fixture();const savedClosedId=(await savedClosed.agent.start(10)).session.sessionId;
const savedImage=(await savedClosed.run('site_read',{sessionId:savedClosedId})).nodes.find(n=>n.role==='image');
const savedTask=await savedClosed.run('site_get_images',{sessionId:savedClosedId,resourceId:savedImage.resources[0].resourceId});
savedClosed.onSave(async()=>{savedClosed.tabs.delete(21);await savedClosed.agent.onRemoved(21);});
await savedClosed.scheduled.shift()();const savedCancelled=await savedClosed.run('site_files_status',{sessionId:savedClosedId,taskId:savedTask.taskId});
assert.equal(savedCancelled.status,'cancelled');assert.ok(savedCancelled.workspacePath);assert.equal(savedClosed.saved.length,1);assert.equal(savedClosed.uploads.length,0);
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
const switchedObservation=await switched.run('site_read',{sessionId:switchedId});
assert.ok(switched.events.filter(e=>e[0]==='Accessibility.getFullAXTree').every(e=>e[1]===21));
const switchedImage=switchedObservation.nodes.find(node=>node.role==='image');
const switchedTask=await switched.run('site_get_images',{sessionId:switchedId,resourceId:switchedImage.resources[0].resourceId});
await switched.scheduled.shift()();assert.equal(switched.uploads[0].options.target.tabId,22);assert.equal(switched.uploads[0].options.target.chatPath,'/c/study22');
assert.equal(switched.tabs.get(81).active,true,'automation does not activate its tabs');
assert.equal((await switched.run('site_session_status',{sessionId:switchedId})).state,'running');
// Chrome may deliver an earlier URL snapshot after bootstrap bound /c/study.
// The actual owned tab, not that queued event, defines the current conversation.
const route=fixture();const routeId=(await route.agent.start(10)).session.sessionId;
await route.agent.onUpdated(22,{url:'https://chatgpt.com/'});
await route.agent.onUpdated(22,{url:'https://chatgpt.com/c/provisional'});
assert.equal((await route.run('site_session_status',{sessionId:routeId})).state,'running');
assert.equal(route.agent.localStatus(22).state,'running');
assert.ok(route.logs.some(e=>e.label==='outdated conversation event ignored'));
const routeImage=(await route.run('site_read',{sessionId:routeId})).nodes.find(node=>node.role==='image');
const routeTask=await route.run('site_get_images',{sessionId:routeId,resourceId:routeImage.resources[0].resourceId});await route.scheduled.shift()();
assert.equal(route.uploads[0].options.target.tabId,22);assert.equal(route.uploads[0].options.target.chatPath,'/c/study22','stale events never change the delivery destination');
route.tabs.get(22).url='https://chatgpt.com/c/unrelated';
// Even an event still reporting the bound chat must not mask live navigation.
await route.agent.onUpdated(22,{url:'https://chatgpt.com/c/study22'});
assert.equal((await route.run('site_session_status',{sessionId:routeId})).state,'failed');
assert.equal(route.agent.localStatus(22).error.code,'BROWSER_CHAT_CHANGED');
const mismatch=route.logs.find(e=>e.label==='conversation mismatch');
assert.equal(mismatch.value.trigger,'tabUpdated');assert.equal(mismatch.value.expectedChatPath,'/c/study22');assert.equal(mismatch.value.actualChatPath,'/c/unrelated');
await assert.rejects(route.run('site_read',{sessionId:routeId}),{code:'BROWSER_CHAT_CHANGED'});
const missing=fixture();await missing.agent.start(10);missing.tabs.delete(22);await missing.agent.onUpdated(22,{url:'https://chatgpt.com/c/other'});assert.equal((await missing.run('site_session_status',{sessionId:missing.logs.find(e=>e.label==='session started').value.sessionId})).stopReason.code,'TAB_CLOSED');
const toolMismatch=fixture();const toolMismatchId=(await toolMismatch.agent.start(10)).session.sessionId;toolMismatch.tabs.get(22).url='https://chatgpt.com/c/another';
await assert.rejects(toolMismatch.run('site_read',{sessionId:toolMismatchId}),{code:'BROWSER_CHAT_CHANGED'});
assert.equal(toolMismatch.logs.find(e=>e.label==='conversation mismatch').value.trigger,'tool');
for(const args of [{sessionId,depth:21},{sessionId,offset:-1},{sessionId,unknown:true},{sessionId,mode:'subtree'}])assert.throws(()=>validateBrowserInput('site_read',args),{code:'BROWSER_INVALID'});
assert.throws(()=>validateBrowserInput('site_interact',{sessionId,action:'click',nodeId:'n_1_3',text:'bad'}),{code:'BROWSER_INVALID'});
assert.throws(()=>validateBrowserInput('site_files_status',{sessionId,taskId:'chat_UUID'}),{code:'BROWSER_INVALID'});
await assert.rejects(f.agent.execute('site_read',{sessionId:'bas_abcdefghij'}),{code:'BROWSER_SESSION_NOT_FOUND'});
console.log('Browser Agent: schemas, AX hierarchy, private resources, CDP input, exact tabs, navigation, toolbar, startup readiness, pause, cancellation, fallback and Stop: ok');

// Session-scoped diagnostics work throughout startup/AX/resource delivery;
// changing the config only affects the next session, never its target tabs.
{
 const detailed=fixture(); let ms=0;
 detailed.host.monotonicNow=()=>ms;
 detailed.host.studyOptions=async()=>({groupTabs:true,detailedLogging:true});
 const nativeCommand=detailed.host.command;
 detailed.host.command=async(...args)=>{ms+=10;return nativeCommand(...args);};
 const sid=(await detailed.agent.start(10)).session.sessionId;
 ms+=1200;
 const observation=await detailed.run('site_read',{sessionId:sid,mode:'outline'});
 assert.ok(detailed.logs.some(row=>row.label==='timing' && row.value.stage==='tool.gap' && row.value.gapMs===1200));
 assert.ok(detailed.logs.some(row=>row.value.stage==='page.axCounts' && row.value.rawNodes===initialTree.length));
 assert.ok(detailed.logs.some(row=>row.value.stage==='page.axRefresh' && row.value.event==='cdp' && row.value.method==='Accessibility.getFullAXTree'));
 detailed.host.studyOptions=async()=>({groupTabs:true,detailedLogging:false});
 const resourceId=observation.nodes.find(node=>node.role==='image').resources[0].resourceId;
 const task=await detailed.run('site_get_images',{sessionId:sid,resourceId});
 await detailed.scheduled.shift()();
 const done=await detailed.run('site_files_status',{sessionId:sid,taskId:task.taskId});
 assert.equal(done.status,'completed'); assert.equal(detailed.uploads[0].options.target.tabId,22);
 assert.ok(detailed.logs.some(row=>row.value.stage==='resource.total' && row.value.taskId===task.taskId && row.value.outcome==='completed' && row.value.bytes===8));
 assert.ok(detailed.logs.some(row=>row.value.stage==='resource.extract' && row.value.event==='cdp' && row.value.method==='IO.read'));
 const logs=JSON.stringify(detailed.logs.filter(row=>row.label==='timing'));
 assert.doesNotMatch(logs,/PRIVATE|signature|cdn\.test|Article|Detailed content|study-this-site|@ResearchTube/);
 assert.ok(detailed.logs.some(row=>row.value.stage==='startup.total'));
 const second=(await detailed.agent.start(10)).session.sessionId;
 const before=detailed.logs.length;
 await detailed.run('site_read',{sessionId:second});
 assert.equal(detailed.logs.slice(before).filter(row=>row.label==='timing').length,0,'next session uses disabled configuration');
}
console.log('Browser detailed diagnostics: startup, AX/resource counts, delivery, exact targets, private data and per-session switch: ok');

// A batch returns immediately, then runs in the worker without another LLM/tool
// call. Save every resource first, upload once, preserve order and exact target.
const batch=fixture({multipleImages:true});const batchSid=(await batch.agent.start(10)).session.sessionId;
const batchIds=(await batch.run('site_read',{sessionId:batchSid,mode:'full'})).nodes.filter(n=>n.role==='image').map(n=>n.resources[0].resourceId).reverse();
assert.equal(batchIds.length,3);
const batchTask=await batch.run('site_get_images',{sessionId:batchSid,resourceIds:batchIds});
assert.equal(batchTask.status,'queued');assert.equal(batch.saved.length,0);assert.equal(batch.uploads.length,0);
batch.onAttach(async()=>assert.equal(batch.saved.length,3,'every resource is saved before attachment'));
await batch.scheduled.shift()();
const batchResult=await batch.run('site_files_status',{sessionId:batchSid,taskId:batchTask.taskId});
assert.equal(batchResult.status,'completed');assert.equal(batchResult.progressPercent,100);
assert.deepEqual(batchResult.resourceIds,batchIds);assert.deepEqual(batchResult.files.map(f=>f.resourceId),batchIds);
assert.equal(batchResult.resourceId,null);assert.equal(batchResult.workspacePath,null);assert.equal(batchResult.mimeType,null);
assert.deepEqual(batch.saved.map(f=>f.taskId),[batchTask.taskId,batchTask.taskId,batchTask.taskId],'batch filenames share the public standard task ID');
assert.deepEqual(batch.saved.map(f=>f.resourceId),batchIds);
assert.equal(new Set(batchResult.files.map(f=>f.workspacePath)).size,3,'resource IDs distinguish files within the same task');
for (const file of batchResult.files) { assert.ok(file.workspacePath.includes(`[${batchTask.taskId}]`)); assert.doesNotMatch(file.workspacePath,/browser_|resource/); assert.equal(file.workspacePath,`study-this-site/${file.resourceId.replace(/^r_/,"res_")} [${batchTask.taskId}].png`); }
for(const file of batch.saved)assert.match(file.taskId,/^tsk_[A-Za-z0-9_-]{10}$/);
assert.equal(batch.uploads.length,1);assert.equal(batch.uploads[0].files.length,3);
assert.deepEqual(batchResult.submittedFiles,batchResult.files.map(f=>f.workspacePath));
assert.equal(batch.uploads[0].options.target.tabId,22);
for(const id of batchIds)assert.ok(batch.uploads[0].options.continuation.includes(id));
assert.ok(!JSON.stringify(batchResult).includes('PRIVATE'));
const resourceInput=definitions.find(d=>d.name==='site_get_images').inputSchema;
assertSchema(resourceInput,{sessionId:batchSid,resourceIds:batchIds});
assertSchema(resourceInput,{sessionId:batchSid,resourceId:batchIds[0]});
for(const args of [{},{resourceId:batchIds[0],resourceIds:batchIds},{resourceIds:[]},{resourceIds:[batchIds[0],batchIds[0]]},{resourceIds:['bad']},{resourceIds:null}])assert.throws(()=>validateBrowserInput('site_get_images',{sessionId:batchSid,...args}),{code:'BROWSER_INVALID'});
const batchBefore=batch.saved.length;batch.host.resourceCountLimit=async()=>2;
await assert.rejects(batch.run('site_get_images',{sessionId:batchSid,resourceIds:batchIds}),error=>error.code==='BROWSER_INVALID'&&error.message.includes('maximum is 2'));
assert.equal(batch.saved.length,batchBefore);assert.equal(batch.scheduled.length,0);

// The two tools enforce their scopes before creating jobs or fetching bytes.
const typed=fixture({nonImages:true});const typedSid=(await typed.agent.start(10)).session.sessionId;
const typedNodes=(await typed.run('site_read',{sessionId:typedSid})).nodes;
const typedImage=typedNodes.find(n=>n.role==='image').resources[0].resourceId;
const otherIds=typedNodes.flatMap(n=>n.resources).filter(r=>r.kind!=='image').map(r=>r.resourceId);
assert.equal(otherIds.length,3);
const beforeTypeCheck=typed.events.length;
for(const [name,id] of [['site_get_images',typedImage],['site_get_files',otherIds[0]]])await assert.rejects(typed.run(name,{sessionId:typedSid,tabId:81,resourceId:id}),{code:'BROWSER_INVALID'});
for(const args of [{resourceId:otherIds[0]},{resourceIds:[typedImage,otherIds[0]]}]){
 await assert.rejects(typed.run('site_get_images',{sessionId:typedSid,...args}),{code:'BROWSER_RESOURCE_TYPE_MISMATCH'});
}
await assert.rejects(typed.run('site_get_files',{sessionId:typedSid,resourceId:typedImage}),{code:'BROWSER_RESOURCE_TYPE_MISMATCH'});
await assert.rejects(typed.run('site_get_files',{sessionId:typedSid,resourceIds:[otherIds[0],typedImage]}),{code:'BROWSER_RESOURCE_TYPE_MISMATCH'});
assert.equal(typed.scheduled.length,0);assert.equal(typed.saved.length,0);assert.equal(typed.uploads.length,0);
assert.ok(!typed.events.slice(beforeTypeCheck).some(row=>row[0]==='Network.loadNetworkResource'),'wrong kinds do not fetch bytes');
for(const name of ['site_get_images','site_get_files']){
 const schema=definitions.find(d=>d.name===name).inputSchema;
 assertSchema(schema,{sessionId:typedSid,resourceIds:[typedImage]});
 for(const args of [{},{resourceId:typedImage,resourceIds:[typedImage]},{resourceIds:[]},{resourceIds:[typedImage,typedImage]},{resourceIds:null}])assert.throws(()=>validateBrowserInput(name,{sessionId:typedSid,...args}),{code:'BROWSER_INVALID'});
}
const otherTask=await typed.run('site_get_files',{sessionId:typedSid,resourceIds:otherIds,addToChat:true,tabId:22});
assert.equal(otherTask.status,'queued');assert.equal(otherTask.tabId,22);assert.match(otherTask.taskId,/^tsk_[A-Za-z0-9_-]{10}$/);
await typed.scheduled.shift()();
const otherResult=await typed.run('site_files_status',{sessionId:typedSid,taskId:otherTask.taskId});
assert.equal(otherResult.status,'completed');assert.equal(typed.uploads.length,1);
assert.deepEqual(otherResult.files.map(f=>f.mimeType),['application/pdf','audio/mpeg','video/mp4']);
assert.deepEqual(otherResult.files.map(f=>f.extraction),['original','original','original']);
assert.equal(otherResult.submittedFiles.length,3);assert.ok(!JSON.stringify(otherResult).includes('PRIVATE'));
const saveOnly=await typed.run('site_get_files',{sessionId:typedSid,resourceId:otherIds[0],addToChat:false});
await typed.scheduled.shift()();assert.equal((await typed.run('site_files_status',{sessionId:typedSid,taskId:saveOnly.taskId})).status,'completed');assert.equal(typed.uploads.length,1);
const cancelledOther=await typed.run('site_get_files',{sessionId:typedSid,resourceId:otherIds[1]});
assert.equal((await typed.run('site_files_cancel',{sessionId:typedSid,taskId:cancelledOther.taskId})).cancelled,true);
await typed.scheduled.shift()();assert.equal((await typed.run('site_files_status',{sessionId:typedSid,taskId:cancelledOther.taskId})).status,'cancelled');
// A download link that actually returns an image must not broaden site_get_files.
const swapped=fixture({nonImages:true});const swappedSid=(await swapped.agent.start(10)).session.sessionId;
const swappedDoc=(await swapped.run('site_read',{sessionId:swappedSid})).nodes.flatMap(n=>n.resources).find(r=>r.kind==='document');
const originalCommand=swapped.host.command;
swapped.host.command=async(id,method,params,...rest)=>method==='Network.loadNetworkResource'?{resource:{success:true,stream:'changed',headers:{'Content-Type':'image/png'}}}:method==='IO.read'?{data:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64'),base64Encoded:true,eof:true}:originalCommand(id,method,params,...rest);
const changedTask=await swapped.run('site_get_files',{sessionId:swappedSid,resourceId:swappedDoc.resourceId});
await swapped.scheduled.shift()();
const changedResult=await swapped.run('site_files_status',{sessionId:swappedSid,taskId:changedTask.taskId});
assert.equal(changedResult.status,'failed');assert.equal(changedResult.error.code,'BROWSER_RESOURCE_TYPE_MISMATCH');assert.equal(swapped.saved.length,0);assert.equal(swapped.uploads.length,0);
// Blob image elements can yield non-image bytes; refuse them before saving.
const blobImage=fixture();const blobCommand=blobImage.host.command;
blobImage.host.command=async(id,method,params,...rest)=>{
 if(method==='Runtime.callFunctionOn' && params.functionDeclaration.includes('FileReader'))return {result:{value:{url:'data:application/pdf;base64,'+Buffer.from('%PDF-1.7').toString('base64'),mimeType:'application/pdf'}}};
 const result=await blobCommand(id,method,params,...rest);
 if(method==='Runtime.callFunctionOn' && params.functionDeclaration.includes('function inspectBrowserElement') && params.objectId==='104')result.result.value.resources[0].url='blob:https://site.test/image';
 return result;
};
const blobSid=(await blobImage.agent.start(10)).session.sessionId;
const blobId=(await blobImage.run('site_read',{sessionId:blobSid})).nodes.find(n=>n.role==='image').resources[0].resourceId;
const blobTask=await blobImage.run('site_get_images',{sessionId:blobSid,resourceId:blobId});
await blobImage.scheduled.shift()();
const blobResult=await blobImage.run('site_files_status',{sessionId:blobSid,taskId:blobTask.taskId});
assert.equal(blobResult.status,'failed');assert.equal(blobResult.error.code,'BROWSER_RESOURCE_TYPE_MISMATCH');assert.equal(blobImage.saved.length,0);assert.equal(blobImage.uploads.length,0);
console.log('Site downloads: image/non-image scopes, mixed-batch rejection before jobs, byte-type validation, PDF/audio/video delivery, save-only and shared cancellation: ok');

// A save failure or cancellation midway leaves published files in status and
// does not upload a partial batch, delete files or clear the Composer.
for(const outcome of ['failed','cancelled']){
 const partial=fixture({multipleImages:true});const sid=(await partial.agent.start(10)).session.sessionId;
 const ids=(await partial.run('site_read',{sessionId:sid,mode:'full'})).nodes.filter(n=>n.role==='image').map(n=>n.resources[0].resourceId);
 const task=await partial.run('site_get_images',{sessionId:sid,resourceIds:ids});
 if(outcome==='failed'){
  const save=partial.host.saveResource;let saves=0;
  partial.host.saveResource=async(...args)=>{if(++saves===2)throw Object.assign(Error('save unavailable'),{code:'BROWSER_RESOURCE_UNAVAILABLE'});return save(...args);};
 }else partial.onSave(async()=>{await partial.run('site_files_cancel',{sessionId:sid,taskId:task.taskId});});
 await partial.scheduled.shift()();
 const result=await partial.run('site_files_status',{sessionId:sid,taskId:task.taskId});
 assert.equal(result.status,outcome);assert.equal(result.files.length,1);assert.equal(partial.saved.length,1);
 assert.equal(partial.uploads.length,0);assert.deepEqual(result.submittedFiles,[]);assert.equal(result.submittedAt,null);
 assert.equal(result.files[0].resourceId,ids[0]);
}
console.log('Browser resource batches: saved before one upload, ordered files, configured limits, strict inputs, partial failure/cancellation and independent scheduled execution: ok');


const navigatedBatch=fixture({multipleImages:true});const nsid=(await navigatedBatch.agent.start(10)).session.sessionId;
const nids=(await navigatedBatch.run('site_read',{sessionId:nsid,mode:'full'})).nodes.filter(n=>n.role==='image').map(n=>n.resources[0].resourceId);
const ntask=await navigatedBatch.run('site_get_images',{sessionId:nsid,resourceIds:nids});
navigatedBatch.onSave(async()=>{if(navigatedBatch.saved.length===3){navigatedBatch.tabs.get(21).url='https://site.test/next';await navigatedBatch.agent.onEvent({tabId:21},'Page.frameNavigated',{frame:{id:'main',url:'https://site.test/next'}});}});
await navigatedBatch.scheduled.shift()();
const nstatus=await navigatedBatch.run('site_files_status',{sessionId:nsid,taskId:ntask.taskId});
assert.equal(nstatus.status,'failed');assert.equal(nstatus.error.code,'PAGE_CHANGED');assert.equal(nstatus.files.length,3);
assert.equal(navigatedBatch.uploads.length,0,'navigation during save keeps receipts but blocks old-page delivery');
console.log('Browser batches: navigation during final save preserves files and stops before upload: ok');

// A child navigation must not reject main-page resources, even between save
// and Send. The selected child's own navigation must still stop its delivery.
{
 const scoped=fixture();
 scoped.host.studyOptions=async()=>({groupTabs:false,detailedLogging:false,observation:{maxNodes:50,maxChars:16000}});
 const sid=(await scoped.agent.start(10)).session.sessionId;
 assert.match(scoped.events.find(row=>row[0]==='prompt')[2],/Use sessionId: bas_[A-Za-z0-9_-]{10} for site tools and tabId: 22 for async tasks/);
 await scoped.agent.onEvent({tabId:21},'Target.attachedToTarget',{sessionId:'child',targetInfo:{type:'iframe'}});
 const before=await scoped.run('site_read',{sessionId:sid});
 const mainImage=before.nodes.find(node=>node.role==='image');
 const childImage=before.nodes.filter(node=>node.role==='image')[1];
 const childRoot=before.roots[1];
 const mainRoot=before.roots[0];
 assert.ok(childImage && childRoot);
 const mainTask=await scoped.run('site_get_images',{sessionId:sid,resourceId:mainImage.resources[0].resourceId});
 scoped.onAttach(async()=>{await scoped.agent.onEvent({tabId:21,sessionId:'child'},'Page.frameNavigated',{frame:{id:'childFrame',url:'https://ad.test/reloaded'}});});
 await scoped.scheduled.shift()();
 assert.equal((await scoped.run('site_files_status',{sessionId:sid,taskId:mainTask.taskId})).status,'completed');
 await scoped.run('site_get_node',{sessionId:sid,nodeId:mainRoot});
 await assert.rejects(scoped.run('site_get_node',{sessionId:sid,nodeId:childImage.nodeId}),{code:'STALE_NODE'});
 const after=await scoped.run('site_read',{sessionId:sid});
 assert.equal(after.page.pageVersion,before.page.pageVersion);
 assert.equal(after.roots[0],mainRoot);
 assert.notEqual(after.roots[1],childRoot);
 const newChildImage=after.nodes.filter(node=>node.role==='image')[1];
 const childTask=await scoped.run('site_get_images',{sessionId:sid,resourceId:newChildImage.resources[0].resourceId});
 await scoped.scheduled.shift()();
 const failed=await scoped.run('site_files_status',{sessionId:sid,taskId:childTask.taskId});
 assert.equal(failed.status,'failed');assert.equal(failed.error.code,'STALE_NODE');
 assert.equal(failed.files.length,1,'saved bytes survive selected-frame navigation before Send');
 assert.deepEqual(failed.submittedFiles,[]);
 const sameDocumentUrl='https://site.test/article?filter=new#details';
 scoped.tabs.get(21).url=sameDocumentUrl;
 await scoped.agent.onEvent({tabId:21},'Page.navigatedWithinDocument',{frameId:'main',url:sameDocumentUrl});
 const same=await scoped.run('site_get_node',{sessionId:sid,nodeId:mainRoot});
 assert.equal(same.page.pageVersion,before.page.pageVersion);
 assert.equal(same.page.url,'https://site.test/article');
}
console.log('Browser frame routing: unrelated iframe reload preserves main IDs/delivery; selected-frame reload preserves bytes and stops Send; same-document navigation retains IDs: ok');

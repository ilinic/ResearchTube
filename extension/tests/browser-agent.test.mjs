import assert from 'node:assert/strict';
import {fixture,initialTree} from './fixtures/browser-agent-fixture.mjs';
import {createBrowserAgent,waitForBrowserDocument,waitForBrowserConversation,browserStudyGroupTitle} from '../browser-agent.js';
import {browserToolDefinitions,validateBrowserInput} from '../browser-tools.js';
import {assertSchema} from './fixtures/schema-check.mjs';
const definitions=browserToolDefinitions();

const f=fixture();const started=await f.agent.start(10);
assert.equal(started.chatTabId,22);assert.equal(started.group.groupId,100);
assertSchema(definitions.find(t=>t.name==='site_list_tabs').outputSchema,{chatTabId:22,group:started.group});
const prompt=f.events.find(e=>e[0]==='prompt')[2];
assert.match(prompt,/leading chatTabId/);assert.match(prompt,/chatTabId: 22/);
assert.equal(started.group.chatTabId,22);assert.equal(started.group.totalTabs,2);assert.equal(f.events.filter(e=>e[0]==='prompt').length,1);
assert.doesNotMatch(prompt,/sessionId|bas_|site_get_images|site_get_files/);
for(const tool of definitions){assert.ok(!tool.inputSchema.properties.sessionId);assert.ok(tool.inputSchema.required.includes('chatTabId'));}
assert.deepEqual(f.events.find(e=>e[0]==='group'),['group',[21,22],'RT · Site']);
assert.equal(f.tabs.get(10).groupId,undefined,'the original tab is not moved');
assert.ok(!f.events.some(e=>e[0]==='Accessibility.getFullAXTree'),'startup does not pre-read the page');
assert.ok(!f.events.some(e=>['Runtime.addBinding','Page.addScriptToEvaluateOnNewDocument'].includes(e[0])));
assert.ok(f.events.findIndex(e=>e[0]==='Emulation.setFocusEmulationEnabled')<f.events.findIndex(e=>e[0]==='documentReady'));
assert.equal(f.agent.localStatus(10),null);
const read=await f.run('site_read');assert.equal(read.nodes.length,7);assert.equal(read.tabId,21);assert.equal(read.chatTabId,22);
assert.equal(read.page.url,'https://site.test/article');assert.ok(!JSON.stringify(read).includes('PRIVATE'));
const byRole=role=>read.nodes.find(node=>node.role===role);
assert.match(byRole('image').nodeId,/^n_21_[0-9]+_[0-9]+$/);
assert.deepEqual(byRole('heading').childIds,[byRole('StaticText').nodeId]);
assert.equal((await f.run('site_get_text',{nodeId:byRole('heading').nodeId,limit:8})).text,'Detailed');
assert.equal((await f.run('site_get_children',{nodeId:read.roots[0],maxNodes:2})).nodes.length,2);
for(const [action,args] of [['hover',{}],['click',{}],['key',{key:'Ctrl+A'}],['scroll',{amount:100}]])await f.run('site_interact',{steps:[{action,nodeId:byRole('button').nodeId,...args}]});
await f.run('site_interact',{steps:[{action:'type',nodeId:byRole('textbox').nodeId,text:'Query'}]});
await f.run('site_interact',{steps:[{action:'select',nodeId:byRole('combobox').nodeId,value:'a'}]});
const search=await f.run('site_interact',{steps:[{action:'type',nodeId:byRole('textbox').nodeId,text:'Xeon DDR4'},{action:'key',key:'Enter'}]});
assert.equal(search.completedSteps,2);assert.equal(search.failedStep,null);
for(const steps of [[],Array(21).fill({action:'scroll'}),[{action:'type',text:'missing node'}],[{action:'key',key:123}],[{action:'scroll',unknown:1}],[{action:'scroll',amount:0}]])
 assert.throws(()=>validateBrowserInput('site_interact',{chatTabId:22,tabId:21,steps}),{code:'BROWSER_INVALID'});
assert.throws(()=>validateBrowserInput('site_interact',{chatTabId:22,tabId:21,action:'scroll'}),{code:'BROWSER_INVALID'});
const resourceId=byRole('image').resources[0].resourceId;
const task=await f.run('site_get_images',{resourceId});assert.equal(task.status,'queued');assert.equal(task.tabId,21);assert.equal(task.chatTabId,22);
await f.scheduled.shift()();const done=await f.run('site_files_status',{taskId:task.taskId});
assert.equal(done.status,'completed');assert.equal(done.progressPercent,100);assert.equal(done.submittedFiles.length,1);
assert.equal(f.uploads[0].options.target.tabId,22);assert.equal(f.uploads[0].options.target.chatPath,'/c/study22');
assert.match(f.uploads[0].options.continuation,/chatTabId: 22 and source tabId: 21/);assert.doesNotMatch(f.uploads[0].options.continuation,/bas_/);
assert.equal((await f.run('site_files_cancel',{taskId:task.taskId})).cancelled,false);
f.setOriginalFailure();const fallback=await f.run('site_get_images',{resourceId,addToChat:false});await f.scheduled.shift()();
assert.equal((await f.run('site_files_status',{taskId:fallback.taskId})).extraction,'element-screenshot');
assert.equal(f.events.find(e=>e[0]==='Page.captureScreenshot')[2].captureBeyondViewport,false);
f.tabs.get(21).url='https://site.test/next';await f.agent.onEvent({tabId:21},'Page.frameNavigated',{frame:{id:'main',url:'https://site.test/next'}});
await assert.rejects(f.run('site_get_node',{nodeId:byRole('image').nodeId}),{code:'PAGE_CHANGED'});
await f.run('site_read');
await f.run('site_session_stop');assert.equal((await f.run('site_session_status')).group.state,'stopped');
assert.equal(f.tabs.size,3);await assert.rejects(f.run('site_read'),{code:'BROWSER_SESSION_STOPPED'});

// The leading chat controls all current sites; extra ChatGPT tabs are ignored.
const multi=fixture();await multi.agent.start(10);
multi.tabs.set(30,{id:30,url:'https://chatgpt.com/c/other',title:'Other chat',groupId:100,windowId:2});
multi.tabs.set(31,{id:31,url:'https://site.test/second?token=PRIVATE',title:'Second',groupId:100,windowId:2});
await multi.agent.onCreated();
assert.equal((await multi.run('site_list_tabs')).group.tabs.length,3);
const a=await multi.run('site_read');const b=await multi.run('site_read',{tabId:31});
assert.equal(b.chatTabId,22);assert.equal(b.tabId,31);
assert.notEqual(a.nodes.find(n=>n.role==='image').nodeId,b.nodes.find(n=>n.role==='image').nodeId);
await assert.rejects(multi.run('site_get_node',{tabId:31,nodeId:a.nodes[0].nodeId}),{code:'PAGE_CHANGED'});
await assert.rejects(multi.run('site_read',{tabId:30}),{code:'BROWSER_INVALID'});
await assert.rejects(multi.run('site_read',{chatTabId:30,tabId:31}),{code:'BROWSER_NOT_GROUP_OWNER'});
await assert.rejects(multi.agent.connectGroup(30),{code:'BROWSER_NOT_GROUP_OWNER'});

// Removing one site cancels its work only; removing all sites leaves idle state.
const queuedA=await multi.run('site_get_images',{resourceId:a.nodes.find(n=>n.role==='image').resources[0].resourceId});
multi.tabs.delete(21);await multi.agent.onRemoved(21);
assert.equal((await multi.run('site_files_status',{taskId:queuedA.taskId})).status,'cancelled');
await multi.scheduled.shift()();assert.equal(multi.saved.length,0);
assert.equal((await multi.run('site_session_status')).group.state,'running');
await multi.run('site_read',{tabId:31});
const queuedB=await multi.run('site_get_images',{tabId:31,resourceId:b.nodes.find(n=>n.role==='image').resources[0].resourceId});
multi.tabs.delete(31);await multi.agent.onRemoved(31);
assert.equal((await multi.run('site_files_status',{taskId:queuedB.taskId})).status,'cancelled');
await multi.scheduled.shift()();
assert.equal((await multi.run('site_list_tabs')).group.state,'idle');
multi.tabs.delete(22);await multi.agent.onRemoved(22);
await assert.rejects(multi.run('site_list_tabs',{chatTabId:30}),{code:'BROWSER_NOT_GROUP_OWNER'});
await assert.rejects(multi.agent.connectGroup(30),{code:'BROWSER_NOT_GROUP_OWNER'});

// Group exclusion and queued actions are revalidated against actual Chrome state.
const moved=fixture();await moved.agent.start(10);
const movedRead=await moved.run('site_read');
const moving=await moved.run('site_get_images',{resourceId:movedRead.nodes.find(n=>n.role==='image').resources[0].resourceId});
moved.tabs.get(21).groupId=999;await moved.agent.onUpdated(21,{groupId:999});
assert.equal((await moved.run('site_files_status',{taskId:moving.taskId})).status,'cancelled');await moved.scheduled.shift()();
await assert.rejects(moved.run('site_read'),{code:'TAB_LEFT_GROUP'});
moved.tabs.get(21).groupId=100;await moved.agent.onUpdated(21,{groupId:100});
const returned=await moved.run('site_read');assert.notEqual(returned.nodes[0].nodeId,movedRead.nodes[0].nodeId,'rejoining cannot revive old node IDs');
moved.tabs.set(81,{id:81,url:'https://site.test/other',groupId:999});
await assert.rejects(moved.run('site_read',{tabId:81}),{code:'TAB_LEFT_GROUP'});
moved.tabs.get(22).groupId=-1;await assert.rejects(moved.run('site_list_tabs'),{code:'BROWSER_GROUP_NOT_FOUND'});

// Fresh worker discovers the group from chatTabId; no bas_ registry or storage.
const fresh=fixture();await fresh.agent.start(10);
const oldIds=await fresh.run('site_read');
const recreated=createBrowserAgent(fresh.host);
const rediscovered=await recreated.execute('site_list_tabs',{chatTabId:22});assert.equal(rediscovered.group.tabs.length,2);
// Use a separate fake debugger lease here; real workers lose their connections.
const newRead=await recreated.execute('site_read',{chatTabId:22,tabId:21});
assert.notEqual(oldIds.nodes[0].nodeId,newRead.nodes[0].nodeId);

// Saved conversation checks use the live tab URL, not delayed event snapshots.
const route=fixture();await route.agent.start(10);
const routeRead=await route.run('site_read');
const routeTask=await route.run('site_get_images',{resourceId:routeRead.nodes.find(n=>n.role==='image').resources[0].resourceId});
await route.agent.onUpdated(22,{url:'https://chatgpt.com/'});
assert.equal((await route.run('site_files_status',{taskId:routeTask.taskId})).status,'queued');
route.tabs.get(22).url='https://chatgpt.com/c/changed';await route.agent.onUpdated(22,{url:'https://chatgpt.com/c/study22'});
assert.equal((await route.run('site_files_status',{taskId:routeTask.taskId})).status,'cancelled');await route.scheduled.shift()();assert.equal(route.uploads.length,0);

// A slow read serializes only its own physical tab, and queued stale input is refused.
const ordered=fixture();await ordered.agent.start(10);
const initial=await ordered.run('site_read');
ordered.tabs.set(31,{id:31,url:'https://site.test/parallel',groupId:100});
let unblock, entered;const entering=new Promise(resolve=>{entered=resolve;});const native=ordered.host.command;
let block=true;
ordered.host.command=async(id,method,...rest)=>{
 if(id===21 && method==='Accessibility.getFullAXTree' && block){block=false;entered();await new Promise(resolve=>{unblock=resolve;});}
 return native(id,method,...rest);
};
const slow=ordered.run('site_read').catch(error=>error);await entering;
const waitingInput=ordered.run('site_interact',{steps:[{action:'click',nodeId:initial.nodes.find(n=>n.role==='button').nodeId}]}).catch(error=>error);
assert.equal((await ordered.run('site_read',{tabId:31})).tabId,31,'another tab can finish while the first is waiting');
ordered.tabs.get(21).groupId=999;await ordered.agent.onUpdated(21,{groupId:999});
unblock();assert.ok((await slow).code);assert.ok((await waitingInput).code);
assert.ok(!ordered.events.some(e=>e[0]==='Input.dispatchMouseEvent'&&e[2].type==='mousePressed'),'no queued click after departure');

// Waiting for an upload never holds the source page queue.
const released=fixture();await released.agent.start(10);const source=await released.run('site_read');
let finishUpload, uploading;const atUpload=new Promise(resolve=>{uploading=resolve;});
released.onAttach(async()=>{uploading();await new Promise(resolve=>{finishUpload=resolve;});});
const uploadTask=await released.run('site_get_images',{resourceId:source.nodes.find(n=>n.role==='image').resources[0].resourceId});
const upload=released.scheduled.shift()();await atUpload;
assert.equal((await released.run('site_read')).tabId,21);
await released.run('site_files_cancel',{taskId:uploadTask.taskId});finishUpload();await upload;
assert.equal((await released.run('site_files_status',{taskId:uploadTask.taskId})).status,'cancelled');assert.equal(released.saved.length,1);

// Participant count is unbounded; result pages remain bounded.
const large=fixture();await large.agent.start(10);
for(let id=1000;id<1250;id++)large.tabs.set(id,{id,url:'https://site.test/'+id,groupId:100});
const firstPage=await large.run('site_list_tabs',{limit:50});assert.equal(firstPage.group.totalTabs,252);assert.equal(firstPage.group.tabs.length,50);
const secondPage=await large.run('site_list_tabs',{offset:50,limit:200});assert.equal(secondPage.group.tabs.length,200);assert.equal(secondPage.group.nextOffset,250);
const lastPage=await large.run('site_list_tabs',{offset:250});assert.equal(lastPage.group.tabs.length,2);assert.equal(lastPage.group.nextOffset,null);

// Old grouping preference cannot disable the now-required working group.
const required=fixture();required.host.studyOptions=async()=>({groupTabs:false,detailedLogging:false});await required.agent.start(10);assert.ok(required.events.some(e=>e[0]==='group'));
const groupFailure=fixture();groupFailure.host.groupTabs=async()=>{throw Error('unavailable');};await assert.rejects(groupFailure.agent.start(10),{code:'BROWSER_UNAVAILABLE'});
const closeStartupChat=fixture();closeStartupChat.host.startChat=async id=>{
 closeStartupChat.tabs.delete(id);await closeStartupChat.agent.onRemoved(id);
 return '/c/closed';
};
assert.equal((await closeStartupChat.agent.start(10)).group.state,'stopped','closing the new chat during startup stops its group');
assert.ok(closeStartupChat.events.some(e=>e[0]==='detach' && e[1]===21));
const closeStartupSite=fixture();closeStartupSite.host.waitReady=async(id,check)=>{
 closeStartupSite.tabs.delete(id);await closeStartupSite.agent.onRemoved(id);check();
};
assert.equal((await closeStartupSite.agent.start(10)).group.state,'stopped','closing the controlled copy while waiting does not report successful startup');
assert.ok(!closeStartupSite.events.some(e=>e[0]==='prompt'));
const detached=fixture();await detached.agent.start(10);await detached.agent.onDetached({tabId:21},'canceled_by_user');
assert.equal((await detached.run('site_list_tabs')).group.tabs.find(t=>t.tabId===21).error.code,'DEBUGGER_DETACHED');
assert.equal(detached.agent.localStatus(22).state,'running');

// Background readiness and temporary ChatGPT addresses retain their guards.
let time=0,reads=0;
const readyHost={now:()=>time,sleep:async ms=>{time+=ms;},getTab:async()=>({url:'https://site.test/slow',status:'loading'}),command:async()=>{reads++;return {result:{value:time>=60000}};}};
await waitForBrowserDocument(readyHost,31);assert.equal(time,60000);assert.ok(reads>1);
time=0;await assert.rejects(waitForBrowserDocument({...readyHost,command:async()=>({result:{value:false}})},31,()=>{},{timeoutMs:1000}),{code:'BROWSER_UNAVAILABLE'});
const temporary='/c/local-chatgpt%3Aexample',saved='/c/saved';time=0;
const chatHost={now:()=>time,sleep:async ms=>{time+=ms;},getTab:async()=>({url:'https://chatgpt.com'+(time<3000?temporary:saved)}),conversationPath:()=>time<3000?temporary:saved};
assert.equal(await waitForBrowserConversation(chatHost,22),saved);assert.equal(time,3000);
assert.equal(browserStudyGroupTitle({title:'Marketplace - Insulation | Facebook',url:'https://facebook.com/item'}),'RT · Insulation');
assert.equal(Array.from(browserStudyGroupTitle({title:'😀'.repeat(30)})).length,25);
for(const input of [{sessionId:'bas_abcdefghij'},{chatTabId:22,tabId:21,depth:21},{chatTabId:22,tabId:21,mode:'subtree'}])assert.throws(()=>validateBrowserInput('site_read',input),{code:'BROWSER_INVALID'});
console.log('Browser groups: one controller, dynamic sites, strict schemas, resource delivery, closure, movement, worker recovery and cancellation: ok');

// Protected OOP targets never receive domain-enable or tree-read commands.
const protectedFrame=fixture();await protectedFrame.agent.start(10);
await protectedFrame.agent.onEvent({tabId:21},'Target.attachedToTarget',{sessionId:'protected',targetInfo:{type:'iframe',targetId:'ext-frame',url:'chrome-extension://OTHER/view.html'}});
await protectedFrame.run('site_read');
assert.ok(!protectedFrame.events.some(event=>event[3]==='protected'));

// A child initialization timeout does not block the main page. A late reply
// cannot continue enabling domains or resurrect that removed child session.
const slowFrame=fixture();await slowFrame.agent.start(10);slowFrame.host.frameTimeoutMs=10;
const slowCommand=slowFrame.host.command;let finishDom;
slowFrame.host.command=(tab,method,params,child)=>{
 if(child==='slow'&&method==='DOM.enable')return new Promise(resolve=>{finishDom=resolve;});
 return slowCommand(tab,method,params,child);
};
await slowFrame.agent.onEvent({tabId:21},'Target.attachedToTarget',{sessionId:'slow',targetInfo:{type:'iframe',targetId:'slow-frame',url:'https://ads.test/frame'}});
assert.ok((await slowFrame.run('site_read')).nodes.some(node=>node.role==='heading'));
finishDom({});await new Promise(resolve=>setImmediate(resolve));
assert.ok(!slowFrame.events.some(event=>event[3]==='slow'&&['Accessibility.enable','Network.enable','Page.getFrameTree'].includes(event[0])));

// Known root attach refusal has a safe, actionable code; a retry can succeed
// after the conflicting extension is disabled without losing other group tabs.
const attachBlocked=fixture();await attachBlocked.agent.start(10);attachBlocked.tabs.set(31,{id:31,url:'https://forum.test/discussion',groupId:100});
const attach=attachBlocked.host.attach;
attachBlocked.host.attach=async id=>{if(id===31)throw Error('Cannot access a chrome-extension:// URL of different extension');return attach(id);};
await assert.rejects(attachBlocked.run('site_read',{tabId:31}),error=>error.code==='BROWSER_DEBUGGER_RESTRICTED'&&/disable/.test(error.message));
assert.equal((await attachBlocked.run('site_read')).tabId,21);
attachBlocked.host.attach=attach;assert.equal((await attachBlocked.run('site_read',{tabId:31})).tabId,31);
console.log('Browser frame attachment: protected frames excluded, child initialization bounded, late replies ignored and root restrictions normalized: ok');

// Ignored parents cannot reintroduce descendants through recursive auto-attach.
await protectedFrame.agent.onEvent({tabId:21,sessionId:'protected'},'Target.attachedToTarget',{sessionId:'nested-protected',targetInfo:{type:'iframe',targetId:'nested-frame',url:'https://site.test/nested'}});
assert.ok(!protectedFrame.events.some(event=>event[3]==='nested-protected'));
const changedFrame=fixture();await changedFrame.agent.start(10);
await changedFrame.agent.onEvent({tabId:21},'Target.attachedToTarget',{sessionId:'parent',targetInfo:{type:'iframe',targetId:'parent-frame',url:'https://ads.test/parent'}});
await changedFrame.agent.onEvent({tabId:21,sessionId:'parent'},'Target.attachedToTarget',{sessionId:'nested',targetInfo:{type:'iframe',targetId:'nested-frame',url:'https://ads.test/nested'}});
await changedFrame.agent.onEvent({tabId:21},'Target.targetInfoChanged',{targetInfo:{targetId:'parent-frame',url:'chrome-extension://OTHER/view.html'}});
const afterRestricted=changedFrame.events.length;await changedFrame.run('site_read');
assert.ok(!changedFrame.events.slice(afterRestricted).some(event=>['parent','nested'].includes(event[3])));
console.log('Browser protected frame changes: ignored parents and retired descendants cannot be rediscovered through child sessions: ok');

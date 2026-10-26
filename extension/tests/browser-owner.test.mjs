import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createBrowserOwner,siteOwnerPage} from '../browser-owner.js';
import {createBrowserAgent} from '../browser-agent.js';
import {browserToolDefinitions} from '../browser-tools.js';
import {fixture} from './fixtures/browser-agent-fixture.mjs';

// Exercise the real isolated-world function, strict projection and navigation guard.
const pages=new Map([[1,vm.createContext({location:{origin:'https://chatgpt.com'}})]]);
const tab={id:1,url:'https://chatgpt.com/c/owner',groupId:10};let afterExecute=()=>{};
const owner=createBrowserOwner({getTab:async()=>tab,execute:async options=>{
 assert.equal(options.world,'ISOLATED');assert.deepEqual(options.target,{tabId:1});
 const page=pages.get(1);page.record=options.args?.[0];
 const result=vm.runInContext('('+options.func.toString()+')(record)',page);afterExecute();return [{result}];
}});
assert.equal(await owner.read(1),null);
const record={groupId:10,ownerTabId:1,state:'running'};
await owner.write(1,record);assert.deepEqual(await owner.read(1),record);
pages.get(1).__researchtubeSiteOwner.secret='PRIVATE';assert.ok(!JSON.stringify(await owner.read(1)).includes('PRIVATE'));
afterExecute=()=>{tab.groupId=11;};await assert.rejects(owner.write(1,record),{code:'TAB_LEFT_GROUP'});
afterExecute=()=>{};tab.groupId=10;
pages.set(1,vm.createContext({location:{origin:'https://example.test'}}));assert.equal(await owner.read(1),null);
await assert.rejects(owner.write(1,record),{code:'BROWSER_UNAVAILABLE'});

const f=fixture();await f.agent.start(10);
assert.equal(f.tabs.size,3);assert.equal(f.ownerMarkers.get(22).ownerTabId,22);
assert.equal(f.events.filter(e=>e[0]==='createChat').length,1);
assert.equal(f.events.filter(e=>e[0]==='prompt').length,1);
assert.deepEqual(browserToolDefinitions().map(t=>t.name),['site_list_tabs','site_read','site_get_children','site_get_node','site_get_text','site_interact','site_diagnostics_start','site_diagnostics_report','site_get_images','site_get_files','site_files_status','site_files_cancel','site_session_status','site_session_stop']);
const read=await f.run('site_read'),nodeId=read.roots[0],resourceId=read.nodes.find(n=>n.role==='image').resources[0].resourceId;
const task=await f.run('site_get_images',{resourceId,addToChat:false});
f.tabs.set(23,{id:23,url:'https://chatgpt.com/c/unrelated',groupId:100});await f.agent.onCreated();
const calls={site_get_children:{nodeId},site_get_node:{nodeId},site_get_text:{nodeId},site_interact:{action:'scroll'},site_get_images:{resourceId},site_get_files:{resourceId},site_files_status:{taskId:task.taskId},site_files_cancel:{taskId:task.taskId}};
for(const tool of browserToolDefinitions())await assert.rejects(f.run(tool.name,{chatTabId:23,...calls[tool.name]}),{code:'BROWSER_NOT_GROUP_OWNER'},tool.name);
await assert.rejects(f.agent.connectGroup(23),{code:'BROWSER_NOT_GROUP_OWNER'});
assert.deepEqual((await f.run('site_list_tabs')).group.tabs.map(t=>t.tabId),[21,22]);
assert.equal(f.ownerMarkers.get(23).ownerTabId,22,'ignored GPT mirrors controller identity without touching Composer');
const recreated=createBrowserAgent(f.host);
await assert.rejects(recreated.execute('site_list_tabs',{chatTabId:23}),{code:'BROWSER_NOT_GROUP_OWNER'},'first caller after worker restart cannot steal ownership');
assert.equal((await recreated.execute('site_list_tabs',{chatTabId:22})).group.chatTabId,22);

// A title or ignored chat does not create site membership noise.
await f.run('site_list_tabs');f.tabs.get(23).title='Changed';await f.agent.onUpdated(23,{title:'Changed'});
assert.equal((await f.run('site_read')).groupChanges,undefined);
f.tabs.set(31,{id:31,url:'https://example.test/second',title:'Second',groupId:100});await f.agent.onCreated();
assert.equal((await f.run('site_read')).groupChanges.added[0].tabId,31);
assert.equal((await f.run('site_read')).groupChanges,undefined);
f.tabs.get(31).groupId=999;await f.agent.onUpdated(31,{groupId:999});
assert.deepEqual((await f.run('site_read')).groupChanges.removedTabIds,[31]);
f.tabs.delete(21);await f.agent.onRemoved(21);
assert.equal((await f.run('site_session_status')).group.state,'idle');
f.tabs.set(32,{id:32,url:'https://example.test/third',groupId:100});await f.agent.onCreated();
assert.equal((await f.run('site_session_status')).group.state,'running');

// Stop persists across worker recreation. Explicit reconnect belongs to the owner.
await f.run('site_session_stop');const stopped=createBrowserAgent(f.host);
assert.equal((await stopped.execute('site_session_status',{chatTabId:22})).group.state,'stopped');
await assert.rejects(stopped.connectGroup(23),{code:'BROWSER_NOT_GROUP_OWNER'});
await stopped.connectGroup(22);assert.equal((await stopped.execute('site_session_status',{chatTabId:22})).group.state,'running');

// Closing the owner cancels all source tasks and leaves no replacement controller.
const closed=fixture();await closed.agent.start(10);
closed.tabs.set(23,{id:23,url:'https://chatgpt.com/c/unrelated',groupId:100});await closed.agent.onCreated();
const image=(await closed.run('site_read')).nodes.find(n=>n.role==='image').resources[0].resourceId;
await closed.run('site_get_images',{resourceId:image});closed.tabs.delete(22);await closed.agent.onRemoved(22);
await closed.scheduled.shift()();assert.equal(closed.uploads.length,0);
assert.equal(closed.ownerMarkers.get(23).state,'stopped');
const afterClosure=createBrowserAgent(closed.host);
await assert.rejects(afterClosure.connectGroup(23),{code:'BROWSER_NOT_GROUP_OWNER'});


// Navigating the owner away from ChatGPT also stops every source and delivery.
const navigated=fixture();await navigated.agent.start(10);
navigated.tabs.set(23,{id:23,url:'https://chatgpt.com/c/unrelated',groupId:100});await navigated.agent.onCreated();
const pendingImage=(await navigated.run('site_read')).nodes.find(n=>n.role==='image').resources[0].resourceId;
await navigated.run('site_get_images',{resourceId:pendingImage});
navigated.tabs.get(22).url='https://example.test/no-longer-a-chat';await navigated.agent.onUpdated(22,{url:navigated.tabs.get(22).url});
assert.equal(navigated.agent.localStatus(21).state,'stopped');
assert.equal(navigated.ownerMarkers.get(23).state,'stopped');
await navigated.scheduled.shift()();assert.equal(navigated.uploads.length,0);

// Missing markers in an ambiguous old/manual group fail closed, without election.
const manual=fixture();manual.tabs.set(41,{id:41,url:'https://chatgpt.com/c/manual',groupId:80});
manual.tabs.set(42,{id:42,url:'https://example.test',groupId:80});
assert.equal((await manual.agent.execute('site_list_tabs',{chatTabId:41})).chatTabId,41,'first productive Site call claims an unambiguous manual group');
assert.equal((await manual.agent.connectGroup(41)).chatTabId,41);
const ambiguous=fixture();ambiguous.tabs.set(41,{id:41,url:'https://chatgpt.com/c/one',groupId:80});ambiguous.tabs.set(42,{id:42,url:'https://chatgpt.com/c/two',groupId:80});
await assert.rejects(ambiguous.agent.connectGroup(41),{code:'BROWSER_OWNER_CONFLICT'});
assert.equal(ambiguous.ownerMarkers.size,0);

// Twenty-image batches stay whole and use the same leading Composer once.
const twenty=fixture({imageCount:21});await twenty.agent.start(10);
const ids=(await twenty.run('site_read')).nodes.flatMap(n=>n.resources).map(r=>r.resourceId);
assert.equal(ids.length,21);
await assert.rejects(twenty.run('site_get_images',{resourceIds:ids}),error=>error.code==='BROWSER_INVALID'&&error.message.includes('20'));
assert.equal(twenty.scheduled.length,0);assert.equal(twenty.saved.length,0);
const twentyTask=await twenty.run('site_get_images',{resourceIds:ids.slice(0,20)});await twenty.scheduled.shift()();
assert.equal((await twenty.run('site_files_status',{taskId:twentyTask.taskId})).status,'completed');
assert.equal(twenty.saved.length,20);assert.equal(twenty.uploads.length,1);assert.equal(twenty.uploads[0].files.length,20);assert.equal(twenty.uploads[0].options.target.tabId,22);
console.log('Site controller: isolated markers, no election, worker recovery, per-tool ownership, manual sites, owner closure, Stop/resume and twenty-file delivery passed.');

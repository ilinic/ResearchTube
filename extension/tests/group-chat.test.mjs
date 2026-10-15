import assert from 'node:assert/strict';
import {fixture} from './fixtures/browser-agent-fixture.mjs';
import {normalizeGroupHistory,isGroupChatView} from '../group-chat.js';
import {browserToolDefinitions,validateBrowserInput} from '../browser-tools.js';
import {createBrowserAgent} from '../browser-agent.js';

const f=fixture();const started=await f.agent.start(10);
assert.equal(started.group.totalTabs,4);assert.deepEqual(started.chatTabIds,[22,23]);
assert.equal(f.events.filter(e=>e[0]==='prompt').length,2);
for(const e of f.events.filter(e=>e[0]==='prompt')){
 assert.match(e[2],/independent researcher/);assert.match(e[2],/site_board_post/);assert.match(e[2],/site_board_read/);
 assert.doesNotMatch(e[2],/site_send_message|site_chat_read/);
}
assert.equal((await f.run('site_board_open')).tabId,24);
const room=[...f.journal.rooms.values()][0],count=room.entries.length;
f.tabs.set(90,{...f.tabs.get(24),id:90});await f.agent.onCreated();
assert.equal(room.entries.length,count,'views are not publications or research participants');
await assert.rejects(f.run('site_read',{tabId:24}),{code:'BROWSER_INVALID'});
f.tabs.delete(24);f.tabs.delete(90);await f.agent.onRemoved(24);

for(let i=0;i<3;i++)await f.run('site_board_post',{text:'FINDING '+i});
assert.equal(f.messages.length,0);assert.equal(f.notifications.length,0,'no delivery timers');
assert.equal((await f.run('site_read')).board,undefined,'own publications do not count as unread');
let peer=await f.run('site_read',{chatTabId:23});assert.deepEqual(peer.board,{unreadCount:3,latestId:3});
assert.deepEqual((await f.run('site_read',{chatTabId:23})).board,peer.board,'indicators repeat without advancing cursor');
const first=await f.run('site_board_read',{chatTabId:23,limit:2});
assert.deepEqual(first.entries.map(e=>e.text),['FINDING 0','FINDING 1']);assert.equal(first.hasMore,true);assert.equal(first.board.unreadCount,1);
await f.run('site_board_read',{chatTabId:23,beforeId:3});
assert.equal((await f.run('site_read',{chatTabId:23})).board.unreadCount,1,'explicit history navigation leaves cursor untouched');
await f.run('site_board_post',{chatTabId:23,text:'My finding'});
assert.equal((await f.run('site_read',{chatTabId:23})).board.unreadCount,1,'posting cannot skip peer entries');
assert.deepEqual((await f.run('site_board_read',{chatTabId:23})).entries.map(e=>e.text),['FINDING 2','My finding']);
assert.equal((await f.run('site_board_read',{chatTabId:23})).entries.length,0,'automatic reads do not duplicate');
assert.equal((await f.run('site_read',{chatTabId:23})).board,undefined);
assert.equal((await f.run('site_read')).board.unreadCount,1,'each GPT has its own cursor');

// Membership changes are passive, per-conversation, and survive failed calls.
await f.run('site_list_tabs');await f.run('site_list_tabs',{chatTabId:23});
f.tabs.set(31,{id:31,url:'https://example.test/another',title:'Another site',groupId:100});await f.agent.onCreated();
await assert.rejects(f.run('site_get_node',{nodeId:'n_21_0_123456'}));
const added=await f.run('site_read');assert.equal(added.groupChanges.added[0].tabId,31);
assert.equal((await f.run('site_read')).groupChanges,undefined);
assert.equal((await f.run('site_read',{chatTabId:23})).groupChanges.added[0].tabId,31);
f.tabs.get(31).title='Different title';await f.agent.onUpdated(31,{title:'Different title'});
assert.equal((await f.run('site_read')).groupChanges,undefined,'titles do not create membership noise');
f.tabs.set(32,{id:32,url:'https://chatgpt.com/c/third',groupId:100});await f.agent.onCreated();
assert.equal((await f.run('site_read')).groupChanges.added[0].role,'chatgpt');
f.tabs.delete(31);await f.agent.onRemoved(31);
assert.deepEqual((await f.run('site_read')).groupChanges.removedTabIds,[31]);
assert.equal(f.messages.length,0);assert.equal(room.entries.length,4,'membership never publishes Board messages');
const recreated=createBrowserAgent(f.host);
const recovered=await recreated.execute('site_read',{chatTabId:22,tabId:21});
assert.equal(recovered.groupChanges.resyncRequired,true);
assert.equal(f.notifications.length,0,'worker recovery never resumes old delivery');
await recreated.execute('site_list_tabs',{chatTabId:22});
assert.equal((await recreated.execute('site_read',{chatTabId:22,tabId:21})).groupChanges,undefined);
f.tabs.get(23).url='https://chatgpt.com/c/changed';await f.agent.onUpdated(23,{url:f.tabs.get(23).url});
assert.equal((await f.run('site_read',{chatTabId:23})).board.unreadCount,3,'reused tab/conversation has a fresh cursor');

// No input/Send bypass through peer automation, including a queued navigation.
const read=await f.run('site_read',{tabId:23});
for(const [action,args] of [['click',{nodeId:read.nodes.find(n=>n.role==='button').nodeId}],['type',{nodeId:read.nodes.find(n=>n.role==='textbox').nodeId,text:'bypass'}],['key',{key:'Enter'}],['select',{nodeId:read.nodes.find(n=>n.role==='combobox').nodeId,value:'a'}]]){
 const before=f.events.length;
 await assert.rejects(f.run('site_interact',{tabId:23,action,...args}),{code:'BROWSER_INVALID'});
 assert.ok(!f.events.slice(before).some(e=>/^Input\./.test(e[0])));
}
await f.run('site_interact',{tabId:23,action:'scroll'});
await f.run('site_interact',{tabId:23,action:'hover',nodeId:read.nodes.find(n=>n.role==='button').nodeId});

// Board metadata is optional; page reads and own file tasks keep working offline.
const original=f.host.groupChatRequest;
f.host.groupChatRequest=async()=>{throw Object.assign(Error('private data'),{code:'AGENT_UNAVAILABLE'});};
assert.ok((await f.run('site_read')).nodes.length);assert.equal((await f.run('site_read')).board,undefined);
await assert.rejects(f.run('site_board_read'),{code:'AGENT_UNAVAILABLE'});
await assert.rejects(f.run('site_board_post',{text:'No false success'}),{code:'AGENT_UNAVAILABLE'});
f.host.groupChatRequest=original;
assert.equal(f.messages.length,0);
const navigation=fixture();await navigation.agent.start(10);
const page=await navigation.run('site_read');
const control=page.nodes.find(node=>node.role==='textbox').nodeId;
// Queue is captured when the controller is built; change the real URL after
// the initial membership check but before the actual page mutation.
const command=navigation.host.command;
navigation.host.command=async(...args)=>{
 if(args[1]==='DOM.resolveNode')navigation.tabs.get(21).url='https://chatgpt.com/c/moved-to-gpt';
 return command(...args);
};
await assert.rejects(navigation.run('site_interact',{action:'type',nodeId:control,text:'no peer write'}));
assert.ok(!navigation.events.some(e=>e[0]==='Input.insertText'),'late navigation cannot bypass peer input policy');
const compact=fixture();await compact.agent.start(10);
for(let i=1000;i<1030;i++)compact.tabs.set(i,{id:i,groupId:100,url:'https://example.test/'+i});
await compact.agent.onCreated();
assert.equal((await compact.run('site_read')).groupChanges.resyncRequired,true,'large changes stay compact');
assert.equal(compact.notifications.length,0);
const source=await (await import('node:fs/promises')).readFile(new URL('../background.js',import.meta.url),'utf8');
assert.doesNotMatch(source,/alarms\.create\("group-chat-delivery"/,'old delivery alarm is never scheduled');
const offline=fixture();offline.host.groupChatReady=async()=>{throw Object.assign(Error('offline'),{code:'AGENT_UNAVAILABLE'});};
await assert.rejects(offline.agent.start(10),{code:'AGENT_UNAVAILABLE'});assert.equal(offline.events.length,0);

for(const old of ['site_send_message','site_chat_read','site_chat_open']){
 assert.ok(!browserToolDefinitions().some(t=>t.name===old));
 assert.throws(()=>validateBrowserInput(old,{chatTabId:22,text:'x'}),{code:'BROWSER_INVALID'});
}
for(const args of [{text:'x',recipientTabIds:[23]},{text:'x',tabId:23},{text:'x',roomId:'gc_test'},{text:' '}])assert.throws(()=>validateBrowserInput('site_board_post',{chatTabId:22,...args}),{code:'BROWSER_INVALID'});
for(const args of [{afterId:1,beforeId:2},{addressedOnly:true}])assert.throws(()=>validateBrowserInput('site_board_read',{chatTabId:22,...args}),{code:'BROWSER_INVALID'});
const good={entries:[{id:1,time:new Date().toISOString(),senderTabId:22,text:'data',secret:'PRIVATE'}],firstId:1,lastId:1,latestId:1,hasMore:false,hasOlder:false};
assert.ok(!JSON.stringify(normalizeGroupHistory(good)).includes('PRIVATE'));
assert.equal(normalizeGroupHistory({...good,entries:[{...good.entries[0],text:'prefix'+'\u0001'.repeat(11990)}]}).entries.length,1,'a whole heavily escaped publication remains readable');
assert.throws(()=>normalizeGroupHistory({...good,entries:[{...good.entries[0],senderTabId:'PRIVATE'}]}),{code:'AGENT_INVALID_RESPONSE'});
assert.ok(isGroupChatView({url:'http://127.0.0.1:17843/group-chat/gc_0123456789012345678901'}));
assert.ok(!isGroupChatView({url:'https://evil.test/group-chat/gc_0123456789012345678901'}));
console.log('Shared Board: independent startup, passive unread/membership, cursors, no wake-up, peer input blocked, offline transparency and strict contracts passed.');

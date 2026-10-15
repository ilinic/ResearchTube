// Execute the shipped Agent viewer script against a small deterministic DOM.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../../agent/group_chat.py',import.meta.url),'utf8');
const script=source.match(/<script>\n([\s\S]*?)<\/script>/)[1];
function viewer(){
 const callbacks={},requests=[],deferred=[];
 class Node {
  constructor(tag){this.tag=tag;this.children=[];this.textContent='';}
  append(...nodes){for(const node of nodes)this.children.push(...(node.tag==='fragment'?node.children:[node]));}
  prepend(node){this.children.unshift(...node.children);}
 }
 const messages=new Node('main');
 const document={getElementById:id=>{assert.equal(id,'messages');return messages;},createElement:tag=>new Node(tag),createDocumentFragment:()=>new Node('fragment'),documentElement:{get scrollHeight(){return Math.max(500,messages.children.length*120);}}};
 const context={URLSearchParams,document,location:{pathname:'/group-chat/gc_fixture'},innerHeight:500,scrollY:0,
  console:{warn(){}},queueMicrotask:fn=>deferred.push(fn),addEventListener:(name,fn)=>callbacks[name]=fn,setInterval:fn=>callbacks.poll=fn,
  scrollTo:(_x,y)=>{context.scrollY=Math.max(0,Math.min(y,document.documentElement.scrollHeight-500));},
  fetch:async url=>new Promise(resolve=>requests.push({url,resolve}))};
 vm.createContext(context);vm.runInContext(script,context);
 const complete=async(entries,hasOlder=false)=>{
  const request=requests.at(-1);
  request.resolve({ok:true,json:async()=>({entries,firstId:entries[0]?.id??null,lastId:entries.at(-1)?.id??null,hasOlder})});
  await new Promise(resolve=>setImmediate(resolve));
 };
 return {context,messages,callbacks,requests,complete,deferred};
}
const entry=id=>({id,time:'2026-10-15T00:00:00Z',senderTabId:22,text:id===7?'<script>alert(1)</script>\nplain text':'Finding '+id});
const v=viewer();
await v.complete([6,7,8,9,10].map(entry),true);
assert.equal(v.context.scrollY,100,'initial latest page scrolls to bottom');
assert.equal(v.messages.children[1].children[1].textContent,entry(7).text,'HTML is literal text');
assert.equal(v.messages.children[0].children[0].textContent,'2026-10-15T00:00:00Z · GPT 22');
v.callbacks.poll();await v.complete([entry(11)]);
assert.equal(v.context.scrollY,220,'new posts keep an existing bottom position');
v.context.scrollY=110;v.callbacks.poll();await v.complete([entry(12)]);
assert.equal(v.context.scrollY,110,'reading old text does not scroll');
v.context.scrollY=340;v.callbacks.poll();v.context.scrollY=110;await v.complete([entry(13)]);
assert.equal(v.context.scrollY,110,'scrolling up during HTTP prevents stale auto-scroll');
v.context.scrollY=0;v.callbacks.scroll();
assert.match(v.requests.at(-1).url,/beforeId=6/);
await v.complete([1,2,3,4,5].map(entry));
assert.equal(v.context.scrollY,600,'prepend preserves the visible article');
assert.deepEqual(v.messages.children.map(node=>node.children[1].textContent),Array.from({length:13},(_,i)=>entry(i+1).text));
const before=v.requests.length;v.context.scrollY=0;v.callbacks.scroll();
assert.equal(v.requests.length,before,'no older request when exhausted');
const short=viewer();await short.complete([entry(10)],true);
assert.equal(short.deferred.length,1,'short latest pages can reach older data without a scrollbar');
short.deferred.shift()();assert.match(short.requests.at(-1).url,/beforeId=10/);
await short.complete([5,6,7,8,9].map(entry));
const outage=viewer();await outage.complete([entry(10)],true);
outage.deferred.shift()();outage.requests.at(-1).resolve({ok:false});
await new Promise(resolve=>setImmediate(resolve));
assert.equal(outage.deferred.length,0,'HTTP failure must not spin a microtask retry loop');
assert.equal(outage.requests.length,2);
console.log('Board Viewer: safe text, no header, infinite history, prepend position and user scrolling during fetch passed.');

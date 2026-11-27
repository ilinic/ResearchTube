import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {webcrypto} from "node:crypto";
const src=await readFile(new URL("../background.js",import.meta.url),"utf8");
const begin=src.indexOf("function planProjectPath("),end=src.indexOf("async function scheduledWatchdogTick()",begin);
assert.ok(begin>=0&&end>begin);
const tab={id:1,url:"https://chatgpt.com/c/first",groupId:4};
const path=u=>new URL(u).pathname;
const decisions=[],actions=[];
let now=1000000, current=null, queue=[{id:1,prompt:"first task",delay_seconds:0},{id:2,prompt:"second task",delay_seconds:5}];
let p={version:1,paused:false,retired:false,idle_anchor:null,idle_since:null,goal:"",skills:[]};
let state={ready:true,draft:false,anchor:"u1:a1",taskMarkers:[],contextLimit:false};
const peek=()=>({...p,current:current&&{...current},next:queue[0]&&{...queue[0]}});
const transition=async(id,version,action,fields={})=>{
 assert.equal(version,p.version);actions.push(action);
 if(action==="observe"){p.idle_anchor=fields.anchor;p.idle_since=now;}
 else if(action==="claim"){current={...queue.shift(),...fields,status:"claimed"};}
 else if(action==="dispatch"){assert.equal(current.status,"claimed");current.status="dispatching";}
 else if(action==="sent"){assert.equal(current.status,"dispatching");current.status="sent";}
 else if(action==="finish"){current=null;p.idle_anchor=fields.anchor;p.idle_since=now;}
 else throw Error("unexpected "+action);
 p.version++;return true;
};
const send=async(id,options)=>{
 assert.equal(id,1);await options.beforeSend();await options.beforeInsert();
 // Real CDP contract: the guard may be invoked more than once.
 await options.beforeDispatch();await options.beforeDispatch();
 assert.equal(current.status,"dispatching");return {sent:true};
};
const factory=new Function("chrome","chatConversationPath","planConversationId","scheduledChatState","scheduledPending","callSharedMemory","planTransition","planOperationKey","sendComposerWhenReady","planDecision","localAgentError","Date",src.slice(begin,end)+"\nreturn {runPlannedChat,rolloverLanding,planProjectPath};");
const env=factory({tabs:{get:async()=>tab,query:async()=>[tab]}},path,u=>path(u).split("/").at(-1),async()=>state,async()=>null,async()=>peek(),transition,async v=>"plan."+Buffer.from(await webcrypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(v)))).toString("hex"),send,(...a)=>decisions.push(a),(code,msg)=>Object.assign(Error(msg),{code}),{now:()=>now});
assert.equal(env.rolloverLanding("https://chatgpt.com/g/g-p-abc-project/c/old"),"https://chatgpt.com/g/g-p-abc-project/project");
assert.equal(env.rolloverLanding("https://chatgpt.com/c/old"),"https://chatgpt.com/");
assert.equal(env.rolloverLanding("https://chatgpt.com/g/g-custom/c/old"),null);
await env.runPlannedChat(tab,"first");assert.deepEqual(actions,["observe"]);
await env.runPlannedChat(tab,"first");assert.deepEqual(actions,["observe","claim","dispatch","sent"]);
state={...state,ready:false,reason:"CHAT_GENERATING",anchor:"u2:a2"};
await env.runPlannedChat(tab,"first");assert.equal(current.status,"sent");
state={...state,ready:true,reason:null};
await env.runPlannedChat(tab,"first");assert.equal(actions.at(-1),"finish");
now+=4999;await env.runPlannedChat(tab,"first");assert.equal(actions.at(-1),"finish");
now+=1;await env.runPlannedChat(tab,"first");assert.deepEqual(actions.slice(-3),["claim","dispatch","sent"]);
assert.equal(actions.filter(x=>x==="dispatch").length,2);
assert.equal(decisions.filter(x=>x[1]==="sent").length,2);
console.log("plan dispatch guards, independent idle delay and project rollover routing: ok");

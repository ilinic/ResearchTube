import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {webcrypto} from "node:crypto";
const src=await readFile(new URL("../background.js",import.meta.url),"utf8");
const begin=src.indexOf("function planProjectPath("),end=src.indexOf("async function scheduledWatchdogTick()",begin);
assert.ok(begin>=0&&end>begin);
const tab={id:1,url:"https://chatgpt.com/c/first",groupId:4};
const path=u=>new URL(u).pathname;
const decisions=[],actions=[],sentMessages=[];
let now=1000000, current=null, queue=[{id:1,prompt:"first task",delay_seconds:0},{id:2,prompt:"second task",delay_seconds:5}];
let p={version:1,paused:false,retired:false,idle_anchor:null,idle_since:null,goal:"Persistent test objective",skills:[{id:1,name:"Test method",version:1}]};
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
 assert.equal(id,1);sentMessages.push(options.completionText);await options.beforeSend();await options.beforeInsert();
 // Real CDP contract: the guard may be invoked more than once.
 await options.beforeDispatch();await options.beforeDispatch();
 assert.equal(current.status,"dispatching");return {sent:true};
};
const factory=new Function("chrome","chatConversationPath","planConversationId","scheduledChatState","scheduledPending","callSharedMemory","planTransition","planOperationKey","sendComposerWhenReady","planDecision","localAgentError","Date","reliabilityTrace","URL","TextEncoder",'const ROLLOVER_PREFIX="researchtubePlanRollover:";\n'+src.slice(begin,end)+"\nreturn {runPlannedChat,rolloverLanding,planProjectPath,normalizePlanRolloverKiB,planRolloverPressure,rolloverSourceEligible,resumePlanRollover};");
const env=factory({tabs:{get:async()=>tab,query:async()=>[tab]}},path,u=>path(u).split("/").at(-1),async()=>state,async()=>null,async()=>peek(),transition,async v=>"plan."+Buffer.from(await webcrypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(v)))).toString("hex"),send,(...a)=>decisions.push(a),(code,msg)=>Object.assign(Error(msg),{code}),{now:()=>now},{add(){}},URL,TextEncoder);
assert.equal(env.rolloverLanding("https://chatgpt.com/g/g-p-abc-project/c/old"),"https://chatgpt.com/g/g-p-abc-project/project");
assert.equal(env.rolloverLanding("https://chatgpt.com/c/old"),"https://chatgpt.com/");
assert.equal(env.rolloverLanding("https://chatgpt.com/g/g-custom/c/old"),null);
await env.runPlannedChat(tab,"first");assert.deepEqual(actions,["observe"]);
await env.runPlannedChat(tab,"first");assert.deepEqual(actions,["observe","claim","dispatch","sent"]);
state={...state,ready:false,reason:"CHAT_GENERATING",anchor:"u2:a2"};
await env.runPlannedChat(tab,"first");assert.equal(current.status,"sent");
assert.match(sentMessages[0],/Persistent test objective/);
const contextMarker=sentMessages[0].match(/\[ResearchTube context ([a-f0-9]{64})\]/)[1];
const firstMarker=current.marker;
state={...state,ready:true,reason:null,explicitIdle:true,hasAssistant:true,completionAnchor:"response-1",respondedTaskMarkers:[],contextMarkers:[contextMarker]};
await env.runPlannedChat(tab,"first");assert.equal(actions.at(-1),"sent");
state={...state,respondedTaskMarkers:[firstMarker]};
await env.runPlannedChat(tab,"first");assert.equal(actions.at(-1),"sent");
now+=2999;await env.runPlannedChat(tab,"first");assert.equal(actions.at(-1),"sent");
state={...state,completionAnchor:"response-2"};
await env.runPlannedChat(tab,"first");assert.equal(actions.at(-1),"sent");
now+=3000;state={...state,ready:false,generating:true};await env.runPlannedChat(tab,"first");assert.equal(actions.at(-1),"sent");
state={...state,ready:true,generating:false};await env.runPlannedChat(tab,"first");assert.equal(actions.at(-1),"sent");
now+=3000;await env.runPlannedChat(tab,"first");assert.equal(actions.at(-1),"finish");
now+=4999;await env.runPlannedChat(tab,"first");assert.equal(actions.at(-1),"finish");
now+=1;await env.runPlannedChat(tab,"first");assert.deepEqual(actions.slice(-3),["claim","dispatch","sent"]);
assert.equal(actions.filter(x=>x==="dispatch").length,2);
assert.doesNotMatch(sentMessages[1],/Persistent test objective|Test method/);
assert.match(sentMessages[1],/force_full=true/);
assert.match(sentMessages[0],/verified the current chatTabId: 1/);
assert.match(sentMessages[1],/verified the current chatTabId: 1/);
assert.equal(decisions.filter(x=>x[1]==="sent").length,2);
console.log("plan dispatch guards, independent idle delay and project rollover routing: ok");

assert.equal(env.normalizePlanRolloverKiB(undefined),224);
assert.equal(env.normalizePlanRolloverKiB(0),0);
assert.equal(env.normalizePlanRolloverKiB(64),224);
assert.equal(env.planRolloverPressure("first",{visibleHistoryBytes:999999},{rolloverKiB:0}),null);
assert.equal(env.planRolloverPressure("first",{visibleHistoryBytes:999999},{rolloverKiB:768}).source,"visible_history");
assert.equal(env.rolloverSourceEligible({ready:true,anchor:"x",draft:false},{mode:"proactive",sourceAnchor:"x"}),true);
assert.equal(env.rolloverSourceEligible({ready:true,anchor:"y",draft:false},{mode:"proactive",sourceAnchor:"x"}),false);
assert.equal(env.rolloverSourceEligible({contextLimit:true,draft:true},{mode:"hard_limit"}),false);
const marker="a".repeat(64),old={id:10,url:"https://chatgpt.com/c/old",windowId:1,groupId:4},fresh={id:11,url:"https://chatgpt.com/c/new",windowId:1,groupId:4};
const journalKey="researchtubePlanRollover:old";
const journal={chatId:"old",oldTabId:10,oldUrl:old.url,windowId:1,groupId:4,newTabId:11,marker,phase:"sent",mode:"hard_limit"};
async function recovery({oldOpen=false,ack=true,successorReady=false,oldDraft=false,alreadyCommitted=false,proactive=false,oldChanged=false,reopened=false,newReopened=false,ambiguous=false,legacyAlertGone=false,changedPlan=false}={}){
  const liveOld={...old,id:reopened?20:10},liveFresh={...fresh,id:newReopened?21:11};
  const duplicate={...liveFresh,id:22,url:"https://chatgpt.com/c/other"};
  let stored={[journalKey]:{...journal,...(proactive?{mode:"proactive",sourceAnchor:"source"}:{})}},retired=alreadyCommitted,removed=[],moved=0,logged=[];
  let next={id:9,prompt:"continue original task",delay_seconds:0},cur=null,version=1,idleAnchor=null,idleSince=null,sent=[];
  const tabs={get:async id=>id===liveFresh.id?liveFresh:id===liveOld.id&&oldOpen?liveOld:Promise.reject(Error("closed")),query:async()=>[...(oldOpen&&!removed.length?[liveOld]:[]),liveFresh,...(ambiguous?[duplicate]:[])],remove:async id=>{removed.push(id);oldOpen=false;}};
  const storage={local:{get:async key=>({[key]:stored[key]}),set:async x=>Object.assign(stored,x),remove:async key=>delete stored[key]}};
  const live=id=>id===liveFresh.id||id===duplicate.id?{ready:successorReady,draft:false,anchor:"successor",acknowledgedRolloverMarkers:ack?[marker]:[],rolloverMarkers:[marker]}:{contextLimit:!proactive&&!legacyAlertGone,ready:true,anchor:oldChanged?"changed":"source",draft:oldDraft};
  const read=async(name,a)=>({retired:a.chat_id==="old"&&retired,chat_id:retired?"new":"old",agent_id:"old",version,paused:false,goal:"goal",state:"checkpoint",current:cur,next,idle_anchor:idleAnchor,idle_since:idleSince});
  const mutate=async(id,v,action,fields)=>{
    assert.equal(v,version);
    if(action==="rollover"){assert.equal(fields.successor,"new");retired=true;moved++;}
    else if(action==="observe"){idleAnchor=fields.anchor;idleSince=now;}
    else if(action==="claim"){cur={...next,...fields,status:"claimed"};next=null;}
    else if(action==="dispatch")cur.status="dispatching";
    else if(action==="sent")cur.status="sent";
    else throw Error("unexpected "+action);
    version++;return true;
  };
  const sendNew=async(id,options)=>{assert.equal(id,liveFresh.id);sent.push(options.completionText);await options.beforeSend();await options.beforeInsert();await options.beforeDispatch();return {sent:true};};
  const instance=factory({tabs,storage},path,u=>u?path(u).split("/").at(-1):null,async id=>live(id),async()=>null,read,mutate,async()=>"plan."+(changedPlan?"b".repeat(64):marker),sendNew,(...a)=>logged.push(a),(code,msg)=>Object.assign(Error(msg),{code}),{now:()=>now},{add(){}},URL,TextEncoder);
  if(proactive&&oldOpen)await instance.runPlannedChat(liveOld,"old",{rolloverKiB:768},stored[journalKey]);
  else await instance.resumePlanRollover(liveOld,"old",{retired,paused:false},{});
  if(retired&&!stored[journalKey]&&successorReady){
    await instance.runPlannedChat(liveFresh,"new");
    await instance.runPlannedChat(liveFresh,"new");
  }
  return {moved,removed,stored,logged,sent};
}
let rec=await recovery();assert.equal(rec.moved,1);assert.deepEqual(rec.removed,[]);assert.equal(rec.stored[journalKey],undefined);assert.equal(rec.logged.at(-1)[2],"ROLLOVER_COMPLETE");
rec=await recovery({oldOpen:true,successorReady:true});assert.equal(rec.moved,1);assert.deepEqual(rec.removed,[10]);assert.equal(rec.sent.length,1);assert.match(rec.sent[0],/continue original task/);assert.match(rec.sent[0],/verified the current chatTabId: 11/);
rec=await recovery({ack:false});assert.equal(rec.moved,0);assert.ok(rec.stored[journalKey]);assert.equal(rec.logged.at(-1)[2],"ROLLOVER_ACK_RESPONSE_PENDING");
rec=await recovery({oldOpen:true,oldDraft:true});assert.equal(rec.moved,0);assert.deepEqual(rec.removed,[]);
rec=await recovery({oldOpen:true,oldDraft:true,alreadyCommitted:true});assert.equal(rec.moved,0);assert.deepEqual(rec.removed,[]);assert.ok(rec.stored[journalKey]);
rec=await recovery({oldOpen:true,ack:false,alreadyCommitted:true});assert.equal(rec.moved,0);assert.deepEqual(rec.removed,[10]);
rec=await recovery({oldOpen:true,proactive:true,successorReady:true});assert.equal(rec.moved,1);assert.deepEqual(rec.removed,[10]);assert.equal(rec.sent.length,1);
rec=await recovery({oldOpen:true,proactive:true,oldChanged:true});assert.equal(rec.moved,0);assert.deepEqual(rec.removed,[]);
assert.match(src,/if\(id!==journal\.chatId\|\|chats\.has\(id\)\|\|activePlanChats\.has\(id\)\)continue;/);
console.log("proactive pressure, acknowledged handoff recovery, automatic successor dispatch, draft safety: ok");

rec=await recovery({oldOpen:true,reopened:true,successorReady:true});assert.equal(rec.moved,1);assert.deepEqual(rec.removed,[20]);assert.equal(rec.sent.length,1);
rec=await recovery({oldOpen:true,reopened:true,newReopened:true,legacyAlertGone:true,successorReady:true});assert.equal(rec.moved,1);assert.deepEqual(rec.removed,[20]);assert.equal(rec.sent.length,1);
rec=await recovery({oldOpen:true,reopened:true,ambiguous:true});assert.equal(rec.moved,0);assert.deepEqual(rec.removed,[]);assert.equal(rec.logged.at(-1)[2],"ROLLOVER_SUCCESSOR_AMBIGUOUS");
rec=await recovery({oldOpen:true,reopened:true,legacyAlertGone:true,changedPlan:true});assert.equal(rec.moved,0);assert.deepEqual(rec.removed,[]);
console.log("reopened tab IDs, unique marker, legacy alert disappearance, version safety: ok");

// Exercise the actual injected DOM callback, not a mocked ACK flag.
const domBegin=src.indexOf("async function scheduledChatState("),domEnd=src.indexOf("// Browser-local recovery journal",domBegin);
assert.ok(domBegin>=0&&domEnd>domBegin);
const markerText="[ResearchTube rollover "+marker+"]";
function domNode(text="",attrs={}){
  return {innerText:text,textContent:text,parentElement:null,childNodes:[],getAttribute:k=>attrs[k]||null,closest:()=>null,matches:()=>false,querySelectorAll:()=>[],querySelector:()=>null,getClientRects:()=>[{}]};
}
async function inspectDom({native=[],turns=[],headingTurns=[],stop=false,idle=false}={}){
  const root=domNode(),headingNodes=headingTurns.map(x=>domNode(x[0])),blocks=headingTurns.map(x=>x[1].map(y=>domNode(y)));
  root.childNodes=headingNodes;
  const roles='[data-message-author-role="user"],[data-message-author-role="assistant"]';
  root.querySelectorAll=selector=>selector===roles?native:selector.startsWith('[data-testid^="conversation-turn-"]')?turns:selector.startsWith("h1,h2")?headingNodes:[];
  const form=domNode(),composer=domNode("",{contenteditable:"true"}),stopButton=domNode("",{"aria-label":"Stop"}),sendButton=domNode("",{"aria-label":"Send message"});
  composer.closest=()=>form;
  form.querySelectorAll=selector=>selector==='button,[role="button"]'?(stop?[stopButton]:idle?[sendButton]:[]):selector.includes('button[type="submit"]')&&idle?[sendButton]:[];
  const doc={readyState:"complete",querySelector:s=>s==="main"?root:null,querySelectorAll:selector=>selector.includes('#prompt-textarea')?[composer]:selector.includes('button[data-testid="stop-button"]')&&stop?[stopButton]:[],createRange:()=>{
    let i=-1;return {setStartAfter:h=>{i=headingNodes.indexOf(h);},setEndBefore(){},setEnd(){},cloneContents:()=>({querySelectorAll:s=>s.startsWith("p,pre")?blocks[i]:[]})};
  }};
  const chromeMock={scripting:{executeScript:async({func})=>[{result:func()}]}};
  const run=new Function("chrome","document","getComputedStyle","TextEncoder",src.slice(domBegin,domEnd)+"\nreturn scheduledChatState;")(chromeMock,doc,()=>({visibility:"visible",display:"block"}),TextEncoder);
  return run(99);
}
const user=(body)=>domNode(body,{"data-message-author-role":"user"});
const assistant=(body)=>domNode(body,{"data-message-author-role":"assistant"});
let observed=await inspectDom({native:[user("You said:\n"+markerText+"\nGoal"),assistant("ChatGPT said:\nAcknowledged.")]});
assert.deepEqual(observed.acknowledgedRolloverMarkers,[marker]);
observed=await inspectDom({native:[user("You said:"+markerText+"\nGoal"),assistant("Acknowledged.")]});
assert.deepEqual(observed.acknowledgedRolloverMarkers,[marker]);
observed=await inspectDom({headingTurns:[["You said:",[markerText,"Goal"]],["ChatGPT said:",["Передача контекста принята."]]]});
assert.deepEqual(observed.acknowledgedRolloverMarkers,[marker]);assert.equal(observed.roleCounts.headings,2);
observed=await inspectDom({native:[user(""),assistant("")],headingTurns:[["You said:",[markerText]],["ChatGPT said:",["Acknowledged."]]]});
assert.deepEqual(observed.acknowledgedRolloverMarkers,[marker]);
observed=await inspectDom({headingTurns:[["You said:",[markerText]],["ChatGPT said:",[]]]});
assert.deepEqual(observed.acknowledgedRolloverMarkers,[]);
observed=await inspectDom({headingTurns:[["You said:",["Unrelated request"]],["ChatGPT said:",[markerText,"quoted only"]]]});
assert.deepEqual(observed.acknowledgedRolloverMarkers,[]);
observed=await inspectDom({headingTurns:[["You said:",[markerText]],["You said:",["Another request"]],["ChatGPT said:",["Not an ACK to handoff"]]]});
assert.deepEqual(observed.acknowledgedRolloverMarkers,[]);
observed=await inspectDom({native:[user(markerText),assistant(""),user("another request"),assistant("answer")]});
assert.deepEqual(observed.acknowledgedRolloverMarkers,[]);
observed=await inspectDom({native:[user("[ResearchTube task 10 "+marker+"]\nnext"),assistant("done")]});
assert.deepEqual(observed.taskMarkers,[marker]);
console.log("scheduled DOM recognition: native labels, role-heading fallback, empty/quoted response rejection: ok");

observed=await inspectDom({native:[user("[ResearchTube task 10 "+marker+"]\nnext"),assistant("partial response")],stop:true});
assert.equal(observed.generating,true);assert.equal(observed.ready,false);assert.equal(observed.explicitIdle,false);assert.deepEqual(observed.respondedTaskMarkers,[marker]);
observed=await inspectDom({native:[user("[ResearchTube task 10 "+marker+"]\nnext"),assistant("complete")],idle:true});
assert.equal(observed.generating,false);assert.equal(observed.ready,true);assert.equal(observed.explicitIdle,true);assert.deepEqual(observed.respondedTaskMarkers,[marker]);
observed=await inspectDom({native:[user("[ResearchTube task 10 "+marker+"]\nnext")],idle:true});
assert.deepEqual(observed.respondedTaskMarkers,[]);
console.log("plain Stop, explicit idle, exact task response, stable completion and successor routing: ok");

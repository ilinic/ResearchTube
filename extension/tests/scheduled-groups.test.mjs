import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source=await readFile(new URL("../background.js",import.meta.url),"utf8");
const from=source.indexOf("const SCHEDULER_INTERVAL_MS=3000;");
const to=source.indexOf("async function scheduledPending(",from);
assert.ok(from>=0&&to>from);
const groups=[{id:8,title:"Scheduled 4"},{id:9,title:"scheduled"}];
const storage={researchtubeScheduledGroupCounter:2};let nextTab=20;
const chrome={
 tabGroups:{query:async()=>groups,update:async(id,options)=>{groups.push({id,title:options.title});}},
 windows:{getAll:async()=>[{id:1,focused:false},{id:2,focused:true}]},
 tabs:{create:async options=>{assert.equal(options.windowId,2);return {id:nextTab++};},group:async({tabIds})=>tabIds[0]},
 storage:{local:{get:async defaults=>({...defaults,...storage}),set:async values=>Object.assign(storage,values)}}
};
const {isScheduledGroup,createScheduledGroup}=new Function("chrome","EXTERNAL_URLS","localAgentError",source.slice(from,to)+"\nreturn {isScheduledGroup,createScheduledGroup};")(chrome,{chatgptNewChat:"https://chatgpt.com/"},(code,message)=>Object.assign(Error(message),{code}));
for(const title of ["scheduled","Scheduled 1","Scheduled 24","scheduled 3"])assert.equal(isScheduledGroup(title),true);
for(const title of ["","Scheduled 0","Scheduled 01","Scheduled -1","Unscheduled 1","Scheduled 1 extra"])assert.equal(isScheduledGroup(title),false);
assert.equal((await createScheduledGroup()).name,"Scheduled 5");
groups.pop();
assert.equal((await createScheduledGroup()).name,"Scheduled 6");
assert.equal(storage.researchtubeScheduledGroupCounter,6);
assert.match(source,/scheduledActiveTabs\.has\(tab\.id\)/);
assert.match(source,/scheduledActiveTabs\.delete\(tab\.id\)/);
assert.match(source,/SCHEDULER_ALARM/);
assert.match(source,/__scheduled_tick"\) return \{status:"extensionOwned"\}/);
console.log("extension scheduled groups: ok");

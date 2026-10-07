import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {BROWSER_TOOL_NAMES} from '../browser-tools.js';
import {ARTIFACT_TOOLS,ARTIFACT_STATUS_TOOLS,ARTIFACT_CANCEL_TOOLS} from '../artifact-tasks.js';
import {WORKSPACE_ARGUMENT_NAMES,publicWorkspaceArguments} from '../artifact-tools.js';
import {assertSchema} from './fixtures/schema-check.mjs';
const bundle=await readFile(new URL('../dist/background.js',import.meta.url),'utf8');
function worker(storage={}) {
 let now=Date.now(),timerId=0;const timers=new Map(),alarms=new Map(),requests=[],uploads=[],reports=[];
 class Clock extends Date {static now(){return now;}}
 const event={addListener(){}};
 const tabs=new Map([[42,{id:42,url:'https://chatgpt.com/c/origin'}],[81,{id:81,url:'https://chatgpt.com/c/other',active:true}]]);
 const context=vm.createContext({URL,Intl,TextEncoder,TextDecoder,AbortController,crypto:webcrypto,Date:Clock,
  setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),console:{info(){}},
  chrome:{runtime:{id:'extension',getURL:p=>p,onInstalled:event,onStartup:event,onMessage:event},
    tabs:{query:async query=>{assert.deepEqual(JSON.parse(JSON.stringify(query)),{});return [...tabs.values()];},get:async id=>{if(!tabs.has(id))throw new Error('closed');return tabs.get(id);}},
    alarms:{onAlarm:event,create:async(name,value)=>alarms.set(name,value),clear:async name=>alarms.delete(name)},
    storage:{local:{get:async defaults=>Object.assign({},defaults,storage),set:async values=>Object.assign(storage,JSON.parse(JSON.stringify(values)))}}}
 });
 vm.runInContext(bundle,context);
 context.isMcpToolEnabled=async()=>true;context.refreshTaskHistorySettings=async()=>{};
 context.configuredToolLimits=async()=>({mediaToChatMaxFiles:5,mediaToChatMaxFileSizeMiB:20});
 context.setActionBadge=async()=>{};context.refreshActionBadge=async()=>{};context.recordCommandDiagnostic=async()=>{};
 context.reportMcpToolToAgent=async(tool,task)=>reports.push({tool,task});
 context.resolveLibraryStoreFiles=async files=>({localPaths:files.map(f=>'/private/'+f.workspacePath),submittedFiles:files,skippedFiles:[]});
 context.cdpAttachFilesNow=async(paths,options)=>{
  await context.requireCurrentChatTarget(options.currentChatTarget);options.checkCancelled();
  uploads.push({paths,tabId:options.currentChatTarget.tabId,policy:options.composerPolicy,deferSend:options.deferSend});
  if(options.deferSend)return {guardToken:'guard',fileNames:['crop.png']};options.onSendCommit();
 };
 context.agentJsonRequest=async(path,options)=>{
  requests.push({path,body:options?.body});
  if(path==='/media/image-crop')return {sourcePath:'source.png',sourceWidth:4,sourceHeight:4,crop:{x:0,y:0,width:2,height:2},image:{workspacePath:'crops/crop.png',format:'png',mimeType:'image/png',width:2,height:2,imageSizeBytes:50}};
  if(path==='/clipboard/get')return {type:'text',revision:'cb_1',text:'Clipboard content'};
  throw new Error('Unexpected route '+path);
 };
 const call=(name,args)=>context.handleMcpRequest({id:1,method:'tools/call',params:{name,arguments:args}});
 return {context,tabs,storage,requests,uploads,timers,alarms,reports,call,tick(ms=1000){now+=ms;}};
}
const w=worker(),definitions=w.context.publicMcpTools();
for(const name of BROWSER_TOOL_NAMES) {
 const tool=definitions.find(t=>t.name===name);assert.ok(tool,'generated bundle must expose '+name);
 assert.equal(tool.inputSchema.additionalProperties,false);assert.ok(tool.inputSchema.required.includes('sessionId'));
 assert.equal(w.context.toolSettingsMetadata(name).group,'browser');
}
const browserCalls=[];
w.context.browserAgent.execute=async(name,args)=>{browserCalls.push({name,args});return {mockBrowserResult:true};};
const browserRouted=await w.call('browser_session_status',{sessionId:'bas_abcdefghij'});
assert.equal(browserRouted.result.structuredContent.mockBrowserResult,true);assert.equal(browserCalls[0].name,'browser_session_status');
assert.equal((await w.call('browser_session_status',{sessionId:'bas_abcdefghij',tabId:81})).result.isError,false,'extra browser arguments are rejected before routing');
assert.equal(browserCalls.length,1);

for(const name of ARTIFACT_TOOLS){const tool=definitions.find(t=>t.name===name);
 assert.equal(tool.inputSchema.properties.addToChat.default,false);
 assert.equal(tool.inputSchema.properties.composerPolicy.default,'requireEmpty');assert.equal(tool.inputSchema.properties.sendDelaySeconds.default,0);
 assert.equal(tool.inputSchema.additionalProperties,false);assert.equal(tool.outputSchema.properties.statusTool.const,'media_task_status');
 assert.equal(tool.inputSchema.properties.showInChat,undefined,'presentation flag must not compete with uploading');
 assert.match(tool.description,/asynchronous/);assert.match(tool.description,/creation.data/);assert.match(tool.description,/addToChat/);
 assert.ok(!tool._meta['openai/outputTemplate'].includes('capture-frame'),'no artifact producer renders a media viewer');
}
for(const name of Object.keys({...ARTIFACT_STATUS_TOOLS,...ARTIFACT_CANCEL_TOOLS})) {
 const tool=definitions.find(t=>t.name===name);assert.ok(tool.outputSchema.properties.taskId || tool.outputSchema.properties.task);
}
for(const [name,names] of Object.entries(WORKSPACE_ARGUMENT_NAMES)) {
 const tool=definitions.find(t=>t.name===name);
 for(const [oldName,newName] of Object.entries(names)) {
  assert.equal(tool.inputSchema.properties[oldName],undefined,`${name} must not expose ${oldName}`);assert.ok(tool.inputSchema.properties[newName]);
  assert.throws(()=>publicWorkspaceArguments(name,{[oldName]:'example'},definitions),e=>e.code==='INVALID_ARGUMENT');
  assert.equal(publicWorkspaceArguments(name,{[newName]:'example'},definitions)[oldName],'example');
 }
}
// Real MCP dispatch: canonical names, immediate handle, default no sending,
// native metadata retained, common status/cancel and strict invalid inputs.
const args={workspacePath:'source.png',crop:{x:0,y:0,width:2,height:2},outputWorkspacePath:'crops/crop.png'};
const start=await w.call('media_image_crop',args),task=start.result.structuredContent;
assert.equal(start.result.isError,false);assert.equal(task.status,'queued');assert.equal(w.requests.length,0);
assert.equal(start.result._meta['researchtube/artifactTask'].addToChat,false);assert.equal(start.result._meta['researchtube/chatTarget'],undefined);
await w.context.artifactTaskManager.advance(task.taskId);
const completed=(await w.call('media_task_status',{taskId:task.taskId})).result.structuredContent;
assertSchema(definitions.find(t=>t.name==='media_image_crop').outputSchema,task,'crop start');
assertSchema(definitions.find(t=>t.name==='media_task_status').outputSchema,completed,'crop completed');
assert.equal(completed.status,'completed');assert.equal(completed.creation.data.image.workspacePath,'crops/crop.png');
assert.equal(w.requests[0].body.path,'source.png');assert.equal(w.requests[0].body.outputPath,'crops/crop.png');
assert.equal(w.requests[0].body.addToChat,undefined,'private Agent operation receives no chat flags');assert.equal(w.uploads.length,0);
for(const invalid of [{...args,path:'old.png'},{...args,addToChat:'yes'},{...args,sendDelaySeconds:-1},{...args,workspacePath:'../outside.png'}]){
 const response=await w.call('media_image_crop',invalid);assert.equal(response.result.isError,false);assert.equal(response.result.structuredContent.status,'rejected');
}
const speakers=await w.call('system_speech_speak',{text:'test',addToChat:true});assert.equal(speakers.result.isError,false);assert.equal(speakers.result.structuredContent.error.code,'SPEECH_INVALID');

// Launch binding survives long creation and focus switches; no upload occurs
// on binding alone while the child reservation is awaiting artifacts.
const send=worker();const created=await send.call('media_image_crop',{...args,addToChat:true,composerPolicy:'clear',sendDelaySeconds:60});
const sending=created.result.structuredContent,binding=created.result._meta['researchtube/chatTarget'];
assertSchema(definitions.find(t=>t.name==='media_image_crop').outputSchema,sending,'crop chat start');
assert.ok(binding.bindingToken);assert.ok(!JSON.stringify(sending).includes(binding.bindingToken));
await send.context.bindMediaToChatTarget(binding,{id:'extension',tab:send.tabs.get(42)});
await send.context.drainMediaToChatQueue();assert.equal(send.uploads.length,0);
await send.context.artifactTaskManager.advance(sending.taskId);
await send.context.drainMediaToChatQueue();send.tick();
let paused=(await send.call('media_task_status',{taskId:sending.taskId})).result.structuredContent;
assert.equal(paused.creation.status,'completed');assert.equal(paused.status,'working');assert.equal(paused.chat.phase,'waitingToSend');
assert.equal(paused.chat.sendDelaySeconds,60);assert.equal(paused.chat.remainingSeconds,59);
assertSchema(definitions.find(t=>t.name==='media_task_status').outputSchema,paused,'crop paused');
assert.equal(send.uploads[0].tabId,42);assert.equal(send.uploads[0].policy,'clear');assert.equal(send.uploads[0].deferSend,true);
const resumed=worker(JSON.parse(JSON.stringify(send.storage)));
await resumed.context.artifactTaskManager.ensure();
const recovered=(await resumed.call('media_task_status',{taskId:sending.taskId})).result.structuredContent;
assert.equal(recovered.status,'working');assert.equal(recovered.creation.status,'completed');assert.equal(recovered.chat.phase,'waitingToSend');
assert.equal(resumed.requests.length,0,'restoration never recreates an artifact');assert.equal(resumed.uploads.length,0,'restoration never reattaches a batch');
await resumed.call('media_task_cancel',{taskId:sending.taskId});
const stop=(await send.call('media_task_cancel',{taskId:sending.taskId})).result.structuredContent;
assert.equal(stop.cancelled,true);assert.equal(stop.task.status,'cancelled');assert.equal(stop.task.files.length,1);
assert.equal(stop.task.chat.status,'cancelled');assert.equal(stop.task.chat.remainingSeconds,null);
assertSchema(definitions.find(t=>t.name==='media_task_cancel').outputSchema,stop,'crop cancelled');
assert.equal(send.uploads.length,1,'cancellation never reloads files or chooses another tab');
assert.ok(send.reports.some(r=>r.tool==='media_image_crop' && r.task.progressPercent>=70));

// Same error for a vanished destination; successful artifacts remain intact.
const gone=worker();const gs=await gone.call('media_image_crop',{...args,addToChat:true});const gb=gs.result._meta['researchtube/chatTarget'];
await gone.context.bindMediaToChatTarget(gb,{id:'extension',tab:gone.tabs.get(42)});gone.tabs.delete(42);
await gone.context.artifactTaskManager.advance(gs.result.structuredContent.taskId);await gone.context.drainMediaToChatQueue();gone.tick();
const missing=(await gone.call('media_task_status',{taskId:gs.result.structuredContent.taskId})).result.structuredContent;
assert.equal(missing.status,'failed');assert.equal(missing.creation.status,'completed');assert.equal(missing.files.length,1);assert.equal(gone.uploads.length,0);
assertSchema(definitions.find(t=>t.name==='media_task_status').outputSchema,missing,'crop missing tab');

// All-file count limit is applied after creation, before uploading any subset.
const count=worker();const held=(await count.context.mediaToChatStart({},{awaitingArtifacts:true})).task;
await assert.rejects(count.context.releaseArtifactChat(held.taskId,Array.from({length:6},(_,i)=>({workspacePath:`crops/${i}.png`}))),e=>e.code==='MEDIA_TO_CHAT_INVALID' && /5/.test(e.message));
assert.equal(count.uploads.length,0);await count.context.mediaToChatCancel(held.taskId);

// Optional actual-FFmpeg documents from the smoke run, fed through the shipped
// normalizers and full supervisor; browser delivery remains independently tested.
if(process.env.RESEARCHTUBE_LIVE_RESULTS) {
 const live=JSON.parse(await readFile(process.env.RESEARCHTUBE_LIVE_RESULTS,'utf8'));
 const cases=[['media_capture_frame',{workspacePath:'source.mp4',timestampsSeconds:[2,8],image:{format:'png'}},live.frames],
  ['media_image_crop',{workspacePath:live.frames.frames[0].image.workspacePath,crop:{x:10,y:10,width:64,height:48},outputWorkspacePath:'crops/live.png'},live.crop],
  ['media_clip',{workspacePath:'source.mp4',outputKind:'audio',cutMode:'copy'},live.clips]];
 for(const [name,input,native] of cases){const f=worker();f.context.agentJsonRequest=async()=>native;
  const response=await f.call(name,input);const id=response.result.structuredContent.taskId;
  await f.context.artifactTaskManager.advance(id);const final=(await f.call('media_task_status',{taskId:id})).result.structuredContent;
  assert.equal(final.status,'completed',JSON.stringify(final.error));assert.ok(final.files.length);
  assertSchema(definitions.find(t=>t.name===name).outputSchema,final,name+' real FFmpeg');
 }
}
console.log('Shipped MCP artifact contracts: 12 producers, canonical paths, async crop, current-tab binding, delay/cancel, missing tab and batch limits verified.');

// Exercise the generated toolbar implementation: no global badge writes, and
// recording remains the stronger indicator on a Browser Agent tab.
const badgeCalls=[];
w.context.chrome.action={setBadgeBackgroundColor:async v=>badgeCalls.push(['color',v]),setBadgeText:async v=>badgeCalls.push(['text',v]),setBadgeTextColor:async v=>badgeCalls.push(['textColor',v]),setTitle:async v=>badgeCalls.push(['title',v])};
w.context.browserAutomationBadges.set(42,{state:'running',statusMessage:'Studying this page'});
await w.context.paintBrowserAutomationBadge(42);
assert.ok(badgeCalls.every(([,v])=>v.tabId===42));assert.equal(badgeCalls.find(([k])=>k==='text')[1].text,'AUTO');assert.equal(badgeCalls.find(([k])=>k==='color')[1].color,'#0057ff');
badgeCalls.length=0;w.context.cameraRecordingBadgeKind='audio';w.context.cameraRecordingBadgeVisible=true;
await w.context.paintBrowserAutomationBadge(42);assert.equal(badgeCalls.find(([k])=>k==='text')[1].text,'MIC');
badgeCalls.length=0;w.context.cameraRecordingBadgeKind=null;w.context.browserAutomationBadges.delete(42);
await w.context.paintBrowserAutomationBadge(42);assert.equal(badgeCalls.find(([k])=>k==='text')[1].text,null,'Stop restores the global toolbar badge');
console.log('Browser toolbar: tab-specific AUTO, recording priority and Stop reset: ok');

// The grouping config is optional for old/offline Agents; invalid values fail.
for(const value of [true,false]) {
 w.context.agentJsonRequest=async()=>({browserStudyGroupTabs:value});
 assert.deepEqual(JSON.parse(JSON.stringify(await w.context.configuredBrowserStudyOptions())), { groupTabs: value, detailedLogging: true, observation: { maxNodes: 200, maxChars: 48000 } });
}
w.context.agentJsonRequest=async()=>({});assert.deepEqual(JSON.parse(JSON.stringify(await w.context.configuredBrowserStudyOptions())), { groupTabs: true, detailedLogging: true, observation: { maxNodes: 200, maxChars: 48000 } });
w.context.agentJsonRequest=async()=>{throw Object.assign(Error('offline'),{code:'AGENT_UNAVAILABLE'});};
assert.deepEqual(JSON.parse(JSON.stringify(await w.context.configuredBrowserStudyOptions())), { groupTabs: true, detailedLogging: true, observation: { maxNodes: 200, maxChars: 48000 } });
for(const value of [null,1,'false']) {
 w.context.agentJsonRequest=async()=>({browserStudyGroupTabs:value});
 await assert.rejects(w.context.configuredBrowserStudyOptions(),e=>e.code==='AGENT_INVALID_RESPONSE');
}
console.log('Browser grouping setting: live boolean, default and offline compatibility: ok');

for (const detailedLogging of [true, false]) {
 w.context.agentJsonRequest=async()=>({browserStudyGroupTabs:false,browserStudyDetailedLogging:detailedLogging});
 assert.deepEqual(JSON.parse(JSON.stringify(await w.context.configuredBrowserStudyOptions())),{groupTabs:false,detailedLogging,observation:{maxNodes:200,maxChars:48000}});
}
for (const value of [null, 1, "false"]) {
 w.context.agentJsonRequest=async()=>({browserStudyDetailedLogging:value});
 await assert.rejects(w.context.configuredBrowserStudyOptions(),e=>e.code==='AGENT_INVALID_RESPONSE');
}
console.log('Browser detailed logging setting: live boolean, strict validation and compatibility: ok');

// Test the shipped worker's actual console boundary, not a mock formatter.
// A DevTools-style text export must retain measurements without expanding objects.
const consoleCalls=[];
w.context.console.info=(...args)=>consoleCalls.push(args);
w.context.browserDiagnosticLog('timing',{sessionId:'bas_abcdefghij',stage:'page.axRefresh',event:'end',elapsedMs:123.4,sinceLaunchMs:500});
assert.equal(consoleCalls.length,1);
assert.equal(consoleCalls[0].length,1,'a complete record is passed as a single string');
const exported=consoleCalls[0].map(String).join(' ');
assert.match(exported, /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[ResearchTube Browser\] timing \{/);
assert.doesNotMatch(exported,/\[object Object\]|timing Object|\n/);
const record=JSON.parse(exported.slice(exported.indexOf('{')));
assert.equal(record.elapsedMs,123.4);assert.equal(record.sinceLaunchMs,500);
assert.equal(record.stage,'page.axRefresh');assert.equal(record.sessionId,'bas_abcdefghij');
assert.match(record.extensionVersion,/^2\.2\.\d+$/);
assert.ok(Number.isFinite(Date.parse(record.atUtc)));
const sample=w.context.createBrowserDiagnostics({enabled:true,sessionId:'bas_abcdefghij',log:w.context.browserDiagnosticLog,now:()=>10});
sample.event('export.test',{bytes:8,url:'https://PRIVATE.test/?signature=SECRET',rawResponse:'SECRET'});
assert.doesNotMatch(consoleCalls.at(-1)[0],/PRIVATE|SECRET|signature|rawResponse/);
const diagnosticLogCount=consoleCalls.length;
w.context.createBrowserDiagnostics({enabled:false,log:w.context.browserDiagnosticLog}).event('off');
assert.equal(consoleCalls.length,diagnosticLogCount);
console.log('Browser console export: single-line JSON retains exact timing, UTC/version and privacy filtering: ok');

// All ordinary worker action logs use the same visible timestamp/text boundary.
w.context.cdpLog('retry test', { attempt: 3, intervalSeconds: 2 });
assert.equal(consoleCalls.at(-1).length, 1);
assert.match(consoleCalls.at(-1)[0], /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[ResearchTube CDP\] retry test \{"attempt":3,"intervalSeconds":2\}$/);

for (const retryCount of [1, 15, 300]) {
 w.context.agentJsonRequest = async () => ({ composerMediaRetry: { retryCount, retryIntervalSeconds: 2 } });
 assert.deepEqual(JSON.parse(JSON.stringify(await w.context.configuredComposerMediaRetry())), { retryCount, retryIntervalSeconds: 2 });
}
for (const value of [null, {}, { retryCount: true, retryIntervalSeconds: 2 }, { retryCount: 301, retryIntervalSeconds: 2 }, { retryCount: 15, retryIntervalSeconds: 0 }, { retryCount: 15, retryIntervalSeconds: 61 }, { retryCount: 15, retryIntervalSeconds: 2, extra: 1 }]) {
 w.context.agentJsonRequest = async () => ({ composerMediaRetry: value });
 await assert.rejects(w.context.configuredComposerMediaRetry(), error => error.code === 'AGENT_INVALID_RESPONSE');
}
w.context.agentJsonRequest = async () => ({});
assert.deepEqual(JSON.parse(JSON.stringify(await w.context.configuredComposerMediaRetry())), { retryCount: 15, retryIntervalSeconds: 2 });
w.context.agentJsonRequest = async () => { throw Object.assign(Error('offline'), { code: 'AGENT_UNAVAILABLE' }); };
assert.deepEqual(JSON.parse(JSON.stringify(await w.context.configuredComposerMediaRetry())), { retryCount: 15, retryIntervalSeconds: 2 });
w.context.agentJsonRequest = async () => { throw Object.assign(Error('config'), { code: 'CONFIG_INVALID' }); };
await assert.rejects(w.context.configuredComposerMediaRetry(), error => error.code === 'CONFIG_INVALID');
console.log('Composer retry policy: live settings, strict validation, old/offline fallback and visible action timestamps: ok');

// The generated worker consumes optional observation limits, with strict numeric
// validation and backward-compatible defaults on old/offline Agents.
w.context.agentJsonRequest=async()=>({browserStudyObservation:{maxNodes:7,maxChars:1700}});
assert.deepEqual(JSON.parse(JSON.stringify((await w.context.configuredBrowserStudyOptions()).observation)),{maxNodes:7,maxChars:1700});
for(const value of [null,[],{maxNodes:true},{maxChars:999},{maxNodes:1001}]) {
 w.context.agentJsonRequest=async()=>({browserStudyObservation:value});
 await assert.rejects(w.context.configuredBrowserStudyOptions(),e=>e.code==='AGENT_INVALID_RESPONSE');
}
console.log('Browser observation setting: shipped worker reads strict optional node/character ceilings: ok');

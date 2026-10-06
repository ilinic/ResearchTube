// Execute the shipped service-worker bundle and its real tools/list path.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const bundle = await readFile(new URL('../dist/background.js', import.meta.url), 'utf8');
const timers = ['timer_start', 'timer_status', 'timer_cancel'];
const limits = {
 mediaCaptureFrameMaxFrames:20, mediaClipMaxSegments:20,
 cameraRecordAudioMaxMinutes:10,cameraRecordVideoMaxMinutes:1,
 libraryStoreMaxFiles:5,libraryStoreMaxFileSizeMiB:100,
 mediaToChatMaxFiles:5,mediaToChatMaxFileSizeMiB:100,completedTaskHistoryLimit:2000
};
function worker({enabledByName={},defaultEnabled=true,agentError=null}={}) {
 const storage={mcpToolPreferences:{enabledByName}};
 const messages=[];
 const event={addListener(){}};
 const context=vm.createContext({
  chrome:{runtime:{onInstalled:event,onStartup:event,onMessage:event},alarms:{onAlarm:event},
   storage:{local:{get:async()=>storage,set:async values=>Object.assign(storage,values)}}},
  console:{info:(message)=>messages.push(message),warn:(message)=>messages.push(message)},
  URL, Intl, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout
 });
 vm.runInContext(bundle,context);
 context.agentJsonRequest=async()=>{
  if(agentError) throw Object.assign(new Error('Not available'),{code:agentError});
  return {limits,newToolsEnabledByDefault:defaultEnabled};
 };
 return {context,storage,messages,list:()=>context.handleMcpRequest({jsonrpc:'2.0',id:17,method:'tools/list'})};
}
const clean=worker();
const listed=await clean.list();
assert.equal(listed.jsonrpc,'2.0');assert.equal(listed.id,17);
const names=Array.from(listed.result.tools,tool=>tool.name);
assert.equal(new Set(names).size,names.length,'public MCP tool names must be unique');
for(const name of timers) {
 assert.ok(names.includes(name),`${name} must appear in actual MCP tools/list`);
 const tool=listed.result.tools.find(tool=>tool.name===name);
 assert.equal(tool.inputSchema.type,'object');
 assert.ok(tool.outputSchema.anyOf);
}
const catalog=await clean.context.mcpToolSettingsCatalog();
for(const name of timers) assert.ok(catalog.some(tool=>tool.name===name && tool.group==='timers' && tool.enabled));
assert.ok(clean.messages.some(message=>message.includes('timers=timer_start,timer_status,timer_cancel')));
assert.ok(!names.includes('media_load_workspace_image'),'private widget actions must stay private');
for(const code of ['AGENT_UNAVAILABLE','AGENT_INTERFACE_MISMATCH','CONFIG_INVALID','AGENT_INVALID_RESPONSE']) {
 const offline=worker({agentError:code});
 const result=await offline.list();
 for(const name of timers) assert.ok(result.result.tools.some(tool=>tool.name===name),`schema discovery must survive ${code}`);
}
const disabled=worker({enabledByName:{timer_start:false}});
const filtered=await disabled.list();
assert.ok(!filtered.result.tools.some(tool=>tool.name==='timer_start'),'saved disabled choice must remain authoritative');
assert.ok(filtered.result.tools.some(tool=>tool.name==='timer_status'));
assert.ok(disabled.messages.some(message=>message.includes('disabledTimers=timer_start')));
const developer=worker({defaultEnabled:false});
const defaults=await developer.list();
assert.ok(!defaults.result.tools.some(tool=>timers.includes(tool.name)));
assert.ok(defaults.result.tools.some(tool=>tool.name==='system_agent_status'));
// Settings can explicitly enable a timer even if developer default is false.
assert.equal((await developer.context.updateMcpToolEnabled('timer_start',true)).ok,true);
assert.ok((await developer.list()).result.tools.some(tool=>tool.name==='timer_start'));
console.log(`shipped MCP tools/list: ${names.length} public tools; all three timers present; filters/offline discovery verified`);

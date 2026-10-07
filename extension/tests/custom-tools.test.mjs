import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'agent', 'custom-tools', 'custom-toolset', 'manifest.json'), 'utf8'));

assert.equal(manifest.groupTitle, 'Custom Toolset');
assert.deepEqual(manifest.tools.map(tool => tool.name), ['count_words', 'wait_seconds']);
assert.equal(manifest.tools[0].execution, 'sync');
assert.equal(manifest.tools[1].execution, 'task');
assert.match(background, /refreshCustomToolDefinitions/);
assert.match(background, /name: "custom_tool_status"/);
assert.match(background, /name: "custom_tool_cancel"/);
assert.match(background, /customToolByName\(name\)/);
console.log('Custom Tools: manifest package, sync/async examples and MCP lifecycle wiring passed');

// Exercise the shipped worker: manifest packages must follow the universal
// task commands, regardless of tool names and duplicated group titles.
const event={addListener(){}};
const worker=vm.createContext({URL,Intl,TextEncoder,TextDecoder,AbortController,crypto:webcrypto,setTimeout,clearTimeout,
  console:{info(){},warn(){},error(){}},
  chrome:{runtime:{id:'extension',getURL:p=>p,onInstalled:event,onStartup:event,onMessage:event},alarms:{onAlarm:event},
    storage:{local:{get:async()=>({}),set:async()=>{}}}}});
vm.runInContext(fs.readFileSync(path.join(root,'extension/dist/background.js'),'utf8'),worker);
const packageTool=(name,packageId,groupTitle,execution='sync')=>({name,title:name,description:'Example.',inputSchema:{type:'object'},
  _meta:{'researchtube/customTool':{packageId,groupTitle,execution}}});
const packages=[packageTool('aaa_zulu','zulu','Zulu Tools'),packageTool('zzz_alpha','alpha','Alpha Tools'),
  packageTool('aaa_same_one','same-one','Same title'),packageTool('aaa_same_two','same-two','Same title'),
  ...manifest.tools.map(t=>({...t,_meta:{'researchtube/customTool':{packageId:manifest.id,groupTitle:manifest.groupTitle,execution:t.execution}}}))];
worker.customFixtures=packages;
vm.runInContext('CUSTOM_MCP_TOOLS=customFixtures.map(customToolDefinition)',worker);
worker.mcpToolPreferences=async()=>({enabledByName:Object.fromEntries(packages.map(t=>[t.name,t.name!=='count_words']))});
const catalog=await worker.mcpToolSettingsCatalog();
const groupIds=[...new Set(catalog.map(t=>t.group))];
assert.deepEqual(groupIds.slice(-6),['custom','custom:alpha',`custom:${manifest.id}`,'custom:same-one','custom:same-two','custom:zulu']);
const lifecycle=catalog.filter(t=>t.group==='custom');
assert.deepEqual(Array.from(lifecycle,t=>t.name),['custom_tool_cancel','custom_tool_status']);
assert.ok(lifecycle.every(t=>t.groupTitle==='Custom Asynchronous Tasks'));
assert.equal(catalog.find(t=>t.name==='count_words').enabled,false,'saved per-tool preferences survive group reordering');
assert.equal(catalog.find(t=>t.name==='system_agent_status').alwaysEnabled,true);
for(const name of ['custom_tool_status','custom_tool_cancel','wait_seconds']) {
  const definition=worker.publicMcpTools().find(t=>t.name===name);
  const pattern=definition.outputSchema.properties.taskId.pattern;
  assert.ok(new RegExp(pattern).test('tsk_abcdefghij'));
  assert.ok(!new RegExp(pattern).test('ct_abcdefghijk'));
  if(name!=='wait_seconds')assert.equal(definition.inputSchema.properties.taskId.pattern,pattern);
}
const task={taskId:'tsk_abcdefghij',tool:'wait_seconds',status:'working',phase:'running',progressPercent:25,
  statusMessage:'Waiting.',createdAt:'2026-10-08T00:00:00Z',lastUpdatedAt:'2026-10-08T00:00:00Z',pollIntervalMs:1000,result:null,error:null};
const requests=[];
worker.agentJsonRequest=async(route,options={})=>{
  requests.push({route,options});
  if(route==='/custom-tools/call')return {kind:'task',task};
  return {...task,...(route.endsWith('/cancel')?{status:'cancelled',phase:'cancelled'}:{})};
};
assert.equal((await worker.customToolCall('wait_seconds',{seconds:1})).taskId,task.taskId);
assert.equal((await worker.customToolStatus(task.taskId)).taskId,task.taskId);
assert.equal((await worker.customToolCancel(task.taskId)).status,'cancelled');
assert.deepEqual(requests.map(r=>r.route),['/custom-tools/call',`/custom-tools/tasks/${task.taskId}`,`/custom-tools/tasks/${task.taskId}/cancel`]);
for(const id of ['ct_abcdefghijk','tsk_short','tsk_abcdefghijk']) {
  await assert.rejects(worker.customToolStatus(id),e=>e.code==='INVALID_ARGUMENT');
  await assert.rejects(worker.customToolCancel(id),e=>e.code==='INVALID_ARGUMENT');
}
assert.equal(requests.length,3,'invalid IDs are rejected before HTTP requests');
worker.agentJsonRequest=async()=>({kind:'task',task:{...task,taskId:'ct_abcdefghijk'}});
await assert.rejects(worker.customToolCall('wait_seconds',{}),e=>e.code==='AGENT_INVALID_RESPONSE');

// Render the actual Settings group loop with minimal DOM nodes, including
// independent packages sharing a title and a saved checkbox value.
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.textContent='';}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];}
  addEventListener(type,fn){this.listeners[type]=fn;}
}
const container=new Element('div'),note=new Element('div');
const settings=fs.readFileSync(path.join(root,'extension/settings.js'),'utf8');
const settingsContext=vm.createContext({document:{createElement:tag=>new Element(tag)},$:id=>id==='mcp-tools'?container:note});
vm.runInContext(settings.slice(settings.indexOf('function toolGroupTitle('),settings.indexOf('async function loadMcpToolSettings(')),settingsContext);
settingsContext.renderMcpTools({ok:true,tools:catalog,groups:vm.runInContext('MCP_TOOL_GROUPS',worker)});
assert.deepEqual(container.children.slice(-6).map(section=>section.children[0].textContent),
  ['Custom Asynchronous Tasks','Alpha Tools',manifest.groupTitle,'Same title','Same title','Zulu Tools']);
const exampleGroup=container.children.find(section=>section.children[0].textContent===manifest.groupTitle);
assert.equal(exampleGroup.children[1].children[0].checked,false);
assert.deepEqual(exampleGroup.children.slice(1).map(row=>row.children[1].children[0].children[1].textContent),['count_words','wait_seconds']);
console.log('Custom task IDs: standard start/status/cancel/HTTP validation; Settings lifecycle then manifest groups with preserved preferences: ok');

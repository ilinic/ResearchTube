import assert from 'node:assert/strict';
import { LEGACY_SITE_TOOL_NAMES } from '../browser-tools.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { TIMER_TOOL_NAMES, timerDefinitions, validateTimerInput, normalizeTimerResult, timerTaskSchema } from '../timers.js';
import { pruneCompletedTasks } from '../task-history.js';

assert.deepEqual(TIMER_TOOL_NAMES, ['timer_start', 'timer_status', 'timer_cancel']);
const definitions = timerDefinitions({ readOnlyHint: true }, { readOnlyHint: false });
assert.equal(definitions.length, 3);
assert.match(definitions[0].description, /no precise internal running clock/);
assert.match(definitions[0].description, /same assistant turn/);
assert.equal(definitions[0].inputSchema.additionalProperties, false);
assert.deepEqual(validateTimerInput('timer_start', { duration: 2 }), { duration: 2 });
assert.deepEqual(validateTimerInput('timer_start', { duration: .5, unit: 'hours', clockSource: 'internet', timeZone: 'Pacific/Auckland' }), { duration: .5, unit: 'hours', clockSource: 'internet', timeZone: 'Pacific/Auckland' });
assert.equal(validateTimerInput('timer_start', { until: '2026-10-06T13:00:00+13:00' }).until, '2026-10-06T13:00:00+13:00');
for (const input of [{}, {duration:1, until:'x'}, {duration:true}, {duration:-1}, {duration:Infinity}, {duration:NaN}, {duration:1, unit:'days'}, {until:'13:00'}, {until:'2026-10-06T13:00:00Z', unit:'seconds'}, {duration:1, clockSource:null}, {duration:1, timeZone:'bogus'}, {duration:1, localTimeZone:'UTC'}, {duration:1, other:true}]) {
  assert.throws(() => validateTimerInput('timer_start', input), e => e.code === 'TIMER_INVALID');
}
assert.throws(() => validateTimerInput('timer_status', {taskId:'tsk_abcdefghij', extra:true}), e => e.code === 'TIMER_INVALID');
assert.throws(() => validateTimerInput('timer_cancel', {taskId:42}), e => e.code === 'TIMER_INVALID');

const task = {
 taskId:'tsk_abcdefghij', status:'working', phase:'waiting', mode:'duration', clockSource:'system', timeZone:'Pacific/Auckland',
 createdAtUtc:'2026-10-06T00:00:00.000Z', startedAtUtc:'2026-10-06T00:00:00.000Z', currentUtc:'2026-10-06T00:00:05.000Z', targetUtc:'2026-10-06T00:00:10.000Z',
 startedAtLocal:'2026-10-06T13:00:00.000+13:00', currentLocal:'2026-10-06T13:00:05.000+13:00', targetLocal:'2026-10-06T13:00:10.000+13:00',
 currentUtcOffsetSeconds:46800, targetUtcOffsetSeconds:46800, durationSeconds:10, elapsedSeconds:5, remainingSeconds:5, progressPercent:50,
 pollIntervalMs:250, completedAtUtc:null, latenessSeconds:null, sleepDetection:'systemCounters', warnings:[], warningCount:0, error:null, clockSync:null
};
assert.deepEqual(Object.keys(task).sort(), timerTaskSchema.required.slice().sort());
assert.deepEqual(normalizeTimerResult('timer_status', {...task, hostPath:'secret'}), task);
for (const bad of [{...task, progressPercent:101}, {...task, status:'completed'}, {...task, taskId:'other'}, {...task, error:{code:'PRIVATE_ERROR',message:'secret'}}, {...task, elapsedSeconds:NaN}, {...task, currentUtc:'invalid'}, {...task, currentUtcOffsetSeconds:.1}, {...task, warnings:new Array(21).fill({})}]) {
 assert.throws(() => normalizeTimerResult('timer_status', bad), e => e.code === 'AGENT_INVALID_RESPONSE');
}
const completed = {...task, status:'completed', phase:'completed', progressPercent:100, remainingSeconds:0, completedAtUtc:'2026-10-06T00:00:10.000Z', latenessSeconds:0};
assert.deepEqual(normalizeTimerResult('timer_cancel', {task:completed, cancelled:false, internal:'secret'}), {task:completed,cancelled:false});

const history = new Map();
for(let i=0;i<2100;i++) history.set(`done${i}`, {taskId:`done${i}`,status:'completed',updatedAt:new Date(1700000000000+i).toISOString()});
history.set('active', {taskId:'active',status:'working'}); history.set('queued',{taskId:'queued',status:'queued'});
pruneCompletedTasks(history,2000);
assert.equal(history.size,2002); assert.ok(history.has('active') && history.has('queued'));
assert.ok(!history.has('done0') && history.has('done100'));
pruneCompletedTasks(history,2); assert.equal(history.size,4);

const source = await readFile(new URL('../background.js', import.meta.url),'utf8');
const first=source.indexOf('  if (request?.method === "tools/call" && TIMER_TOOL_NAMES.includes');
const last=source.indexOf('  if (request?.method === "tools/call" && request.params?.name === "system_agent_status")', first);
assert.ok(first>=0 && last>first);
const calls=[];
const route = vm.runInNewContext(`(async function(request){${source.slice(first,last)}})`, {
 TIMER_TOOL_NAMES,validateTimerInput,normalizeTimerResult,Intl, AGENT_TASK_TIMEOUT_MS:10000,
 localAgentError:(code,message)=>Object.assign(new Error(message),{code}),
 executeToolCall:async (id,name,input,work)=>work(),
 agentJsonRequest:async (path,options)=> {calls.push({path,options}); return path.endsWith('/cancel')?{task:completed,cancelled:false}:task;}
});
await route({method:'tools/call',params:{name:'timer_start',arguments:{duration:10}}});
assert.equal(calls[0].path,'/timer/start'); assert.ok(calls[0].options.body.localTimeZone);
await route({method:'tools/call',params:{name:'timer_status',arguments:{taskId:task.taskId}}});
assert.equal(calls[1].path,`/tasks/timer/${task.taskId}`);
await route({method:'tools/call',params:{name:'timer_cancel',arguments:{taskId:task.taskId}}});
assert.equal(calls[2].options.method,'POST'); assert.equal(calls[2].path,`/tasks/timer/${task.taskId}/cancel`);

// A developer default changes only initial choices, never a user's saved choice.
const prefFirst=source.indexOf('function normalizeMcpToolPreferences(');
const prefLast=source.indexOf('\nasync function mcpToolSettingsCatalog',prefFirst);
const storage={mcpToolPreferences:{newToolsEnabledByDefault:false,enabledByName:{existing:true}}};
let developerDefault=false;
const ctx=vm.createContext({
 LEGACY_SITE_TOOL_NAMES,
 chrome:{storage:{local:{get:async()=>storage,set:async v=>Object.assign(storage,v)}}},
 DEFAULT_MCP_TOOL_PREFERENCES:{enabledByName:{}}, developerNewToolsDefault:false,
 publicMcpTools:()=>[{name:'existing'},{name:'new_custom'},{name:'new_builtin'}],
 toolSettingsMetadata:(name)=>({alwaysEnabled:false,group:name==='new_custom'?'custom':'media'}),
 refreshTaskHistorySettings:async()=>{ctx.developerNewToolsDefault=developerDefault;}
});
vm.runInContext(source.slice(prefFirst,prefLast),ctx);
let prefs=await ctx.mcpToolPreferences();
assert.equal(prefs.enabledByName.new_builtin,true);assert.equal(prefs.enabledByName.existing,true);assert.equal(prefs.enabledByName.new_custom,false);
assert.ok(!Object.hasOwn(storage.mcpToolPreferences,'newToolsEnabledByDefault'));
developerDefault=true; prefs=await ctx.mcpToolPreferences(); assert.equal(prefs.enabledByName.new_custom,false);
console.log('timers, task retention, routes and developer defaults: ok');

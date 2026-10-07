import assert from 'node:assert/strict';
import {createArtifactTaskManager,ARTIFACT_TOOLS} from '../artifact-tasks.js';
import {pruneCompletedTasks} from '../task-history.js';
const options={addToChat:false,composerPolicy:'requireEmpty',sendDelaySeconds:0};
const terminal=status=>['completed','failed','cancelled'].includes(status);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture({asyncCreation=false,startGate=null,startStatus='working',files=['out/b.png','out/a.png'],chatFailure=null,chatGate=false}={}) {
  let time=1000,ids=0,records=[],starts=0,polls=0,nativeCancels=0,reservations=0,released=[],chatCancels=0,committed=false;
  let nativeStatus=startStatus,chatStatus='queued';const scheduled=new Map(),reports=[];
  const producer={start:async input=>{starts++;if(startGate)await startGate.promise;return asyncCreation?{taskId:'native-id',status:nativeStatus,phase:'processing',progressPercent:20,pollIntervalMs:1500,files:[]}:{image:{workspacePath:files[0]},files};},
    files:data=>data.files??[]};
  if(asyncCreation){producer.status=async()=>{polls++;return {taskId:'native-id',status:nativeStatus,phase:nativeStatus,progressPercent:nativeStatus==='completed'?100:30,pollIntervalMs:1500,files};};
    producer.cancel=async()=>{nativeCancels++;nativeStatus='cancelled';};}
  const host={now:()=>time,id:()=>`tsk_${String(++ids).padStart(10,'0')}`,path:p=>{if(p.startsWith('/')||p.includes('..'))throw new Error('bad path');return p;},
    producers:Object.fromEntries(ARTIFACT_TOOLS.map(name=>[name,producer])),
    prune:tasks=>pruneCompletedTasks(tasks,2),load:async()=>structuredClone(records),save:async value=>{records=structuredClone(value);},errorMessage:e=>e.message,
    report:task=>reports.push(structuredClone(task)),schedule:async(id,ms)=>scheduled.set(id,ms),unschedule:async id=>scheduled.delete(id),
    reserveChat:async()=>{reservations++;return 'child';},chatMetadata:()=>({taskId:'child',bindingToken:'capability'}),
    releaseChat:async(id,paths)=>{assert.equal(id,'child');released.push(paths);if(chatFailure)throw Object.assign(new Error(chatFailure),{code:'MEDIA_TO_CHAT_INVALID'});chatStatus='working';},
    chatStatus:async()=>({taskId:'child',status:chatStatus,phase:chatStatus==='working'?'waitingToSend':chatStatus,
      progressPercent:chatStatus==='completed'?100:70,message:'chat',error:null,sendNotBefore:'1970-01-01T00:01:01.000Z',remainingSeconds:60}),
    cancelChat:async()=>{chatCancels++;if(committed)return {cancelled:false};chatStatus='cancelled';return {cancelled:true};}};
  const manager=createArtifactTaskManager(host);
  return {manager,host,reports,scheduled,get records(){return records;},get starts(){return starts;},get polls(){return polls;},get nativeCancels(){return nativeCancels;},
    get reservations(){return reservations;},get released(){return released;},get chatCancels(){return chatCancels;},
    tick(ms=1500){time+=ms;},completeCreation(){nativeStatus='completed';},completeChat(){committed=true;chatStatus='completed';},
    restart(){return createArtifactTaskManager(host);}};
}

// Every creation command has the same immediate handle and default no-upload.
for(const tool of ARTIFACT_TOOLS){const f=fixture();const task=await f.manager.start(tool,{},options);
  assert.match(task.taskId,/^tsk_[A-Za-z0-9_-]{10}$/);assert.equal(task.status,'queued');assert.equal(f.starts,0);
  await f.manager.advance(task.taskId);const done=await f.manager.status(task.taskId);
  assert.equal(done.status,'completed');assert.equal(done.progressPercent,100);assert.equal(done.chat,null);assert.equal(f.reservations,0);
  assert.deepEqual(done.files,[{workspacePath:'out/b.png'},{workspacePath:'out/a.png'}]);}

// Bind capability exists at launch, before creation; creation is not repeated.
const f=fixture({asyncCreation:true});const t=await f.manager.start('media_clip',{workspacePath:'source.mp4'},{...options,addToChat:true,sendDelaySeconds:600});
assert.equal(f.reservations,1);assert.equal(f.starts,0);assert.deepEqual(await f.manager.metadata(t.taskId),{taskId:'child',bindingToken:'capability'});
await f.manager.advance(t.taskId);assert.equal(f.starts,1);assert.equal(f.released.length,0);
await f.manager.status(t.taskId);assert.equal(f.polls,0,'pollIntervalMs applies to autonomous and model polls');
f.completeCreation();f.tick();await f.manager.advance(t.taskId);
const paused=await f.manager.status(t.taskId);assert.equal(paused.creation.status,'completed');assert.equal(paused.status,'working');
assert.equal(paused.phase,'waitingToSend');assert.equal(paused.chat.remainingSeconds,60);
assert.deepEqual(f.released[0],[{workspacePath:'out/b.png'},{workspacePath:'out/a.png'}]);
const cancelled=await f.manager.cancel(t.taskId);assert.equal(cancelled.cancelled,true);assert.equal(cancelled.task.status,'cancelled');
assert.equal(cancelled.task.files.length,2);assert.equal(f.nativeCancels,0,'do not cancel already completed creation');
assert.equal(cancelled.task.chat.status,'cancelled');
assert.equal(f.starts,1);assert.equal(f.scheduled.size,0);

// Producer cancellation preserves only its actual published files.
const c=fixture({asyncCreation:true});const ct=await c.manager.start('media_clip',{},options);await c.manager.advance(ct.taskId);
const cc=await c.manager.cancel(ct.taskId);assert.equal(cc.cancelled,true);assert.equal(c.nativeCancels,1);
assert.ok(cc.task.status==='working'||cc.task.status==='cancelled');c.tick();await c.manager.advance(ct.taskId);
assert.equal((await c.manager.status(ct.taskId)).status,'cancelled');assert.equal((await c.manager.status(ct.taskId)).files.length,2);

// A synchronous Agent operation cannot be killed/replayed: settle then keep
// its output, suppress delivery. Cancellation during the start await works too.
for(const asyncCreation of [false,true]) {
  const gate=deferred(),race=fixture({startGate:gate,asyncCreation});
  const rt=await race.manager.start('media_capture_screen',{}, {...options,addToChat:true});
  const running=race.manager.advance(rt.taskId);await Promise.resolve();await Promise.resolve();
  const cancellation=await race.manager.cancel(rt.taskId);assert.equal(cancellation.cancelled,true);
  gate.resolve();await running;race.tick();await race.manager.advance(rt.taskId);
  const result=await race.manager.status(rt.taskId);assert.equal(result.status,'cancelled');assert.equal(race.released.length,0);
  assert.ok(race.starts<=1);if(race.starts && asyncCreation)assert.equal(race.nativeCancels,1);
}

// Status must not become a blocking substitute for a synchronous Agent call.
const slowGate=deferred(),slow=fixture({startGate:slowGate});
const slowTask=await slow.manager.start('media_image_crop',{},options);
const early=await slow.manager.status(slowTask.taskId);
assert.ok(['queued','working'].includes(early.status));
await slow.manager.cancel(slowTask.taskId);slowGate.resolve();

// Upload failure retains creation success and every path; no false completed.
const failed=fixture({chatFailure:'Maximum files exceeded: 5.'});const ft=await failed.manager.start('media_image_crop',{}, {...options,addToChat:true});
await failed.manager.advance(ft.taskId);const failure=await failed.manager.status(ft.taskId);
assert.equal(failure.status,'failed');assert.equal(failure.creation.status,'completed');assert.equal(failure.files.length,2);
assert.match(failure.error.message,/Maximum/);assert.equal(failed.starts,1);

const wrong=fixture({asyncCreation:true});const wt=await wrong.manager.start('media_clip',{}, {...options,addToChat:true});
await wrong.manager.advance(wt.taskId);
wrong.host.producers.media_clip.status=async()=>({taskId:'different-id',status:'completed',progressPercent:100,files:['unrelated.png']});
wrong.tick();await wrong.manager.advance(wt.taskId);
assert.equal((await wrong.manager.status(wt.taskId)).error.code,'AGENT_INVALID_RESPONSE');assert.equal(wrong.released.length,0);

// Empty-file clipboard text completes locally, but never submits text silently.
const text=fixture({files:[]});const tx=await text.manager.start('clipboard_get',{}, {...options,addToChat:true});await text.manager.advance(tx.taskId);
assert.equal((await text.manager.status(tx.taskId)).error.code,'MEDIA_ARTIFACT_NO_FILES');assert.equal(text.released.length,0);

// Committed Send denies cancellation; parent completion still reflects it.
const sent=fixture();const st=await sent.manager.start('camera_capture_frame',{}, {...options,addToChat:true});await sent.manager.advance(st.taskId);sent.completeChat();
const sc=await sent.manager.cancel(st.taskId);assert.equal(sc.cancelled,false);assert.equal(sc.task.status,'completed');assert.equal(sc.task.progressPercent,100);

// Worker restoration resumes known native/status/delay stages; it never
// replays an unacknowledged start or an interrupted synchronous operation.
const restore=fixture({asyncCreation:true});const rs=await restore.manager.start('media_clip',{}, {...options,addToChat:true});await restore.manager.advance(rs.taskId);
restore.completeCreation();restore.tick();const restarted=restore.restart();await restarted.ensure();await restarted.advance(rs.taskId);
assert.equal(restore.starts,1);assert.equal((await restarted.status(rs.taskId)).creation.status,'completed');
await restarted.cancel(rs.taskId);
const interrupted=fixture();const it=await interrupted.manager.start('media_image_crop',{},options);const next=interrupted.restart();await next.ensure();
assert.equal((await next.status(it.taskId)).error.code,'MEDIA_ARTIFACT_INTERRUPTED');assert.equal(interrupted.starts,0);

// Same history cap as existing managers; metadata eviction never deletes files.
const history=fixture();const ids=[];for(let i=0;i<3;i++){const h=await history.manager.start('media_image_crop',{},options);ids.push(h.taskId);await history.manager.advance(h.taskId);}
assert.equal(history.records.length,2);await assert.rejects(history.manager.status(ids[0]),e=>e.code==='MEDIA_ARTIFACT_TASK_NOT_FOUND');
await assert.rejects(history.manager.status(ids[2],'media_clip'),e=>e.code==='MEDIA_ARTIFACT_TASK_NOT_FOUND');
console.log('Artifact lifecycle: all 12 tools, binding, ordered outputs, polling, upload errors, cancellation races, committed Send, restart and history verified.');

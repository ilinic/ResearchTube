import { resolveChatComposer } from "./chat-composer.js";

// Optional chat context lives on task records; no task-ID/tab-ID routing table.
export const taskTabSchema = { type: "integer", minimum: 0, description: "Optional ChatGPT tabId from the startup prompt (use chatTabId in a Study this site prompt). On completion notify this tab only if idle; omit for no wake-up." };
export function normalizeTaskTabId(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw Object.assign(new Error("tabId must be a nonnegative integer."), { code: "INVALID_ARGUMENT" });
  return value;
}
// Recurring notifications use a durable wall-clock deadline in the browser,
// distinct from the Agent's precise one-shot countdown. A late wake coalesces
// missed intervals into one notification; the next interval starts on ACK.
function repeatingTimerSnapshot(record,now){
  const instant=record.cancelledAt??now;
  const started=record.nextDueAt-record.intervalMs;
  const remaining=Math.max(0,record.nextDueAt-instant)/1000;
  const duration=record.intervalMs/1000;
  const utc=ms=>new Date(ms).toISOString();
  const format=new Intl.DateTimeFormat("en-CA",{timeZone:record.timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23",timeZoneName:"longOffset"});
  const local=ms=>{
    const fields=Object.fromEntries(format.formatToParts(new Date(ms)).map(p=>[p.type,p.value]));
    const offset=fields.timeZoneName==="GMT"?"+00:00":fields.timeZoneName.slice(3);
    const sign=offset.startsWith("-")?-1:1;
    const [hours,minutes,seconds]=offset.slice(1).split(":").map(Number);
    return {text:fields.year+"-"+fields.month+"-"+fields.day+"T"+fields.hour+":"+fields.minute+":"+fields.second+offset,offset:sign*((hours||0)*3600+(minutes||0)*60+(seconds||0))};
  };
  const start=local(started),current=local(instant),target=local(record.nextDueAt);
  return {taskId:record.taskId,status:record.status,phase:record.status==="cancelled"?"cancelled":"waiting",mode:"duration",clockSource:"system",timeZone:record.timeZone,
    createdAtUtc:utc(record.createdAt),startedAtUtc:utc(started),currentUtc:utc(instant),targetUtc:utc(record.nextDueAt),
    startedAtLocal:start.text,currentLocal:current.text,targetLocal:target.text,currentUtcOffsetSeconds:current.offset,targetUtcOffsetSeconds:target.offset,
    durationSeconds:duration,elapsedSeconds:Math.max(0,instant-started)/1000,remainingSeconds:remaining,progressPercent:Math.min(100,Math.max(0,(1-remaining/duration)*100)),pollIntervalMs:1000,
    completedAtUtc:null,latenessSeconds:null,sleepDetection:"executionGapOnly",warnings:[],warningCount:0,error:null,clockSync:null,
    tabId:record.tabId,repeat:true,fireCount:record.fireCount,deliveryPending:record.status==="working"&&instant>=record.nextDueAt,deliveryUncertain:record.repeatPhase==="sending"||record.repeatPhase==="uncertain"};
}
export function createTaskCompletionDelivery(host) {
  // Used for persistent chat timers and asynchronous Custom Tools. Other managers already
  // own their task records and invoke completed directly.
  let records = [], loaded = false, loading = null, ticking = false, writing = Promise.resolve();
  const delivering=new Map();
  const terminal = task => ["completed", "failed", "cancelled"].includes(task.status);
  const save = () => {
    const done = records.filter(terminal);
    const remove = new Set(done.slice(0, Math.max(0, done.length - host.historyLimit())).map(task => task.taskId));
    records = records.filter(task => !remove.has(task.taskId));
    const snapshot = JSON.parse(JSON.stringify(records));
    writing = writing.catch(() => {}).then(() => host.save(snapshot));
    return writing;
  };
  async function ensure() {
    if (loaded) return;
    if (loading) return loading;
    loading = (async () => {
      records = await host.load();
      if (!Array.isArray(records)) records = [];
      records = records.filter(task => typeof task.taskId === "string" && (task.kind==="custom" || task.kind==="timer"&&task.repeat===true));
      loaded = true;
    })().finally(() => { loading = null; });
    return loading;
  }
  async function startRepeating({tabId,conversationId,intervalMs,timeZone}){
    await ensure();
    const now=host.now();
    if(!Number.isSafeInteger(intervalMs)||intervalMs<1000||!Number.isFinite(now+intervalMs)||now+intervalMs>8.64e15||!conversationId||!Number.isSafeInteger(tabId))throw Object.assign(Error("A repeating timer requires an identified conversation and a duration of at least one second."),{code:"TIMER_INVALID"});
    // One active recurring wake-up per conversation avoids accidental duplicate
    // loops when an LLM restarts an already registered periodic timer.
    const previous=records.find(r=>r.repeat&&r.status==="working"&&r.conversationId===conversationId);
    if(previous){
      if(previous.intervalMs!==intervalMs)throw Object.assign(Error("A repeating timer already exists in this conversation. Cancel it before changing the interval."),{code:"TIMER_INVALID"});
      return repeatingTimerSnapshot(previous,now);
    }
    const record={taskId:host.id(),kind:"timer",tabId,conversationId,intervalMs,timeZone,createdAt:now,nextDueAt:now+intervalMs,repeat:true,fireCount:0,repeatPhase:"waiting",status:"working"};
    records.push(record);
    await save();host.schedule(1000);
    return repeatingTimerSnapshot(record,now);
  }
  async function repeatingStatus(id,cancel=false){
    await ensure();
    const record=records.find(r=>r.repeat&&r.taskId===id);
    if(!record)return null;
    if(!cancel)return repeatingTimerSnapshot(record,host.now());
    const cancelled=record.status==="working";
    if(cancelled){record.status="cancelled";record.cancelledAt=host.now();await save();}
    return {task:repeatingTimerSnapshot(record,host.now()),cancelled};
  }
  function repeatMarker(record){return "ResearchTube timer "+record.taskId+" tick "+(record.fireCount+1);}
  async function tickRepeat(record){
    if(record.status!=="working"||host.now()<record.nextDueAt)return;
    const target=await host.resolveTarget(record);
    if(!target||record.status!=="working")return;
    if(record.conversationId!==target.conversationId||record.tabId!==target.tabId){
      record.conversationId=target.conversationId;record.tabId=target.tabId;await save();
    }
    const marker=repeatMarker(record);
    const live=await host.inspect(target.tabId);
    if(record.status!=="working")return;
    const acknowledged=()=>{record.fireCount++;record.nextDueAt=host.now()+record.intervalMs;record.repeatPhase="waiting";};
    // After a worker restart or an uncertain click, only positive evidence of
    // this exact user message can advance the sequence. Never blindly replay.
    if(live?.timerMarkers?.includes(marker)){acknowledged();await save();return;}
    if(record.repeatPhase==="sending"||record.repeatPhase==="uncertain"){record.repeatPhase="uncertain";return;}
    if(!live?.ready||live.draft||live.generating||await host.pending?.(target.tabId))return;
    record.repeatPhase="sending";await save();
    if(record.status!=="working")return;
    const guard=async()=>{
      if(record.status!=="working")throw Object.assign(Error("Repeating timer cancelled."),{code:"TIMER_INVALID"});
      const current=await host.resolveTarget(record);
      if(!current||current.tabId!==target.tabId||current.conversationId!==target.conversationId)throw Object.assign(Error("Repeating timer target changed."),{code:"BROWSER_CHAT_CHANGED"});
    };
    delivering.set(record.taskId,target.tabId);
    try{
      const result=await host.send(target.tabId,{completionText:marker+" completed. Continue the ongoing authorized task using its saved memory. This repeating timer will notify again automatically; do not create another timer.",chatPath:target.chatPath,scheduled:true,planned:true,beforeSend:guard,beforeInsert:guard,beforeDispatch:guard});
      if(record.status!=="working")return;
      if(result?.sent)acknowledged();
      else record.repeatPhase=result?.committed||result?.inserted?"uncertain":"waiting";
    }catch(error){
      // The send implementation may have failed after input mutation.
      record.repeatPhase="uncertain";
      host.log?.("Repeating timer send uncertain",{taskId:record.taskId,code:error.code||"CHAT_UNAVAILABLE"});
    }finally{delivering.delete(record.taskId);await save();}
  }
  async function completed(task, persist = async () => {}) {
    if (task.repeat || task.status !== "completed" || task.chatCompletionHandled || task.tabId == null || task.suppressCompletionNotification) return;
    // Mark before awaited I/O, including immediate completion at task launch.
    // Busy/missing tabs consume the notification: there is no pending wake-up.
    task.chatCompletionHandled = true;
    delivering.set(task.taskId,task.tabId);
    try { await persist(); await host.send(task.tabId, { completionText: "ResearchTube task " + task.taskId + " completed.", ...(task.cloudTarget ? { cloudTarget: task.cloudTarget } : {}) }); }
    catch (error) { host.log?.("Task completion notification stopped", { taskId: task.taskId, code: error.code || "CHAT_UNAVAILABLE" }); }
    finally { delivering.delete(task.taskId); }
  }
  async function register(task, kind, tabId, cloudTarget = null) {
    await ensure();
    if (tabId == null) return task;
    if(kind!=="custom")throw Object.assign(Error("Only persistent chat timers can be started."),{code:"TIMER_INVALID"});
    let record = records.find(item => item.taskId === task.taskId);
    if (!record) { record = { ...task, kind, tabId, ...(cloudTarget ? { cloudTarget } : {}) }; records.push(record); }
    else Object.assign(record, task);
    await save();
    await completed(record, save);
    if (!terminal(record)) host.schedule(Math.max(250, record.pollIntervalMs || 1000));
    return { ...task, tabId: record.tabId };
  }
  async function observe(task) {
    await ensure();
    const record = records.find(item => item.taskId === task.taskId);
    if (!record || record.repeat) return task;
    Object.assign(record, task);
    await save();
    await completed(record, save);
    return { ...task, tabId: record.tabId };
  }
  async function tick() {
    await ensure();
    if (ticking) return;
    ticking = true;
    try {
      for (const record of records) {
        if(record.repeat){
          try{await tickRepeat(record);}catch(error){host.log?.("Repeating timer tick unavailable",{taskId:record.taskId,code:error.code||"CHAT_UNAVAILABLE"});}
          continue;
        }
        if (terminal(record) || host.now() < (record.nextPollAt || 0)) continue;
        record.nextPollAt = host.now() + Math.max(250, record.pollIntervalMs || 1000);
        try {
          const task = await host.status(record.kind, record.taskId);
          if (task.taskId !== record.taskId) throw new Error("Another task returned");
          if (terminal(record)) continue; // Cancellation observed during this poll wins.
          Object.assign(record, task);
          await save(); await completed(record, save);
        } catch (error) { host.log?.("Background task poll unavailable", { taskId: record.taskId, code: error.code || "AGENT_UNAVAILABLE" }); }
      }
      const done = records.filter(terminal);
      const remove = new Set(done.slice(0, Math.max(0, done.length - host.historyLimit())).map(task => task.taskId));
      records = records.filter(task => !remove.has(task.taskId)); await save();
      if (records.some(task => !terminal(task))) host.schedule(1000);
    } finally { ticking = false; }
  }
  return { ensure, completed, register, observe, tick, startRepeating, repeatingStatus, hasPendingChat: id=>[...delivering.values()].includes(id)||records.some(t=>!t.repeat&&t.tabId===id&&(!terminal(t)||t.status==="completed"&&!t.chatCompletionHandled)) };
}

// Installed only in a ChatGPT tab explicitly used by ResearchTube. Readiness
// uses the shared Composer resolver/inspection; messages never log draft text.
export function installComposerWatchdog(seconds, inspect, readOnly = false) {
  const previous = window.__researchtubeComposerWatchdog;
  if (previous) { previous.seconds = seconds; if (!readOnly) previous.autoSend = true; return previous.read(); }
  let key = null, changedAt = performance.now(), revision = 0, suppressed = false, requesting = false, holds = 0;
  const state = { seconds, autoSend: !readOnly };
  function read() {
    const { composer, root } = resolveChatComposer();
    const inspected = inspect();
    const text = composer ? String(composer.value ?? composer.innerText ?? composer.textContent ?? "") : "";
    const attachments = Math.max(inspected.attachments?.length || 0, inspected.selectedFiles?.length || 0, inspected.previewCount || 0);
    const next = JSON.stringify([Boolean(composer), text, attachments]);
    if (next !== key) { key = next; revision++; changedAt = performance.now(); }
    if (!text.trim() && !attachments) suppressed = false;
    const send = root?.querySelector('button[type="submit"]');
    const generating = Boolean(document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"], button[aria-label="Stop"], button[aria-label="Остановить"]'));
    return { found: Boolean(composer && root), text, attachments, revision, stableMs: performance.now() - changedAt,
      idle: !generating, sendEnabled: Boolean(send && !send.disabled && send.getAttribute("aria-disabled") !== "true"),
      blocked: holds > 0 || suppressed };
  }
  state.read = read;
  state.hold = () => { holds++; };
  state.release = preserve => { holds = Math.max(0, holds - 1); if (preserve) suppressed = true; };
  state.suppress = () => { suppressed = true; };
  const sample = () => {
    if (!state.autoSend) return;
    const value = read();
    if (requesting || value.blocked || !value.found || !value.idle || !value.sendEnabled || !value.text.trim() && !value.attachments || value.stableMs < state.seconds * 1000) return;
    requesting = true;
    chrome.runtime.sendMessage({ type: "researchtube_composer_watchdog", revision: value.revision }).then(reply => {
      // Ignore a response to a draft that has changed while the worker ran.
      if (reply?.sent && read().revision === value.revision) state.suppress();
    }).catch(() => {}).finally(() => { requesting = false; });
  };
  const timer = setInterval(sample, 1000);
  const input = event => {
    const { composer } = resolveChatComposer();
    if (event.isTrusted && composer && (event.target === composer || composer.contains(event.target))) suppressed = false;
    read();
  };
  document.addEventListener("input", input, true);
  document.addEventListener("change", input, true);
  state.dispose = () => { clearInterval(timer); document.removeEventListener("input", input, true); document.removeEventListener("change", input, true); delete window.__researchtubeComposerWatchdog; };
  window.__researchtubeComposerWatchdog = state;
  return read();
}

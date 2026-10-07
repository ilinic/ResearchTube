// One public lifecycle for creation followed by optional current-chat delivery.
// Producers and chat automation own their native work; this manager never
// reads file bytes, guesses a tab, replays creation, or clears the Composer.
export const ARTIFACT_TOOLS = Object.freeze([
  'youtube_download', 'youtube_storyboard_download', 'media_capture_frame',
  'visual_map_create', 'media_clip', 'camera_record_video', 'camera_record_audio',
  'system_speech_speak', 'media_capture_screen', 'media_image_crop',
  'camera_capture_frame', 'clipboard_get'
]);
export const ARTIFACT_OPERATION_NAMES = Object.freeze({
  youtube_download:'YouTube download', youtube_storyboard_download:'Storyboard download',
  media_capture_frame:'Frame extraction', visual_map_create:'Visual map', media_clip:'Media clipping',
  camera_record_video:'Video recording', camera_record_audio:'Audio recording', system_speech_speak:'Speech',
  media_capture_screen:'Screen capture', media_image_crop:'Image crop', camera_capture_frame:'Camera capture', clipboard_get:'Clipboard read'
});
export function artifactOperationMessage(tool, state='working') {
  const name=ARTIFACT_OPERATION_NAMES[tool] ?? 'Media';
  if(state==='working') return tool==='system_speech_speak'?'Synthesizing speech.':`${name} in progress.`;
  return `${name} task ${state}.`;
}
export const ARTIFACT_STATUS_TOOLS = Object.freeze({
  youtube_download_get_task: 'youtube_download', youtube_storyboard_get_task: 'youtube_storyboard_download',
  media_capture_frame_get_task: 'media_capture_frame', visual_map_get_task: 'visual_map_create',
  media_clip_get_task: 'media_clip', camera_record_status: ['camera_record_video', 'camera_record_audio'],
  system_speech_status: 'system_speech_speak'
});
export const ARTIFACT_CANCEL_TOOLS = Object.freeze({
  youtube_download_cancel_task: 'youtube_download', youtube_storyboard_cancel_task: 'youtube_storyboard_download',
  media_capture_frame_cancel_task: 'media_capture_frame', visual_map_cancel_task: 'visual_map_create',
  media_clip_cancel_task: 'media_clip', system_speech_cancel: 'system_speech_speak'
});
const terminal = status => ['completed', 'failed', 'cancelled'].includes(status);
const object = (properties, required = Object.keys(properties)) => ({type:'object', additionalProperties:false, properties, required});
const errorSchema = object({code:{type:'string'}, message:{type:'string'}});
const nullable = schema => ({anyOf:[schema,{type:'null'}]});
export const artifactOptionsSchema = {
  addToChat:{type:'boolean',default:false,description:'Upload all created files to the originating ChatGPT conversation and press Send as the second stage of this task. This supplies attachments to ChatGPT, unlike media_show which only displays a viewer. Default false runs only the requested operation.'},
  composerPolicy:{type:'string',enum:['requireEmpty','clear'],default:'requireEmpty',description:'With addToChat: requireEmpty refuses an existing draft or attachments; clear explicitly discards both once before upload. New user edits stop Send and leave uploaded files attached.'},
  sendDelaySeconds:{type:'number',minimum:0,default:0,description:'With addToChat: optional seconds between acceptance of all eligible attachments and Send. Readiness is checked separately. Status exposes waitingToSend, sendNotBefore and remainingSeconds. Cancellation leaves the Composer untouched.'}
};
export function artifactTaskSchema(chatSchema, dataSchema = {type:'object'}) {
  return object({
    taskId:{type:'string',pattern:'^tsk_[A-Za-z0-9_-]{10}$'},tool:{type:'string',enum:ARTIFACT_TOOLS},
    status:{enum:['queued','working','completed','failed','cancelled']},phase:{type:'string'},
    progressPercent:{type:'number',minimum:0,maximum:100},statusMessage:{type:'string'},
    createdAt:{type:'string'},lastUpdatedAt:{type:'string'},pollIntervalMs:{type:'integer',minimum:1000},
    statusTool:{const:'media_task_status'},cancelTool:{const:'media_task_cancel'},addToChat:{type:'boolean'},
    files:{type:'array',items:object({workspacePath:{type:'string',minLength:1}})},
    creation:object({status:{enum:['queued','working','completed','failed','cancelled']},phase:{type:'string'},
      progressPercent:{type:'number',minimum:0,maximum:100},data:nullable(dataSchema),error:nullable(errorSchema)}),
    chat:nullable(chatSchema),error:nullable(errorSchema)
  });
}

export function createArtifactTaskManager(host) {
  let tasks = new Map(), loaded = false, loading;
  const running = new Set();
  let persistence = Promise.resolve();
  const now = () => new Date(host.now()).toISOString();
  const error = (code,message) => Object.assign(new Error(message),{code});
  const publicError = value => ({code:typeof value?.code==='string'?value.code:'MEDIA_ARTIFACT_FAILED',
    message:host.errorMessage(value)});
  // Serial writes prevent an older snapshot from replacing a cancellation.
  const persist = () => {
    host.prune(tasks);
    const snapshot = JSON.parse(JSON.stringify([...tasks.values()]));
    const write = persistence.catch(()=>{}).then(()=>host.save(snapshot));
    persistence = write;
    return write;
  };
  const document = task => ({taskId:task.taskId,tool:task.tool,status:task.status,phase:task.phase,
    progressPercent:task.progressPercent,statusMessage:task.statusMessage,
    createdAt:task.createdAt,lastUpdatedAt:task.lastUpdatedAt,pollIntervalMs:1000,
    statusTool:'media_task_status',cancelTool:'media_task_cancel',addToChat:task.addToChat,
    files:task.files.map(({workspacePath})=>({workspacePath})),
    creation:{status:task.creation.status,phase:task.creation.phase,progressPercent:task.creation.progressPercent,
      data:task.creation.data,error:task.creation.error},chat:task.chat,error:task.error});
  async function save(task) {
    task.lastUpdatedAt = now();
    await persist();
    host.report(document(task));
  }
  async function finish(task,status,failure=null) {
    task.status=status;task.phase=status;task.error=failure;
    delete task.input;
    task.statusMessage=failure?.message ?? (status==='completed' && task.addToChat?'All requested stages completed.':artifactOperationMessage(task.tool,status));
    if(status==='completed')task.progressPercent=100;
    await host.unschedule(task.taskId);
    if(status!=='completed' && task.chatTaskId) {
      try {
        const result=await host.cancelChat(task.chatTaskId);
        task.chat=result.task??await host.chatStatus(task.chatTaskId);
      } catch { /* A missing child cannot undo creation or revive delivery. */ }
    }
    await save(task);
  }
  async function ensure() {
    if(loaded)return;
    if(loading)return loading;
    loading=(async()=>{
      tasks=new Map((await host.load()).filter(t=>t && ARTIFACT_TOOLS.includes(t.tool) && /^tsk_[A-Za-z0-9_-]{10}$/.test(t.taskId))
        .map(t=>[t.taskId,t]));
      loaded=true;
      for(const task of tasks.values()) {
        if(terminal(task.status))continue;
        // No id means the worker was interrupted during a non-replayable
        // start or synchronous Agent operation. Never run that operation twice.
        if(task.creation.status!=='completed' && !task.creation.taskId) {
          await finish(task,'failed',publicError(error('MEDIA_ARTIFACT_INTERRUPTED','The Extension restarted during file creation. Check the Workspace before retrying; creation is not replayed.')));
        } else await host.schedule(task.taskId,1);
      }
    })().finally(()=>{loading=null;});
    return loading;
  }
  const get = (id,tools=null) => {
    const task=tasks.get(id);
    if(!task || tools && !(Array.isArray(tools)?tools:[tools]).includes(task.tool)) {
      throw error('MEDIA_ARTIFACT_TASK_NOT_FOUND','This artifact task was not found in Extension history. It may have been evicted or belong to another tool.');
    }
    return task;
  };
  async function acceptCreation(task,data) {
    const producer=host.producers[task.tool];
    task.creation.data=data;
    task.creation.phase=data.phase ?? 'completed';
    task.files=producer.files(data).map(path=>({workspacePath:host.path(path)}));
    const status=data.status==='stopping'?'working':data.status;
    task.creation.status=producer.status ? status : data.ok===false ? 'failed' : 'completed';
    task.creation.progressPercent=Math.max(task.creation.progressPercent,Number.isFinite(data.progressPercent)?data.progressPercent:task.creation.status==='completed'?100:0);
    task.creation.error=data.error?publicError(data.error):null;
    if(task.creation.status==='failed' && !task.creation.error) task.creation.error=publicError(error('MEDIA_ARTIFACT_FAILED',data.message ?? 'File creation failed.'));
    task.progressPercent=Math.max(task.progressPercent,Math.min(task.addToChat?70:99,task.creation.progressPercent*(task.addToChat?.7:.99)));
  }
  async function advance(id) {
    await ensure();
    const task=tasks.get(id);
    if(!task || terminal(task.status) || running.has(id))return;
    running.add(id);
    try {
      const producer=host.producers[task.tool];
      task.status='working';
      if(task.creation.status==='queued') {
        task.phase='creating';task.creation.status='working';task.creation.phase='preparing';
        task.statusMessage=artifactOperationMessage(task.tool);
        // This write is the no-replay boundary, before issuing the Agent call.
        await save(task);
        if(task.cancelRequested) {task.creation.status='cancelled';await finish(task,'cancelled');return;}
        const data=await producer.start(task.input);
        if(data.status==='rejected')throw data.error;
        if(producer.status) {
          if(typeof data.taskId!=='string')throw error('AGENT_INVALID_RESPONSE','Creation returned no native task identifier.');
          task.creation.taskId=data.taskId;
        }
        // Status polling uses the native handle. Do not retain the original
        // speech text or other potentially large inputs in terminal history.
        delete task.input;
        await acceptCreation(task,data);
        // Cancellation can arrive while the producer's start request is in flight.
        if(task.cancelRequested && producer.cancel && !terminal(task.creation.status)) {
          await producer.cancel(task.creation.taskId);task.nativeCancelSent=true;
        }
      } else if(task.creation.status==='working') {
        if(host.now()<(task.nextCreationPoll??0))return;
        const data=await producer.status(task.creation.taskId);
        if(data.status==='rejected')throw data.error;
        if(data.taskId!==task.creation.taskId)throw error('AGENT_INVALID_RESPONSE','The Agent returned another native creation task. No files were selected for delivery.');
        await acceptCreation(task,data);
        if(task.cancelRequested && !task.nativeCancelSent && !terminal(task.creation.status)) {
          await producer.cancel(task.creation.taskId);task.nativeCancelSent=true;
        }
      }
      if(task.addToChat && !task.chatReleased) task.chat=await host.chatStatus(task.chatTaskId);
      if(!terminal(task.creation.status)) {
        task.phase=task.cancelRequested?'cancelling':task.creation.phase;
        task.statusMessage=task.cancelRequested?artifactOperationMessage(task.tool,'cancelling'):(task.creation.data?.statusMessage || artifactOperationMessage(task.tool));
        task.nextCreationPoll=host.now()+Math.max(1000,task.creation.data?.pollIntervalMs??1000);
        await save(task);await host.schedule(id,task.nextCreationPoll-host.now());return;
      }
      if(task.cancelRequested || task.creation.status==='cancelled') {await finish(task,'cancelled');return;}
      if(task.creation.status==='failed') {await finish(task,'failed',task.creation.error);return;}
      if(!task.addToChat) {await finish(task,'completed');return;}
      if(!task.files.length) {
        await finish(task,'failed',publicError(error('MEDIA_ARTIFACT_NO_FILES','Creation produced no file to attach. Clipboard text is returned in creation.data and is not automatically sent.')));return;
      }
      if(!task.chatReleased) {
        await host.releaseChat(task.chatTaskId,task.files);
        task.chatReleased=true;
      }
      task.chat=await host.chatStatus(task.chatTaskId);
      task.phase=task.chat.phase==='queued'?'chatPreparing':task.chat.phase;
      task.statusMessage=task.chat.message;
      task.progressPercent=Math.max(task.progressPercent,70+task.chat.progressPercent*.29);
      if(terminal(task.chat.status)) {
        await finish(task,task.chat.status,task.chat.error?publicError(error('MEDIA_ARTIFACT_CHAT_FAILED',task.chat.error)):null);return;
      }
      await save(task);await host.schedule(id,1000);
    } catch(failure) {
      if(task.creation.status!=='completed') {
        task.creation.status='failed';task.creation.phase='failed';task.creation.error=publicError(failure);
      }
      await finish(task,task.cancelRequested?'cancelled':'failed',task.cancelRequested?null:publicError(failure));
    } finally {running.delete(id);}
  }
  return {
    ensure,advance,
    async start(tool,input,options) {
      await ensure();
      const createdAt=now();let taskId;
      do {taskId=host.id();}while(tasks.has(taskId));
      const task={taskId,tool,input,...options,status:'queued',phase:'preparing',progressPercent:0,
        statusMessage:artifactOperationMessage(tool,'queued'),createdAt,lastUpdatedAt:createdAt,files:[],chat:null,error:null,
        creation:{status:'queued',phase:'preparing',progressPercent:0,data:null,error:null,taskId:null}};
      if(options.addToChat) {
        task.chatTaskId=await host.reserveChat(options);
        task.chat=await host.chatStatus(task.chatTaskId);
      }
      tasks.set(taskId,task);await save(task);
      await host.schedule(taskId,1);
      return document(task);
    },
    async status(id,tools=null) {
      await ensure();const task=get(id,tools);
      // Never make a status call wait for a single capture/crop/read. Its
      // asynchronous start may still be queued before the short timer fires.
      if(task.creation.status==='queued') {void advance(id);return document(task);}
      await advance(id);return document(get(id,tools));
    },
    async metadata(id) {await ensure();const task=get(id);return task.chatTaskId?host.chatMetadata(task.chatTaskId):null;},
    async nativeId(id,tools=null) {await ensure();const task=get(id,tools);if(!task.creation.taskId)throw error('MEDIA_ARTIFACT_INVALID','Creation has not acquired its native task handle yet. Check media_task_status first.');return task.creation.taskId;},
    async cancel(id,tools=null) {
      await ensure();const task=get(id,tools);
      if(terminal(task.status))return {task:document(task),cancelled:false};
      // A committed Send cannot be undone. Check its synchronous commit flag
      // inside the chat manager before accepting cancellation of this parent.
      if(task.chatTaskId) {
        const result=await host.cancelChat(task.chatTaskId);
        task.chat=result.task??await host.chatStatus(task.chatTaskId);
        if(!result.cancelled && task.chatReleased) {
          await advance(id);return {task:document(get(id)),cancelled:false};
        }
      }
      task.cancelRequested=true;task.phase='cancelling';task.statusMessage=artifactOperationMessage(task.tool,'cancelling');
      await save(task);
      if(!terminal(task.creation.status) && task.creation.taskId && !task.nativeCancelSent) {
        await host.producers[task.tool].cancel(task.creation.taskId);task.nativeCancelSent=true;await save(task);
      }
      if(!running.has(id)) {
        if(task.creation.status==='queued') {task.creation.status='cancelled';await finish(task,'cancelled');}
        else await advance(id);
      }
      return {task:document(task),cancelled:true};
    }
  };
}

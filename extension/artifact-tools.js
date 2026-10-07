import { ARTIFACT_TOOLS, ARTIFACT_STATUS_TOOLS, ARTIFACT_CANCEL_TOOLS, artifactOptionsSchema, artifactTaskSchema, artifactOperationMessage } from './artifact-tasks.js';

// Public names are uniform. Agent request names remain private and are
// translated once at the MCP boundary, avoiding unrelated Agent migrations.
export const WORKSPACE_ARGUMENT_NAMES = Object.freeze({
  workspace_list:{path:'workspacePath'},workspace_stat:{path:'workspacePath'},
  workspace_mkdir:{path:'workspacePath'},workspace_delete:{path:'workspacePath'},
  workspace_move:{source:'workspacePath',destination:'destinationWorkspacePath'},
  media_probe:{path:'workspacePath'},media_show:{path:'workspacePath'},media_image_inspect:{path:'workspacePath'},
  media_capture_frame:{path:'workspacePath'},media_clip:{path:'workspacePath',outputDir:'outputWorkspaceDirectory'},
  media_image_crop:{path:'workspacePath',outputPath:'outputWorkspacePath'},
  media_capture_screen:{outputPath:'outputWorkspacePath'},camera_capture_frame:{targetPath:'outputWorkspacePath'},
  system_speech_speak:{outputPath:'outputWorkspacePath'},youtube_download:{outputDir:'outputWorkspaceDirectory'},
  online_share_start:{file:'workspacePath',folder:'workspaceDirectory',probePath:'probeWorkspacePath'}
});
function renameSchema(schema,names) {
  if(Array.isArray(schema))return schema.map(s=>renameSchema(s,names));
  if(!schema || typeof schema!=='object')return schema;
  return Object.fromEntries(Object.entries(schema).map(([key,value])=>[
    key,key==='properties'?Object.fromEntries(Object.entries(value).map(([name,property])=>[names[name]??name,renameSchema(property,names)]))
      :key==='required'?value.map(name=>names[name]??name):renameSchema(value,names)
  ]));
}
function renameDescription(text,names) {
  return Object.entries(names).reduce((result,[oldName,newName])=>result.replace(new RegExp(`\\b${oldName}\\b`,'g'),newName),text);
}
export function publicWorkspaceArguments(tool,args,definitions) {
  if(!args || typeof args!=='object' || Array.isArray(args))throw Object.assign(new Error('Tool arguments must be an object.'),{code:'INVALID_ARGUMENT'});
  const definition=definitions.find(t=>t.name===tool);
  if(!definition)return args;
  const names=WORKSPACE_ARGUMENT_NAMES[tool]??{};
  const allowed=new Set(Object.keys(definition.inputSchema.properties??{}));
  for(const key of Object.keys(args)) {
    if(!allowed.has(key))throw Object.assign(new Error(`Unsupported ${tool} parameter ${key}.${names[key]?` Use ${names[key]} instead.`:''}`),{code:'INVALID_ARGUMENT'});
  }
  const reverse=Object.fromEntries(Object.entries(names).map(([a,b])=>[b,a]));
  return Object.fromEntries(Object.entries(args).map(([key,value])=>[reverse[key]??key,value]));
}
export function artifactToolDefinitions(definitions,chatSchema,widgetUri,readAnnotations,writeAnnotations) {
  // A private tab reservation exists before there are artifacts. It has an
  // empty real-file list; ordinary media_to_chat still requires a nonempty batch.
  const workflowChatSchema={...chatSchema,properties:{...chatSchema.properties,
    files:{...chatSchema.properties.files,minItems:0}}};
  const dataSchemas=Object.fromEntries(definitions.filter(t=>ARTIFACT_TOOLS.includes(t.name)).map(t=>[t.name,
    t.name==='youtube_download'?{type:'object',anyOf:[t.outputSchema,definitions.find(d=>d.name==='youtube_download_get_task').outputSchema]}:t.outputSchema]));
  const taskSchema=artifactTaskSchema(workflowChatSchema,{type:'object',anyOf:Object.values(dataSchemas)});
  // A producer only advertises its own native result, so the model does not
  // have to inspect twelve unrelated metadata variants for a simple crop.
  const schemaFor=names=>artifactTaskSchema(workflowChatSchema,Array.isArray(names)
    ?{type:'object',anyOf:names.map(name=>dataSchemas[name])}:dataSchemas[names]);
  const taskInput={type:'object',additionalProperties:false,properties:{taskId:{type:'string',pattern:'^tsk_[A-Za-z0-9_-]{10}$'}},required:['taskId']};
  const cancelSchema={type:'object',additionalProperties:false,properties:{task:taskSchema,cancelled:{type:'boolean'}},required:['task','cancelled']};
  const result=definitions.map(definition=>{
    const names=WORKSPACE_ARGUMENT_NAMES[definition.name]??{};
    let tool={...definition,inputSchema:renameSchema(definition.inputSchema,names),description:renameDescription(definition.description,names)};
    // Rename references inside property descriptions as well.
    for(const property of Object.values(tool.inputSchema.properties??{})) {
      if(property.description)property.description=renameDescription(property.description,names);
    }
    if(ARTIFACT_TOOLS.includes(tool.name)) {
      tool.inputSchema.properties={...tool.inputSchema.properties,...artifactOptionsSchema};
      // Legacy display flags blur presentation and actual file submission.
      delete tool.inputSchema.properties.showInChat;
      tool.description=tool.description.replace(/showInChat defaults to false:[\s\S]*?The tool never/,'The tool never')
        .replace(/For media_capture_screen[^.]*\./g,'')
        .replace(/For text, returns Unicode text directly\./,'For text, returns Unicode text in creation.data after the asynchronous read.');
      tool.description+=' Returns an asynchronous task; results in creation.data. Poll media_task_status at pollIntervalMs; cancel via media_task_cancel. addToChat uploads outputs and presses Send; do not re-upload. Finish the response if Send waits. Saved files survive cancellation; outputs never overwrite existing files.';
      tool.outputSchema=schemaFor(tool.name);
      tool.annotations={...tool.annotations,destructiveHint:true,openWorldHint:true};
      tool._meta={...tool._meta,ui:{resourceUri:widgetUri},'openai/outputTemplate':widgetUri,
        'openai/toolInvocation/invoked':artifactOperationMessage(tool.name,'started')};
    } else if(Object.hasOwn(ARTIFACT_STATUS_TOOLS,tool.name)) {
      tool.outputSchema=schemaFor(ARTIFACT_STATUS_TOOLS[tool.name]);
      tool.description='Alias of media_task_status: read creation.data, files and optional chat progress. completed requires all requested stages. Poll at pollIntervalMs; finish the response if Send waits.';
    } else if(Object.hasOwn(ARTIFACT_CANCEL_TOOLS,tool.name)) {
      tool.outputSchema={...cancelSchema,properties:{...cancelSchema.properties,task:schemaFor(ARTIFACT_CANCEL_TOOLS[tool.name])}};
      tool.description='Alias of media_task_cancel: stop creation/delivery before Send commits; preserve published files and Composer contents. Poll status until cancellation settles. Committed Send cannot be undone.';
    }
    return tool;
  });
  return [...result,
    {name:'media_task_status',title:'Check artifact task',description:'Read artifact task creation.data, files and optional chat (upload/skips/delay). One taskId covers both stages; completed requires all requested stages. Chat failure preserves created files. Poll at pollIntervalMs; finish the response if Send waits.',annotations:readAnnotations,inputSchema:taskInput,outputSchema:taskSchema},
    {name:'media_task_cancel',title:'Cancel artifact task',description:'Cancel creation/delivery before Send commits, preserving published files and Composer contents. An in-flight capture/crop/read may finish. Poll media_task_status until settled. Committed Send cannot be undone.',annotations:writeAnnotations,inputSchema:taskInput,outputSchema:cancelSchema}
  ];
}

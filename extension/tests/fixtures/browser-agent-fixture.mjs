import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createBrowserAgent,waitForBrowserDocument,waitForBrowserConversation,browserStudyGroupTitle} from '../../browser-agent.js';
import {browserToolDefinitions,BROWSER_TOOL_NAMES,validateBrowserInput} from '../../browser-tools.js';
import {assertSchema} from './schema-check.mjs';
globalThis.crypto ||= webcrypto;
const definitions=browserToolDefinitions();
const checkSchema=(name,value)=>assertSchema(definitions.find(tool=>tool.name===name).outputSchema,value,name);
const attr=value=>({value});
const ax=(nodeId,role,name,childIds=[],backendDOMNodeId=Number(nodeId)+100)=>({nodeId,role:attr(role),name:attr(name),childIds,backendDOMNodeId,ignored:false});
export const initialTree=[ax('1','RootWebArea','Site',['2']),ax('2','generic','',['3','4','5','6','7']),ax('3','heading','Article',['8']),ax('4','image','Diagram'),ax('5','textbox','Search'),ax('6','combobox','Choice'),ax('7','button','Open'),ax('8','StaticText','Detailed content',['9']),ax('9','InlineTextBox','Detailed content')];
for(const raw of initialTree)for(const child of raw.childIds)initialTree.find(node=>node.nodeId===child).parentId=raw.nodeId;
export function fixture({multipleImages=false,nonImages=false}={}){
 let nextGroup=100; let nextTab=20,tree=structuredClone(initialTree),clock=1_700_000_000_000;
 if(multipleImages){
  tree.find(node=>node.nodeId==='2').childIds.push('10','11');
  for(const id of ['10','11'])tree.push({...ax(id,'image','Additional diagram'),parentId:'2'});
 }
 if(nonImages){
  tree.find(node=>node.nodeId==='2').childIds.push('12','13','14');
  for(const [id,role] of [['12','link'],['13','audio'],['14','video']])tree.push({...ax(id,role,'Download '+role),parentId:'2'});
 }
 const media = {
  document: {mimeType:'application/pdf',ext:'pdf',bytes:Buffer.from('%PDF-1.7\nexample')},
  audio: {mimeType:'audio/mpeg',ext:'mp3',bytes:Buffer.from('ID3example')},
  video: {mimeType:'video/mp4',ext:'mp4',bytes:Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109])}
 };
 const tabs=new Map([[10,{id:10,url:'https://site.test/article?token=PRIVATE',title:'Site',active:true,index:3,windowId:2}]]);
 const messages=[],notifications=[]; const events=[],scheduled=[],uploads=[],saved=[],logs=[],domValues=new Map();let closed=false,failOriginal=false,tooLarge=false,onAttach=null,onSave=null;
 const host={now:()=>clock,sleep:async()=>{clock+=500;await new Promise(resolve=>setImmediate(resolve));},getTab:async id=>{if(!tabs.has(id))throw Error('closed');return tabs.get(id);},
 duplicateTab:async id=>{const tab={...tabs.get(id),id:++nextTab,active:false,index:4};tabs.set(tab.id,tab);events.push(['duplicate',id]);return tab;},restoreSource:async id=>events.push(['restore',id]),
 createChatTab:async(source,agent)=>{const tab={id:++nextTab,url:'https://chatgpt.com/',index:5,windowId:2,active:false};tabs.set(tab.id,tab);events.push(['createChat',source.id,agent.id]);return tab;},waitReady:async id=>events.push(['documentReady',id]),
 attach:async id=>events.push(['attach',id]),detach:async id=>events.push(['detach',id]),conversationPath:url=>url.match(/\/c\/[^/]+/)?.[0]||null,
 startChat:async(id,prompt)=>{events.push(['prompt',id,prompt]);tabs.get(id).url='https://chatgpt.com/c/study'+id;return '/c/study'+id;},
 groupTabs:async(ids,title)=>{const groupId=nextGroup++;for(const id of ids)tabs.get(id).groupId=groupId;events.push(['group',ids,title]);return groupId;}, queryTabs:async groupId=>[...tabs.values()].filter(tab=>tab.groupId===groupId),
 scheduleDelay:work=>notifications.push(work), notifyChat:async(tabId,text,options)=>{await options.beforeSend?.();options.onSendCommit?.();messages.push({tabId,text});return {sent:true};},
 updateStatus:async(ids,status)=>events.push(['toolbar',ids,structuredClone(status)]),resourceLimit:async()=>1024,resourceCountLimit:async()=>5,historyLimit:()=>2,schedule:work=>scheduled.push(work),log:(label,value)=>logs.push({label,value}),
 saveResource:async(taskId,bytes,mimeType,resourceId)=>{saved.push({taskId,bytes,mimeType,resourceId});await onSave?.();return {workspacePath:`study-this-site/${resourceId.replace(/^r_/,"res_")} [${taskId}].${Object.values(media).find(item=>item.mimeType===mimeType)?.ext || 'png'}`,mimeType,sizeBytes:bytes.length};},
 resolveFiles:async paths=>paths.map(path=>'/PRIVATE/'+path),
 attachFiles:async(files,options)=>{uploads.push({files,options});options.checkCancelled();await options.onPhase('composerAccepted');await onAttach?.(options);await options.beforeSend();options.checkCancelled();options.onSendCommit();},
 command:async(tabId,method,params={},childSessionId)=>{events.push([method,tabId,params,childSessionId]);if(closed)throw Error('detached');
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:childSessionId?'childFrame':'main',url:tabs.get(tabId)?.url}}};
  if(method==='Page.createIsolatedWorld')return {executionContextId:44};
  if(method==='Page.addScriptToEvaluateOnNewDocument')return {identifier:'overlay'};
  if(method==='Accessibility.getFullAXTree')return {nodes:structuredClone(tree)};
  if(method==='Accessibility.getPartialAXTree')return {nodes:structuredClone(tree.filter(node=>node.backendDOMNodeId===params.backendNodeId))};
  if(method==='DOM.resolveNode')return {object:{objectId:String(params.backendNodeId)}};
  if(method==='Runtime.callFunctionOn'){
   const id=Number(params.objectId),args=params.arguments.map(arg=>arg.value);
   if(nonImages && params.functionDeclaration.includes('function inspectBrowserElement') && [112,113,114].includes(id)){
    const kind=id===112?'document':id===113?'audio':'video';
    return {result:{value:{tag:id===112?'a':kind,attributes:[],bounds:{x:10,y:20,width:50,height:40},resources:[{kind,url:'https://cdn.test/'+kind+'?signature=PRIVATE',rendering:null}],editable:false,password:false}}};
   }
   if(params.functionDeclaration.includes('function inspectBrowserElement'))return {result:{value:{tag:[104,110,111].includes(id)?'img':id===105?'input':id===106?'select':'div',attributes:[],bounds:{x:10,y:20,width:50,height:40},resources:[104,110,111].includes(id)?[{kind:'image',url:'https://cdn.test/image.png?signature=PRIVATE',rendering:null}]:[],editable:id===105,password:false}}};
   if(params.functionDeclaration.includes('elementFromPoint'))return {result:{value:true}};
   if(params.functionDeclaration.includes('this.options'))return {result:{value:args[0]==='a'}};
   if(params.functionDeclaration.includes('this.value'))return {result:{value:domValues.get(id)}};
   return {result:{value:null}};
  }
  if(method==='DOM.focus'){host.focus=params.backendNodeId;return {};}
  if(method==='Input.insertText'){domValues.set(host.focus,params.text);return {};}
  if(method==='DOM.getBoxModel')return {model:{content:[10,20,60,20,60,60,10,60]}};
  if(method==='Page.getLayoutMetrics')return {cssVisualViewport:{pageX:0,pageY:0,clientWidth:800,clientHeight:600}};
  if(nonImages && method==='Network.loadNetworkResource'){
   const kind=Object.keys(media).find(kind=>params.url==='https://cdn.test/'+kind+'?signature=PRIVATE');
   if(kind)return {resource:{success:true,stream:kind,headers:{'Content-Type':media[kind].mimeType}}};
  }
  if(nonImages && method==='IO.read' && media[params.handle])return {data:media[params.handle].bytes.toString('base64'),base64Encoded:true,eof:true};
  if(method==='Network.loadNetworkResource'){if(failOriginal)throw Error('CORS');return {resource:{success:true,stream:'stream',headers:{'Content-Type':'image/png'}}};}
  if(method==='IO.read')return {data:Buffer.from(tooLarge?new Uint8Array(1025):[137,80,78,71,13,10,26,10]).toString('base64'),base64Encoded:true,eof:true};
  if(method==='Page.getResourceContent')throw Error('cache missing');
  if(method==='Page.captureScreenshot')return {data:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')};
  return {};
 }
 };
 const agent=createBrowserAgent(host);
 const run=async(name,args={})=>{const targeted=definitions.find(tool=>tool.name===name)?.inputSchema.properties.tabId;const input={chatTabId:22,...(targeted?{tabId:21}:{}),...args};const result=await agent.execute(name,input);checkSchema(name,result);return result;};
 return {agent,run,host,tabs,events,scheduled,notifications,messages,uploads,saved,logs,setTree:value=>tree=value,setOriginalFailure:()=>failOriginal=true,setTooLarge:()=>tooLarge=true,onAttach:fn=>onAttach=fn,onSave:fn=>onSave=fn};
}

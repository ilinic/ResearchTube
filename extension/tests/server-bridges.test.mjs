import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
const source=await readFile(new URL('../server-widget-bridge.js',import.meta.url),'utf8');
const nonce=randomUUID()+randomUUID();
let listener, calls=[],replies=[];
const child={postMessage:(data,origin)=>replies.push({data,origin})},window={addEventListener:(_,fn)=>{listener=fn;}};
vm.runInNewContext(source,{window,document:{querySelectorAll:()=>[{contentWindow:child}]},URL,Promise,
  chrome:{runtime:{sendMessage:async value=>{calls.push(value);return {ok:true};}}}});
const fire=(origin,value={source:'researchtube-cloud-binding',nonce},sender=child)=>listener({origin,data:value,source:sender});
fire('https://evil.test');fire('https://web-sandbox.oaiusercontent.com',{source:'researchtube-cloud-binding',nonce:'wrong'});fire('https://web-sandbox.oaiusercontent.com',undefined,{});
await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,0);
fire('null');await new Promise(resolve=>setImmediate(resolve));
assert.equal(calls.length,1);assert.equal(calls[0].type,'researchtube_server_bind');assert.equal(calls[0].nonce,nonce);
assert.equal(replies[0].data.ok,true);assert.equal(replies[0].origin,'*');
const background=await readFile(new URL('../background.js',import.meta.url),'utf8');
const start=background.indexOf('function readServerChatDocument()'),end=background.indexOf('const serverConnection =',start);
let live={id:7,url:'https://chatgpt.com/c/saved-chat'},copies=[live],doc='top-document';
const context={URL,location:{origin:'https://chatgpt.com',pathname:'/c/saved-chat'},
  chatConversationPath:url=>new URL(url).pathname,localAgentError:(code,message)=>Object.assign(Error(message),{code}),
  chrome:{tabs:{get:async()=>live,query:async()=>copies},scripting:{executeScript:async()=>[{frameId:0,documentId:doc,result:{conversationId:'saved-chat'}},{frameId:2,documentId:'wrong-frame',result:{conversationId:'saved-chat'}}]}}};
vm.runInNewContext(background.slice(start,end),context);
assert.deepEqual(JSON.parse(JSON.stringify(await context.serverChatIdentity(7))),{tabId:7,documentId:'top-document',conversationId:'saved-chat'});
copies=[live,{...live,id:9}];await assert.rejects(context.serverChatIdentity(7),/duplicate tabs/);copies=[live];doc=null;
await assert.rejects(context.serverChatIdentity(7),/document changed/);
const enrollment=await readFile(new URL('../server-enrollment-bridge.js',import.meta.url),'utf8');
assert.doesNotMatch(enrollment,/postMessage\s*\(|installationToken/);
assert.match(background,/sender.frameId!==0/);
assert.match(background,/sender.tab\?\.id!==pending\?\.tabId/);
assert.match(background,/documentIds:\[sender.documentId\]/);
console.log('Server bridges: exact iframe/source/origin, Chrome top document, duplicate chat rejection and private enrollment passed');
// Exercise enrollment sender/nonce checks and Chrome's private injection result.
const extensionId='a'.repeat(32), enrollmentNonce=randomUUID()+randomUUID(), token=randomUUID()+randomUUID();
let enrollmentConfig={connectionMode:'server',serverEnrollment:{nonce:enrollmentNonce,tabId:9,expiresAt:Date.now()+60000}}, injections=0;
const enrollmentContext={URL,Date,AbortSignal,updateConnection:async fn=>fn(),SERVER_ORIGIN:'https://rtube.win',getConfig:async()=>enrollmentConfig,
  localAgentError:(code,message)=>Object.assign(Error(message),{code}),
  serverConnection:{stop:async()=>{},connect:async()=>({ok:true}),api:async()=>{}},
  chrome:{runtime:{id:extensionId},storage:{local:{set:async value=>Object.assign(enrollmentConfig,value)}},
    scripting:{executeScript:async options=>{injections++;assert.deepEqual(JSON.parse(JSON.stringify(options.target)),{tabId:9,documentIds:['setup-document']});return [{documentId:'setup-document',result:{ok:true,installationId:randomUUID(),installationToken:token}}];}}}};
const begin=background.indexOf('async function enrollServerProfile('),finish=background.indexOf('\nasync function getConfig()',begin);
vm.runInNewContext('let serverEnrollmentRunning=false;\n'+background.slice(begin,finish),enrollmentContext);
const setupSender={id:extensionId,tab:{id:9},frameId:0,documentId:'setup-document',url:'https://rtube.win/connect-extension?extensionId='+extensionId+'&nonce='+enrollmentNonce};
for(const sender of [{...setupSender,id:'foreign'},{...setupSender,frameId:2},{...setupSender,tab:{id:10}},{...setupSender,url:'https://evil.test/connect-extension'}])
  await assert.rejects(enrollmentContext.enrollServerProfile({nonce:enrollmentNonce},sender));
await assert.rejects(enrollmentContext.enrollServerProfile({nonce:'wrong'},setupSender));assert.equal(injections,0);
const connected=await enrollmentContext.enrollServerProfile({nonce:enrollmentNonce},setupSender);
assert.equal(connected.ok,true);assert.equal(injections,1);assert.equal(enrollmentConfig.serverInstallationToken,token);assert.equal(enrollmentConfig.serverEnrollment,null);
assert.ok(!JSON.stringify(connected).includes(token));
await assert.rejects(enrollmentContext.enrollServerProfile({nonce:enrollmentNonce},setupSender));assert.equal(injections,1,'consumed setup cannot enroll twice');
console.log('Server enrollment: exact sender, origin, nonce, private document result and one-use registration passed');

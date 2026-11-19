// Manual Windows/Chromium integration, isolated profile and local workerd only.
// No requests are sent to production, Google, ChatGPT or the user's browser.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { start, seedSession, post, doRoom, roomPost } from './helpers.mjs';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.RESEARCHTUBE_PLAYWRIGHT_MODULE||'playwright');
const { WebSocketServer }=require('ws');
const ROOT='https://rtube.win',ID='jnnhjpkdhmghpbgfcalbhmkagdeelgnp',EXT='chrome-extension://'+ID;
const profile=await mkdtemp(join(tmpdir(),'researchtube-chrome-integration-'));
const extension=fileURLToPath(new URL('../../extension/',import.meta.url));
let browser,mf,proxy;const serverSockets=[];const failures=[];
try {
 const runtime=await start({PUBLIC_ORIGIN:ROOT,EXTENSION_ORIGINS:JSON.stringify([EXT])});mf=runtime.mf;
 const account=await seedSession(runtime.db),room=await doRoom(mf,account.userId);

 // Playwright does not intercept extension service-worker fetch/WebSockets.
 // Route only those transports to a loopback proxy of the real local Worker.
 proxy=createServer(async(request,response)=>{
  try{
   const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>1048576)throw Error('Test request too large');chunks.push(chunk);}
   const result=await mf.dispatchFetch(ROOT+request.url,{method:request.method,headers:{...request.headers,Cookie:account.cookie},
    ...(!['GET','HEAD'].includes(request.method)?{body:Buffer.concat(chunks)}:{})});
   response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.from(await result.arrayBuffer()));
  }catch(error){failures.push(error.message);response.writeHead(502);response.end();}
 });
 const upgrades=new WebSocketServer({noServer:true});
 proxy.on('upgrade',async(request,network,head)=>{
  try{
   const response=await mf.dispatchFetch(ROOT+request.url,{headers:{Upgrade:'websocket',Origin:EXT}});
   assert.equal(response.status,101);const socket=response.webSocket;socket.accept();serverSockets.push(socket);
   upgrades.handleUpgrade(request,network,head,client=>{
    client.on('message',(data,binary)=>socket.send(binary?data.buffer:data.toString()));
    socket.addEventListener('message',event=>{if(client.readyState===1)client.send(event.data);});
    client.on('close',()=>{try{socket.close();}catch{}});socket.addEventListener('close',()=>client.close());
   });
  }catch(error){failures.push(error.message);network.destroy();}
 });
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const proxyOrigin='http://127.0.0.1:'+proxy.address().port;
 browser=await chromium.launchPersistentContext(profile,{channel:process.env.RESEARCHTUBE_BROWSER_CHANNEL||'msedge',headless:true,
  ignoreDefaultArgs:['--disable-extensions'],args:['--disable-extensions-except='+extension,'--load-extension='+extension,
    '--host-resolver-rules=MAP rtube.win 127.0.0.1, MAP chatgpt.com 127.0.0.1, MAP *.web-sandbox.oaiusercontent.com 127.0.0.1, MAP www.youtube.com 127.0.0.1']});
 await browser.route('**/*',async route=>{
  try{
   const request=route.request(),url=new URL(request.url());
   if(url.protocol==='chrome-extension:')return route.continue();
   if(url.origin===proxyOrigin)return route.continue();
   if(url.origin===ROOT){
    const headers=await request.allHeaders();headers.Cookie=account.cookie;
    const response=await mf.dispatchFetch(request.url(),{method:request.method(),headers,
      ...(request.postDataBuffer()?{body:request.postDataBuffer()}:{}),redirect:'manual'});
    return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
   }
   if(url.origin==='https://web-sandbox.oaiusercontent.com') return route.fulfill({contentType:'text/html',body:await readFile(new URL('../../extension/ui/chat-target-v1.html',import.meta.url),'utf8')});
   if(url.origin==='https://chatgpt.com')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Simulated ChatGPT host</title><p>Test conversation</p>'});
   if(url.origin==='https://www.youtube.com')return route.fulfill({contentType:'text/html',body:`<!doctype html><title>Simulated public YouTube</title><script>
    addEventListener('message',event=>{
      const value=event.data;
      if(event.source!==window||!value?.source?.startsWith('researchtube-extension-content:')||value.type!=='command')return;
      if(value.action==='bridge-version')return;
      event.stopImmediatePropagation();
      const data=value.action==='transcript-player'?{videoId:value.payload.videoId,selectedTrack:{trackIndex:0,languageCode:'en',name:'English',isAutoGenerated:false},segments:[{start:0,duration:2,text:'Native direct transcript'}],returned:1,requested:value.payload.limit}:{responses:[]};
      window.postMessage({source:value.source.replace('researchtube-extension-content:','researchtube-page-bridge:'),type:'command-result',payload:{id:value.id,ok:true,data}},location.origin);
    },true);
   </script>`});
   return route.abort();
  }catch(error){failures.push(error.message);await route.abort().catch(()=>{});}
 });
 const worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker',{timeout:15000});
 assert.equal(new URL(worker.url()).host,ID);
 await worker.evaluate(proxyOrigin=>{
  const nativeFetch=globalThis.fetch.bind(globalThis),NativeWebSocket=globalThis.WebSocket;
  // Isolated test identity; never touches the user's Chrome profile.
  chrome.identity.getProfileUserInfo=async()=>({id:'native-test-google-account',email:'test@example.test'});
  globalThis.fetch=async(url,options)=>{
   try{const response=await nativeFetch(String(url).replace('https://rtube.win',proxyOrigin),options);globalThis.__integrationFetch={path:new URL(url).pathname,status:response.status};return response;}
   catch(error){globalThis.__integrationFetch={path:new URL(url).pathname,error:error.name};throw error;}
  };
  globalThis.WebSocket=class extends NativeWebSocket{constructor(url,...options){super(String(url).replace('wss://rtube.win',proxyOrigin.replace(/^http:/,'ws:')),...options);}};
 },proxyOrigin);
 await worker.evaluate(()=>chrome.runtime.onMessageExternal.addListener((message,sender)=>{
   globalThis.__integrationSender={type:message.type,hasId:Boolean(sender.id),frameId:sender.frameId??null,tabId:sender.tab?.id??null,
     origin:sender.origin||null,path:sender.url?new URL(sender.url).pathname:null};
 }));
 await worker.evaluate(()=>chrome.runtime.onMessage.addListener(message=>{globalThis.__integrationInternal=message.type;}));
 const settings=await browser.newPage();await settings.goto(EXT+'/settings.html');
 await settings.locator('#agent-port').waitFor({state:'visible'});
 assert.equal(await settings.locator('#connection-mode, #legacy-connection').count(),0);
 const chat=await browser.newPage();await chat.goto('https://chatgpt.com/c/native-integration');
 const accountPage=await browser.newPage();await accountPage.goto(ROOT+'/account');
 await chat.bringToFront();
 await settings.waitForFunction(async()=> (await chrome.runtime.sendMessage({type:'status',includeAgent:false})).cloud.state==='ready',null,{timeout:30000});
 const active=await settings.evaluate(()=>chrome.tabs.query({active:true,currentWindow:true}));
 assert.equal(active[0].url,'https://chatgpt.com/c/native-integration','automatic enrollment must not steal focus');
 for(let attempt=0;attempt<20&&browser.pages().some(page=>page.url().startsWith(ROOT+'/setup?'));attempt++)await chat.waitForTimeout(100);
 assert.equal(browser.pages().some(page=>page.url().startsWith(ROOT+'/setup?')),false);
 assert.equal(await chat.locator('iframe').count(),0,'no connection widget in the chat');
 console.log('Automatic enrollment: native external messaging, existing sign-in, no Settings click or chat widget');
 const chatSession='a'.repeat(64);
 const run=async(name,args={},key=chatSession)=>(await roomPost(room,'/dispatch',{workerReceivedAtMs:Date.now(),request:{jsonrpc:'2.0',method:'tools/call',params:{name,arguments:args,chatSession:key}}})).json();
 const youtube=await browser.newPage();await youtube.goto('https://www.youtube.com/');await chat.bringToFront();
 const transcript=await run('youtube_get_transcript',{videoId:'aqz-KE-bpKQ',limit:10});
 assert.equal(transcript.result?.structuredContent?.segments?.[0]?.text,'Native direct transcript',JSON.stringify(transcript));
 assert.notEqual(transcript.result?.isError,true);
 console.log('First productive transcript: real Extension dispatcher, native YouTube content bridge, no chat preflight or binding');
 const tabs=await settings.evaluate(()=>chrome.tabs.query({}));
 const chatId=tabs.find(tab=>tab.url==='https://chatgpt.com/c/native-integration').id;
 const youtubeId=tabs.find(tab=>tab.url?.startsWith('https://www.youtube.com/')).id;
 await settings.evaluate(ids=>chrome.tabs.group({tabIds:ids}),[chatId,youtubeId]);
 const unbound=await run('site_list_tabs');
 assert.equal(unbound.result.structuredContent.error.code,'BROWSER_CONTEXT_REQUIRED');
 const connect=async()=>{
  const started=await run('system_get_chat_context');
  assert.equal(started.result.structuredContent.status,'working',JSON.stringify(started));
  const metadata=started.result._meta;
  // A forged settings-page message has no sender.tab and cannot claim a chat.
  const forged=await settings.evaluate(metadata=>chrome.runtime.sendMessage({type:'researchtube_chat_target_bind',...metadata['researchtube/chatTarget']}),metadata);
  assert.equal(forged.ok,false);
  await chat.evaluate(()=>{const frame=document.createElement('iframe');frame.id='binding';frame.src='https://web-sandbox.oaiusercontent.com/binding';document.body.append(frame);});
  await chat.frameLocator('#binding').locator('#status').waitFor();
  await chat.evaluate(metadata=>document.querySelector('#binding').contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{_meta:metadata}},'*'),metadata);
  try { await chat.frameLocator('#binding').getByText('Connected to this chat.',{exact:true}).waitFor({timeout:10000}); }
  catch(error) {
    console.log('Binding diagnostic',await chat.frameLocator('#binding').locator('#status').textContent(), JSON.stringify(await run('system_chat_context_status',{taskId:started.result.structuredContent.taskId})), JSON.stringify(await run('system_get_diagnostics',{limit:5})),await worker.evaluate(()=>globalThis.__integrationInternal));
    throw error;
  }
  const status=await run('system_chat_context_status',{taskId:started.result.structuredContent.taskId});
  assert.equal(status.result.structuredContent.status,'completed',JSON.stringify(status));
  assert.equal(status.result._meta,undefined,'polling has no widget metadata');
 };
 await connect();
 const group=await run('site_list_tabs');
 assert.equal(group.result?.structuredContent?.chatTabId,chatId,JSON.stringify(group));
 const reused=await run('site_list_tabs');
 assert.equal(reused.result?.structuredContent?.chatTabId,chatId);
 assert.equal(await chat.locator('iframe').count(),1,'productive tools reuse binding without adding widgets');
 const foreign=await run('site_list_tabs',{},'b'.repeat(64));
 assert.equal(foreign.result.structuredContent.error.code,'BROWSER_CONTEXT_REQUIRED','another conversation cannot reuse the target');
 await chat.reload();
 const afterReload=await run('site_list_tabs');
 assert.equal(afterReload.result.structuredContent.error.code,'BROWSER_CONTEXT_REQUIRED','reload invalidates the old document');
 await connect();
 const rebound=await run('site_list_tabs');
 assert.equal(rebound.result?.structuredContent?.chatTabId,chatId,JSON.stringify(rebound));
 console.log('Lazy binding: real iframe sender, no forged tab, session isolation, reuse and document reload rebind');
 const missing=await run('media_view',{files:[{workspacePath:'test.png'}]},'c'.repeat(64));
 assert.equal(missing.result.structuredContent.error.code,'BROWSER_CONTEXT_REQUIRED');
 const stored=await settings.evaluate(()=>chrome.storage.local.get('researchtubeCloudCredential'));
 const installationId=stored.researchtubeCloudCredential.installationId;
 const replacement=await mf.dispatchFetch(ROOT+'/api/installations',post({name:'Replacement extension',extensionOrigin:EXT},{Cookie:account.cookie,Origin:ROOT}));
 assert.equal(replacement.status,201);
 await settings.waitForFunction(async()=> (await chrome.runtime.sendMessage({type:'status',includeAgent:false})).cloud.errorCode==='EXTENSION_REPLACED',null,{timeout:10000});
 assert.equal(await settings.evaluate(()=>chrome.action.getBadgeText({})),String.fromCharCode(215));
 assert.equal(await settings.evaluate(tabId=>chrome.action.getBadgeText({tabId}),chatId),String.fromCharCode(215),'connection error overrides the Site AUTO badge');
 const popup=await browser.newPage();await popup.goto(EXT+'/popup.html');
 await popup.getByText('Disconnected',{exact:true}).waitFor();
 await settings.evaluate(()=>chrome.alarms.create('public-relay',{when:Date.now()+1}));await settings.waitForTimeout(500);
 assert.equal((await settings.evaluate(()=>chrome.runtime.sendMessage({type:'status',includeAgent:false}))).cloud.errorCode,'EXTENSION_REPLACED');
 const credentialCheck=await mf.dispatchFetch(ROOT+'/api/installation/check',post({},{Authorization:'Bearer '+stored.researchtubeCloudCredential.installationToken,Origin:EXT}));
 assert.equal(credentialCheck.status,401);
 assert.deepEqual(failures,[]);
 console.log('Replacement: native red badge and popup status, revoked credential, no automatic takeover; all traffic stayed local');
} finally {
 await browser?.close();for(const socket of serverSockets){try{socket.close();}catch{}}
 await mf?.dispose();
 proxy?.closeAllConnections();await new Promise(resolve=>proxy?proxy.close(resolve):resolve());
 if(dirname(profile)!==resolve(tmpdir())||!basename(profile).startsWith('researchtube-chrome-integration-'))throw Error('Unexpected integration-test directory');
 await rm(profile,{recursive:true,force:true});
}

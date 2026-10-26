// Manual Windows/Chromium integration, isolated profile and local workerd only.
// No requests are sent to production, Google, ChatGPT or the user's browser.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
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
 const session='native-browser-integration';
 let widget='';
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
    '--host-resolver-rules=MAP rtube.win 127.0.0.1, MAP chatgpt.com 127.0.0.1, MAP *.web-sandbox.oaiusercontent.com 127.0.0.1']});
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
   if(url.origin==='https://chatgpt.com')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Simulated ChatGPT host</title><iframe src="https://test.web-sandbox.oaiusercontent.com/widget"></iframe>'});
   if(url.origin==='https://test.web-sandbox.oaiusercontent.com')return route.fulfill({contentType:'text/html',body:widget||'<!doctype html>Waiting for test widget'});
   return route.abort();
  }catch(error){failures.push(error.message);await route.abort().catch(()=>{});}
 });
 const worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker',{timeout:15000});
 assert.equal(new URL(worker.url()).host,ID);
 await worker.evaluate(proxyOrigin=>{
  const nativeFetch=globalThis.fetch.bind(globalThis),NativeWebSocket=globalThis.WebSocket;
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
 const resources=await (await mf.dispatchFetch(ROOT,post({jsonrpc:'2.0',id:1,method:'resources/list'},{Accept:'application/json, text/event-stream'}))).json();
 const uri=resources.result.resources.find(resource=>resource.name==='ResearchTube Chrome connection').uri;
 const resource=await (await mf.dispatchFetch(ROOT,post({jsonrpc:'2.0',id:2,method:'resources/read',params:{uri}},{Accept:'application/json, text/event-stream'}))).json();
 const challenge=await (await roomPost(room,'/challenge',{session})).json();
 widget=resource.result.contents[0].text.replace('<script>','<script>window.openai='+JSON.stringify({toolResponseMetadata:{'researchtube/cloudBinding':{nonce:challenge.nonce}}})+';');
 const chat=await browser.newPage();await chat.goto('https://chatgpt.com/c/native-integration');
 try { await chat.frameLocator('iframe').getByText('This Chrome chat is connected.',{exact:true}).waitFor({timeout:20000}); }
 catch {
  const helper=browser.pages().find(page=>page.url().startsWith(ROOT+'/setup?'));
  throw Error('Automatic pairing failed: '+await chat.frameLocator('iframe').locator('#status').innerText()+
   '; helper='+(helper?await helper.locator('#status').innerText():'closed')+'; diagnostics='+
   JSON.stringify(await worker.evaluate(async()=>({sender:globalThis.__integrationSender,fetch:globalThis.__integrationFetch,internal:globalThis.__integrationInternal,
     tabs:(await chrome.tabs.query({})).map(tab=>({path:tab.url?new URL(tab.url).pathname:null,pending:tab.pendingUrl?new URL(tab.pendingUrl).pathname:null})),
     enrollment:Boolean((await chrome.storage.session.get('researchtubeCloudEnrollment')).researchtubeCloudEnrollment)}))));
 }
 assert.equal((await settings.evaluate(()=>chrome.runtime.sendMessage({type:'status',includeAgent:false}))).cloud.state,'ready');
 const active=await settings.evaluate(()=>chrome.tabs.query({active:true,currentWindow:true}));
 assert.equal(active[0].url,'https://chatgpt.com/c/native-integration','automatic enrollment must not steal focus');
 for(let attempt=0;attempt<20&&browser.pages().some(page=>page.url().startsWith(ROOT+'/setup?'));attempt++)await chat.waitForTimeout(100);
 assert.equal(browser.pages().some(page=>page.url().startsWith(ROOT+'/setup?')),false,'automatic setup helper closes after acknowledgement');
 console.log('Automatic pairing: existing browser session, native external messaging, no Settings click, no profile confirmation, no focus change');
 const result=await (await roomPost(room,'/dispatch',{session,
  request:{jsonrpc:'2.0',method:'tools/call',params:{name:'system_get_diagnostics',arguments:{}}}})).json();
 assert.ok(result.result?.structuredContent);assert.equal(result.error,undefined);
 console.log('Native sandbox widget: productive dispatch uses the conversation directly, without a status call or model-supplied binding ID');
 await chat.reload();
 await chat.waitForTimeout(500);
 const moved=await (await roomPost(room,'/status',{session})).json();assert.equal(moved.connected,false);
 assert.equal(moved.bindings.length,0);
 console.log('Navigation: old binding released; historical widget cannot restore authority');
 const stored=await settings.evaluate(()=>chrome.storage.local.get('researchtubeCloudCredential'));
 const installationId=stored.researchtubeCloudCredential.installationId;
 const revoked=await mf.dispatchFetch(ROOT+'/api/installations/'+installationId,{method:'DELETE',headers:{Cookie:account.cookie,Origin:ROOT}});
 assert.equal(revoked.status,200);
 const credentialCheck=await mf.dispatchFetch(ROOT+'/api/installation/check',post({},{Authorization:'Bearer '+stored.researchtubeCloudCredential.installationToken,Origin:EXT}));
 assert.equal(credentialCheck.status,401);
 assert.deepEqual(failures,[]);
 console.log('Revocation: server credential rejected; all test traffic stayed inside local workerd');
} finally {
 await browser?.close();for(const socket of serverSockets){try{socket.close();}catch{}}
 await mf?.dispose();
 proxy?.closeAllConnections();await new Promise(resolve=>proxy?proxy.close(resolve):resolve());
 if(dirname(profile)!==resolve(tmpdir())||!basename(profile).startsWith('researchtube-chrome-integration-'))throw Error('Unexpected integration-test directory');
 await rm(profile,{recursive:true,force:true});
}

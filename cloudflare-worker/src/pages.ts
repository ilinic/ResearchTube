import { origin, type Env } from "./types";
import { WORKER_VERSION } from "./version";

const style = "body{font:17px/1.5 system-ui,sans-serif;max-width:620px;margin:64px auto;padding:0 24px;color:#1f2937;background:#fff}button{font:inherit;padding:10px 18px;margin:8px 8px 8px 0;cursor:pointer}small{color:#4b5563}#status{white-space:pre-wrap}";
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function page(kind: "sign-in" | "consent" | "account" | "setup", env: Env): Response {
  const providers = [env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? "google" : null,
    env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET ? "microsoft" : null].filter(Boolean);
  const signIn = `${providers.map(provider => `<button data-provider="${provider}">Continue with ${provider === "google" ? "Google" : "Microsoft"}</button>`).join("")}${providers.length ? "" : "<p>Sign-in is not configured yet. The server administrator must configure Google or Microsoft.</p>"}`;
  const setup = `<h1>Connect your Chrome extension</h1><p id="account-state">Checking your ResearchTube account…</p><div id="setup-sign-in" hidden>${signIn}</div><ol><li>First add <strong>${escape(origin(env))}</strong> in <a href="https://chatgpt.com/plugins" target="_blank" rel="noreferrer">ChatGPT Plugins</a> → Add custom MCP server. Choose OAuth and complete sign-in.</li><li>Download the <a href="https://github.com/ilinic/ResearchTube/releases" target="_blank" rel="noreferrer">ResearchTube release</a>, extract it, then load its <code>extension</code> folder in Chrome Extensions → Developer mode → Load unpacked.</li><li>Return to your saved ChatGPT conversation in Chrome and ask ResearchTube to connect this chat.</li></ol><button id="connect-extension" hidden>Connect this Chrome profile</button><p>The Local Agent is optional and adds local files and media processing. Mobile execution and cloud transcripts are not available.</p><a href="https://github.com/ilinic/ResearchTube/blob/main/docs/INSTALLATION.md" target="_blank" rel="noreferrer">Installation guide</a>`;
  const body = kind === "sign-in" ? `<h1>Sign in to ResearchTube</h1><p>Connect your ResearchTube account to ChatGPT first. You can install the Chrome extension afterwards.</p>${signIn}`
    : kind === "consent" ? '<h1>Connect ResearchTube to ChatGPT</h1><p>Allow ChatGPT to use ResearchTube with the Chrome extensions you connect to this account, including available browser and local media operations? You can install and connect an extension after completing this step.</p><p id="scopes"></p><button id="allow">Allow</button><button id="deny">Cancel</button>'
    : kind === "setup" ? setup
    : '<h1>ResearchTube account connected</h1><p>Return to ChatGPT to continue. Next, install and connect your Chrome extension.</p><p><a href="/setup">Set up the Chrome extension</a></p><button id="sign-out">Sign out</button>';
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ResearchTube</title><style>${style}</style></head><body data-page="${escape(kind)}">${body}<p id="status" role="status"></p><script src="/auth-ui.js" defer></script></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" }
  });
}
export function authScript(): Response {
  return new Response(String.raw`
const status=document.getElementById('status');
async function send(path,body){
  const controller=new AbortController();let timer;
  const request=(async()=>{
    const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'same-origin',redirect:'error',signal:controller.signal});
    let v;try{v=await r.json();}catch{throw Error('The server returned an invalid response (HTTP '+r.status+').');}
    if(!r.ok){
      const candidate=v?.error?.code||v?.code;
      const code=typeof candidate==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(candidate)?'; '+candidate:'';
      const error=Error('Authentication failed (HTTP '+r.status+code+'). Please try again.');
      if(typeof candidate==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(candidate))error.code=candidate;
      throw error;
    }
    return v;
  })();
  try{return await Promise.race([request,new Promise((_,reject)=>{
    timer=setTimeout(()=>{reject(Error('Authentication timed out. Please try again.'));controller.abort();},25000);
  })]);}finally{clearTimeout(timer);}
}
function redirect(value){
  if(typeof value?.url!=='string'||!value.url)throw Error('The server did not return a sign-in redirect. Please try again.');
  let url;try{url=new URL(value.url,location.origin);}catch{throw Error('The server returned an invalid redirect.');}
  if(url.username||url.password||(url.protocol!=='https:'&&!(url.protocol==='http:'&&url.origin===location.origin)))throw Error('The server returned an invalid redirect.');
  location.assign(url.href);
}
async function submit(button,action){
  button.disabled=true;status.textContent='Connecting…';
  try{await action();}catch(error){
    status.textContent=error instanceof TypeError?'Unable to reach the authentication server. Please try again.':error.message;
    button.disabled=false;
  }
}
document.querySelectorAll('[data-provider]').forEach(button=>button.onclick=()=>submit(button,async()=>{
  const setup=document.body?.dataset?.page==='setup';
  const callbackURL=setup?location.origin+'/setup'+location.search:location.search?location.origin+'/api/auth/oauth2/authorize'+location.search:location.origin+'/account';
  redirect(await send('/api/auth/sign-in/social',{provider:button.dataset.provider,callbackURL,disableRedirect:true}));
}));
const scopes=document.getElementById('scopes');if(scopes)scopes.textContent='Requested permissions: '+(new URLSearchParams(location.search).get('scope')||'ResearchTube tools');
for(const id of ['allow','deny']){const button=document.getElementById(id);if(button)button.onclick=()=>submit(button,async()=>{
  redirect(await send('/api/auth/oauth2/consent',{accept:id==='allow',oauth_query:location.search.slice(1)}));
});}
const out=document.getElementById('sign-out');if(out)out.onclick=()=>submit(out,async()=>{await send('/api/auth/sign-out',{});location.assign('/sign-in');});
const connect=document.getElementById('connect-extension');
if(connect){
 let automaticMode=false;
 const params=new URLSearchParams(location.search),extensionId=params.get('extensionId'),nonce=params.get('nonce');
 const valid=/^[a-p]{32}$/.test(extensionId||'')&&/^[a-f0-9-]{36}$/.test(nonce||'');
 const external=message=>new Promise((resolve,reject)=>{
   if(!globalThis.chrome?.runtime?.sendMessage){reject(Error('Open this setup page in desktop Chrome with ResearchTube Extension.'));return;}
   const timer=setTimeout(()=>reject(Error('The extension did not respond. Reconnect this chat in ChatGPT.')),20000);
   chrome.runtime.sendMessage(extensionId,message,response=>{
     clearTimeout(timer);
     if(chrome.runtime.lastError||!response?.ok){
       const code=/^[A-Z][A-Z0-9_]{0,63}$/.test(response?.errorCode||'')?' ('+response.errorCode+')':'';
       reject(Error('The extension connection expired or was refused'+code+'. Reconnect this chat in ChatGPT.'));
     }
     else resolve(response);
   });
 });
 fetch('/api/setup',{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(25000)}).then(async r=>{
   if(!r.ok)throw Error('Account status is unavailable. Reload this page.');
   const account=await r.json();
   const ready=valid?await external({type:'researchtube_setup_ready',nonce}):null;
   automaticMode=ready?.automatic===true;
   if(automaticMode){
     if(!account.signedIn)throw Object.assign(Error('Sign in to ResearchTube in this Chrome profile, then reconnect the chat.'),{code:'BROWSER_SIGN_IN_REQUIRED'});
     await performConnection(ready);
     return;
   }
   document.getElementById('account-state').textContent=account.signedIn?'Signed in as '+(account.email||account.name||'your ResearchTube account')+'. Confirm this is the account connected in ChatGPT.':'Sign in with the same account you connected in ChatGPT.';
   document.getElementById('setup-sign-in').hidden=account.signedIn;
   connect.hidden=!account.signedIn||!valid;
   if(account.signedIn){
     const listed=await fetch('/api/installations',{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(15000)});
     if(!listed.ok)throw Error('Connected profiles are unavailable. Reload this page.');
     const value=await listed.json();
     const section=document.createElement('section'),heading=document.createElement('h2');heading.textContent='Connected Chrome profiles';section.append(heading);
     for(const installation of value.installations||[]){
       const row=document.createElement('p'),label=document.createElement('span'),remove=document.createElement('button');
       label.textContent=installation.name+' ';remove.textContent='Revoke access';
       remove.onclick=()=>submit(remove,async()=>{
         const response=await fetch('/api/installations/'+encodeURIComponent(installation.installationId),{method:'DELETE',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(15000)});
         if(!response.ok)throw Error('Could not revoke this profile. Try again.');
         row.remove();status.textContent='Profile access revoked.';
       });
       row.append(label,remove);section.append(row);
     }
     document.body.append(section);
   }
 }).catch(async error=>{
   status.textContent=error.message;
   if(automaticMode)await external({type:'researchtube_setup_failed',nonce,errorCode:error.code||'CLOUD_UNAVAILABLE'}).catch(()=>{});
 });
 async function performConnection(ready){
   const credential=await send('/api/installations',{name:'Chrome profile',extensionOrigin:ready.extensionOrigin,...(ready.automatic?{pairingNonce:ready.pairingNonce}:{})});
   try{await external({type:'researchtube_setup_complete',nonce,...credential});}
   catch(error){await fetch('/api/installations/'+encodeURIComponent(credential.installationId),{method:'DELETE',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(10000)}).catch(()=>{});throw error;}
   status.textContent='Extension paired. Return to your saved ChatGPT conversation in Chrome and ask ResearchTube to connect this chat.';
   connect.hidden=true;
 }
 connect.onclick=()=>submit(connect,async()=>performConnection(await external({type:'researchtube_setup_ready',nonce})));
}

`, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export function bindingWidget(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font:13px system-ui,sans-serif;margin:8px;color:#555}</style></head><body><span id="status" role="status">Connecting this Chrome chat…</span><script>
(()=>{
 const source='researchtube-cloud-binding', status=document.getElementById('status');
 const seen=new Set(); let timer=null,deadline=Date.now()+30000,current=null;
 function consume(value){
   const candidates=[value,value?._meta,value?.call_tool_result?._meta,value?.mcp_tool_result?._meta,value?.call_tool_result?.result?._meta,value?.mcp_tool_result?.result?._meta];
   for(const c of candidates){const binding=c?.['researchtube/cloudBinding'];
     if(binding&&typeof binding.nonce==='string'&&/^[a-f0-9-]{72}$/.test(binding.nonce)&&!seen.has(binding.nonce)){
       seen.add(binding.nonce);current=binding;deadline=Date.now()+30000;status.textContent='Connecting this Chrome chat…';start();break;
     }
   }
 }
 function announce(){consume(window.openai?.toolResponseMetadata);if(!current)return;
   if(Date.now()>deadline){clearInterval(timer);timer=null;status.textContent='Open Chrome with the ResearchTube extension and reconnect.';return;}
   window.parent.postMessage({source,nonce:current.nonce},'*');
 }
 function start(){if(timer===null)timer=setInterval(announce,500);}
 window.addEventListener('openai:set_globals',e=>consume(e.detail?.globals?.toolResponseMetadata));
 window.addEventListener('message',e=>{if(e.source!==parent)return;const v=e.data;
   if(v?.source===source&&v.nonce===current?.nonce&&v.type==='result'){
     clearInterval(timer);timer=null;
     status.textContent=v.ok?'This Chrome chat is connected.':v.errorCode==='BROWSER_SIGN_IN_REQUIRED'?'Sign in to ResearchTube in this Chrome profile, then reconnect this chat.':v.errorCode==='BROWSER_ACCOUNT_MISMATCH'?'This browser and the ChatGPT connection use different ResearchTube accounts, or this challenge expired. Sign in to the matching account and reconnect.':v.errorCode==='BROWSER_CONTEXT_AMBIGUOUS'?'Close duplicate copies of this conversation and reconnect.':'ResearchTube could not connect this browser. Check the extension and reconnect this chat.';
   }
   if(v?.method==='ui/notifications/tool-result')consume(v.params);
   if(v?.id==='rt-cloud-init'&&v.result)parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');
   if(v?.method==='ui/resource-teardown'){clearInterval(timer);timer=null;parent.postMessage({jsonrpc:'2.0',id:v.id,result:{}},'*');}
 });
 parent.postMessage({jsonrpc:'2.0',id:'rt-cloud-init',method:'ui/initialize',params:{appInfo:{name:'researchtube-cloud',version:'${WORKER_VERSION}'},appCapabilities:{},protocolVersion:'2026-01-26'}},'*');
 consume(window.openai?.toolResponseMetadata);start();
})();
</script></body></html>`;
}

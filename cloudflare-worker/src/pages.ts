import { type Env } from "./types";
import { WORKER_VERSION } from "./version";

const style = "body{font:17px/1.5 system-ui,sans-serif;max-width:620px;margin:64px auto;padding:0 24px;color:#1f2937;background:#fff}button{font:inherit;padding:10px 18px;margin:8px 8px 8px 0;cursor:pointer}small{color:#4b5563}#status{white-space:pre-wrap}";
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function page(kind: "sign-in" | "consent" | "account", env: Env): Response {
  const providers = [env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? "google" : null,
    env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET ? "microsoft" : null].filter(Boolean);
  const body = kind === "sign-in" ? `<h1>Sign in to ResearchTube</h1><p>Connect ChatGPT to your ResearchTube extension in Chrome.</p>${providers.map(provider => `<button data-provider="${provider}">Continue with ${provider === "google" ? "Google" : "Microsoft"}</button>`).join("")}${providers.length ? "" : "<p>Sign-in is not configured yet. The server administrator must configure Google or Microsoft.</p>"}`
    : kind === "consent" ? '<h1>Connect ResearchTube</h1><p>Allow this application to use ResearchTube tools in your connected Chrome profile, including browser research and available local media operations?</p><p id="scopes"></p><button id="allow">Allow</button><button id="deny">Cancel</button>'
    : '<h1>ResearchTube</h1><p>You are signed in. Continue setup in the ResearchTube Chrome extension.</p><button id="sign-out">Sign out</button>';
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
      throw Error('Authentication failed (HTTP '+r.status+code+'). Please try again.');
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
  const callbackURL=location.search?location.origin+'/api/auth/oauth2/authorize'+location.search:location.origin+'/account';
  redirect(await send('/api/auth/sign-in/social',{provider:button.dataset.provider,callbackURL,disableRedirect:true}));
}));
const scopes=document.getElementById('scopes');if(scopes)scopes.textContent='Requested permissions: '+(new URLSearchParams(location.search).get('scope')||'ResearchTube tools');
for(const id of ['allow','deny']){const button=document.getElementById(id);if(button)button.onclick=()=>submit(button,async()=>{
  redirect(await send('/api/auth/oauth2/consent',{accept:id==='allow',oauth_query:location.search.slice(1)}));
});}
const out=document.getElementById('sign-out');if(out)out.onclick=()=>submit(out,async()=>{await send('/api/auth/sign-out',{});location.assign('/sign-in');});

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
   if(v?.source===source&&v.nonce===current?.nonce&&v.type==='result'&&v.ok){clearInterval(timer);timer=null;status.textContent='This Chrome chat is connected.';}
   if(v?.method==='ui/notifications/tool-result')consume(v.params);
   if(v?.id==='rt-cloud-init'&&v.result)parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');
   if(v?.method==='ui/resource-teardown'){clearInterval(timer);timer=null;parent.postMessage({jsonrpc:'2.0',id:v.id,result:{}},'*');}
 });
 parent.postMessage({jsonrpc:'2.0',id:'rt-cloud-init',method:'ui/initialize',params:{appInfo:{name:'researchtube-cloud',version:'${WORKER_VERSION}'},appCapabilities:{},protocolVersion:'2026-01-26'}},'*');
 consume(window.openai?.toolResponseMetadata);start();
})();
</script></body></html>`;
}

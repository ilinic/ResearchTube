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
  return new Response(`
const status=document.getElementById('status');
async function send(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'same-origin'});const v=await r.json();if(!r.ok)throw Error('Unable to complete sign-in. Please retry.');return v;}
document.querySelectorAll('[data-provider]').forEach(button=>button.onclick=async()=>{try{button.disabled=true;const callbackURL=location.search?location.origin+'/api/auth/oauth2/authorize'+location.search:location.origin+'/account';const v=await send('/api/auth/sign-in/social',{provider:button.dataset.provider,callbackURL});if(v.url)location.assign(v.url);}catch(e){status.textContent=e.message;button.disabled=false;}});
const scopes=document.getElementById('scopes');if(scopes)scopes.textContent='Requested permissions: '+(new URLSearchParams(location.search).get('scope')||'ResearchTube tools');
for(const id of ['allow','deny']){const b=document.getElementById(id);if(b)b.onclick=async()=>{try{b.disabled=true;const v=await send('/api/auth/oauth2/consent',{accept:id==='allow',oauth_query:location.search.slice(1)});if(v.url)location.assign(v.url);}catch(e){status.textContent=e.message;b.disabled=false;}};}
const out=document.getElementById('sign-out');if(out)out.onclick=async()=>{await send('/api/auth/sign-out',{});location.assign('/sign-in');};
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

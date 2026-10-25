// This listener is independent of the local task/token widget protocol.
if (!globalThis.__researchTubeCloudWidgetBridge) {
  globalThis.__researchTubeCloudWidgetBridge = true;
  const source='researchtube-cloud-binding',pending=new Set();
  window.addEventListener('message',event=>{
    const value=event.data;
    if(event.source===window || value?.source!==source || value.type || !/^[a-f0-9-]{72}$/.test(value.nonce || '') || pending.has(value.nonce))return;
    const frame=[...document.querySelectorAll('iframe')].find(frame=>frame.contentWindow===event.source);
    if(!frame)return;
    let allowed=event.origin==='null';
    try{const url=new URL(event.origin);allowed ||= url.protocol==='https:'&&(url.hostname==='web-sandbox.oaiusercontent.com'||url.hostname.endsWith('.web-sandbox.oaiusercontent.com'));}catch{}
    if(!allowed)return;
    pending.add(value.nonce);
    Promise.resolve().then(()=>chrome.runtime.sendMessage({type:'researchtube_server_bind',nonce:value.nonce})).then(result=>{
      event.source?.postMessage({source,type:'result',nonce:value.nonce,ok:result?.ok===true,...(result?.errorCode?{errorCode:result.errorCode}:{})},event.origin==='null'?'*':event.origin);
    }).catch(()=>{}).finally(()=>pending.delete(value.nonce));
  });
}

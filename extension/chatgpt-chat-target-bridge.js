// Chrome supplies sender.tab to the worker. No ChatGPT classes, tool labels,
// active-tab guesses or conversation-text searches participate in binding.
if (!globalThis.__researchTubeChatTargetBridgeInstalled) {
  globalThis.__researchTubeChatTargetBridgeInstalled = true;
  const SOURCE = 'researchtube-chat-target-widget';
  const inFlight = new Set();
  const settled = new Map();
  function valid(value) {
    return value?.source === SOURCE && /^tsk_[A-Za-z0-9_-]{10}$/.test(value.taskId)
      && typeof value.bindingToken === 'string' && /^[a-f0-9-]{36}$/.test(value.bindingToken);
  }
  function send(value, reply) {
    if (!valid(value) || inFlight.has(value.taskId)) return;
    const respond=result=>reply({source:SOURCE,taskId:value.taskId,...result});
    if (settled.get(value.taskId)===value.bindingToken) { respond({ok:true}); return; }
    inFlight.add(value.taskId);
    // A stale extension context can throw before returning a Promise.
    Promise.resolve().then(()=>chrome.runtime.sendMessage({type:'researchtube_chat_target_bind', taskId:value.taskId, bindingToken:value.bindingToken})).then(
      response => {
        if(response?.ok) {
          settled.set(value.taskId,value.bindingToken);
          if(settled.size>128) settled.delete(settled.keys().next().value);
        }
        respond(response ?? {ok:false,error:'The originating tab could not be bound.'});
      },
      () => respond({ok:false,error:'The ResearchTube Extension bridge is temporarily unavailable.'})
    ).finally(() => inFlight.delete(value.taskId));
  }
  function localReply(result) {
    window.dispatchEvent(new CustomEvent('researchtube-chat-target-result', {detail:result}));
  }
  window.addEventListener('researchtube-chat-target-ready', event => send(event.detail, localReply));
  // A private DOM marker recovers late injection and cross-world event loss.
  // The marker belongs to our widget, not to the host's interface.
  function scan() {
    const anchor=document.querySelector('[data-researchtube-chat-target]');
    if(!anchor) return;
    try { send(JSON.parse(anchor.getAttribute('data-researchtube-chat-target')), localReply); } catch (_error) { /* incomplete marker */ }
  }
  // The marker is inside a widget frame. Do not observe or scan the changing
  // conversation DOM in the top page on every streamed assistant token.
  if(window!==window.top) {
    const observer=new MutationObserver(scan);
    observer.observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['data-researchtube-chat-target']});
    scan();
  }
  window.addEventListener('message',event=>{
    const value=event.data;
    if(event.source===window || !valid(value)) return;
    if(value.type) return;
    const frame=[...document.querySelectorAll('iframe')].find(frame=>frame.contentWindow===event.source);
    if(!frame) return;
    let allowed=event.origin==='null';
    try { const host=new URL(event.origin).hostname; allowed ||= host==='web-sandbox.oaiusercontent.com' || host.endsWith('.web-sandbox.oaiusercontent.com'); } catch (_error) {}
    if(!allowed) return;
    send(value,result=>event.source?.postMessage({type:'binding-result',...result},event.origin==='null'?'*':event.origin));
  });
}

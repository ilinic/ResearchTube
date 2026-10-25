// Private browser-profile transport. No credential, widget nonce or socket URL
// belongs in public status or MCP results.
export const SERVER_ORIGIN = 'https://rtube.win';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NONCE = /^[a-f0-9-]{72}$/;
const SOURCE_TABS = new Set(['site_read','site_get_children','site_get_node','site_get_text','site_interact','site_get_images','site_get_files','system_get_diagnostics']);
const failure = (code, message) => Object.assign(new Error(message), { code });
const same = (a,b) => a?.tabId === b?.tabId && a?.documentId === b?.documentId && a?.conversationId === b?.conversationId;
const terminal = code => ['SERVER_SIGN_IN_REQUIRED','EXTENSION_AUTHENTICATION_REQUIRED','EXTENSION_NOT_ALLOWED'].includes(code);
export function createServerConnection(host) {
  let socket = null, generation = 0, connecting = null, retry = null, heartbeat = null, attempt = 0, lastPong = 0, openedAt = 0, rejectedCredential = null;
  const bindings = new Map(), handshakes = new Map(), seen = new Set(), active = new Set();
  const now = () => host.now?.() ?? Date.now();
  const online = () => socket?.readyState === 1;
  const status = (state,errorCode = null) => host.status({ state, errorCode });
  async function api(path, body, credential = null) {
    const config = credential || await host.config();
    if (!config.serverInstallationToken) throw failure('SERVER_SIGN_IN_REQUIRED','Sign in to connect this Chrome profile.');
    const controller = new AbortController(), timer = host.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await host.fetch(SERVER_ORIGIN + path, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + config.serverInstallationToken },
        body:JSON.stringify(body), signal:controller.signal, redirect:'error', credentials:'omit' });
      let value; try { value = await response.json(); } catch { throw failure('SERVER_INVALID_RESPONSE','The server returned an invalid response.'); }
      if (!response.ok) {
        const code = value?.error?.code;
        throw failure(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'SERVER_CONNECTION_FAILED', 'The server could not complete this connection.');
      }
      return value;
    } catch (error) {
      if (error.code) throw error;
      throw failure('SERVER_NETWORK_ERROR','The ResearchTube server could not be reached.');
    } finally { host.clearTimeout(timer); }
  }
  async function invalidate(id, release = true) {
    const binding = bindings.get(id); if (!binding) return;
    bindings.delete(id);
    await host.invalidate?.(binding);
    if (release) void api('/api/browser/release',{ bindingId:id }).catch(() => {});
  }
  async function clearBindings(release = true) {
    await Promise.all([...bindings.keys()].map(id => invalidate(id,release)));
    handshakes.clear();
  }
  async function stop() {
    generation++;
    if (retry !== null) host.clearTimeout(retry); retry = null;
    if (heartbeat !== null) host.clearInterval(heartbeat); heartbeat = null;
    const old = socket; socket = null; connecting = null;
    old?.close(); await clearBindings();
  }
  async function verify(binding) {
    const current = bindings.get(binding?.bindingId), config = await host.config();
    if (config.connectionMode !== 'server' || !online() || !current || current.expiresAt <= now() || !same(current,binding) || binding.localEpoch && binding.localEpoch!==current?.localEpoch)
      throw failure('BROWSER_BINDING_CHANGED','Connect this chat to ResearchTube again.');
    const live = await host.identity(binding.tabId);
    if (!same(live,binding)) { await invalidate(binding.bindingId); throw failure('BROWSER_TARGET_MISMATCH','The connected tab or document changed.'); }
    // A mode change or server invalidation may happen during Chrome I/O.
    if (bindings.get(binding.bindingId) !== current || !online()) throw failure('BROWSER_BINDING_CHANGED','The browser connection changed.');
    return current;
  }
  function scheduleReconnect() {
    if (retry !== null) return;
    const delay = Math.min(60_000, 5_000 * 2 ** Math.min(attempt++,4)) + Math.floor((host.random?.() ?? Math.random()) * 1000);
    retry = host.setTimeout(() => { retry = null; void connect().catch(() => {}); }, delay);
  }
  async function receive(data, current, config, revision) {
    if (current !== socket || revision !== generation || typeof data !== 'string' || new TextEncoder().encode(data).length > 1024*1024) return;
    let message; try { message=JSON.parse(data); } catch { current.close(1008,'Invalid response'); return; }
    if (message.type === 'pong') { lastPong=now(); return; }
    if (message.type === 'invalidate' && UUID.test(message.bindingId || '')) { await invalidate(message.bindingId,false); return; }
    if (message.type !== 'request' || !UUID.test(message.requestId || '') || seen.has(message.requestId)) return;
    seen.add(message.requestId); if (seen.size>1000) seen.delete(seen.values().next().value);
    const target = message.target;
    const observed = { tabId:target?.tabId,documentId:target?.documentId,conversationId:target?.conversationId };
    let response;
    try {
      if (active.size>=50 || target?.installationId !== config.serverInstallationId || !UUID.test(target?.bindingId || '')) throw failure('BROWSER_TARGET_MISMATCH','Invalid browser request.');
      const binding=await verify(target);
      const request=message.request;
      if (request?.jsonrpc !== '2.0' || !['tools/list','tools/call','resources/list','resources/read'].includes(request.method)) throw failure('SERVER_PROTOCOL_ERROR','Invalid browser request.');
      const args={ ...(request.params?.arguments || {}) }, name=request.params?.name;
      if (Object.hasOwn(args,'chatTabId') && args.chatTabId!==binding.tabId || Object.hasOwn(args,'tabId') && !SOURCE_TABS.has(name) && args.tabId!==binding.tabId)
        throw failure('BROWSER_TARGET_MISMATCH','The requested chat differs from the connected chat.');
      const schema=host.tool(name)?.inputSchema?.properties || {};
      if (schema.chatTabId) args.chatTabId=binding.tabId;
      if (schema.tabId && !SOURCE_TABS.has(name)) args.tabId=binding.tabId;
      active.add(message.requestId);
      const result=await host.execute({ ...request,id:message.requestId,params:{ ...request.params,...(request.method==='tools/call'?{ arguments:args }:{}) } },structuredClone(binding));
      await verify(binding);
      response=result?.error ? { error:{code:-32001,message:'ResearchTube could not complete this request.'} } : { result:result?.result || {} };
    } catch (error) {
      response={ error:{code:-32001,message:/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code || '') ? error.code : 'BROWSER_REQUEST_FAILED'} };
    } finally { active.delete(message.requestId); }
    if (socket!==current || revision!==generation || !online()) return;
    const encoded=JSON.stringify({type:'response',requestId:message.requestId,target:observed,...response});
    if (new TextEncoder().encode(encoded).length<=1024*1024) current.send(encoded);
    else current.send(JSON.stringify({type:'response',requestId:message.requestId,target:observed,error:{code:-32001,message:'BROWSER_RESPONSE_TOO_LARGE'}}));
  }
  async function connect() {
    const config=await host.config();
    if (config.connectionMode!=='server') return {ok:false,errorCode:'SERVER_MODE_DISABLED'};
    if (terminal(config.lastServerConnection?.errorCode)) return {ok:false,errorCode:'SERVER_SIGN_IN_REQUIRED'};
    if (rejectedCredential === config.serverInstallationToken) return {ok:false,errorCode:'SERVER_SIGN_IN_REQUIRED'};
    if (online()) return {ok:true};
    if (connecting) return connecting;
    const revision=generation;
    const work=(async()=>{
      try {
        await status('connecting');
        const ticket=await api('/api/relay-ticket',{},config);
        if (!NONCE.test(ticket.ticket || '') || !Number.isFinite(ticket.expiresAt) || ticket.expiresAt<=now()) throw failure('SERVER_INVALID_RESPONSE','The server returned an invalid ticket.');
        if (revision!==generation || (await host.config()).connectionMode!=='server') return {ok:false,errorCode:'CONNECTION_CHANGED'};
        const current=host.socket(SERVER_ORIGIN.replace('https:','wss:')+'/relay?ticket='+encodeURIComponent(ticket.ticket)); socket=current;
        await new Promise((resolve,reject)=>{
          const timer=host.setTimeout(()=>{current.close();reject(failure('SERVER_CONNECTION_TIMEOUT','The server connection timed out.'));},15000);
          current.addEventListener('open',()=>{host.clearTimeout(timer);resolve();},{once:true});
          current.addEventListener('error',()=>{host.clearTimeout(timer);reject(failure('SERVER_NETWORK_ERROR','The server connection failed.'));},{once:true});
          current.addEventListener('close',()=>{host.clearTimeout(timer);reject(failure('SERVER_DISCONNECTED','The server disconnected.'));},{once:true});
        });
        if (revision!==generation) {current.close();return {ok:false,errorCode:'CONNECTION_CHANGED'};}
        attempt=0;lastPong=now();openedAt=now();
        current.addEventListener('message',event=>{void receive(event.data,current,config,revision).catch(()=>current.close(1008,'Invalid response'));});
        current.addEventListener('close',()=>{
          if (socket!==current || revision!==generation) return;
          socket=null; if(heartbeat!==null) host.clearInterval(heartbeat);heartbeat=null;
          void clearBindings().then(()=>status('error','SERVER_DISCONNECTED')).catch(()=>{});
          scheduleReconnect();
        });
        heartbeat=host.setInterval(()=>{
          if (socket!==current) return;
          if (now()-lastPong>45_000 || now()-openedAt>55*60_000) {current.close(1000,'Reconnect');return;}
          current.send('{"type":"ping"}');
        },20_000);
        await status('ready'); return {ok:true};
      } catch(error) {
        if(revision!==generation)return {ok:false,errorCode:'CONNECTION_CHANGED'};
        const old=socket;socket=null;old?.close();
        await status('error',error.code || 'SERVER_CONNECTION_FAILED');
        if(terminal(error.code))rejectedCredential=config.serverInstallationToken;
        else scheduleReconnect();
        return {ok:false,errorCode:error.code || 'SERVER_CONNECTION_FAILED',message:error.message};
      }
    })();
    connecting=work;
    try{return await work;}finally{if(connecting===work)connecting=null;}
  }
  async function bind(nonce,sender) {
    if (!NONCE.test(nonce || '') || sender?.id!==host.extensionId || !Number.isSafeInteger(sender.tab?.id)) throw failure('BROWSER_BINDING_INVALID','Invalid browser widget.');
    const prior=handshakes.get(nonce);
    if(prior) {const value=await prior;await verify(value);if(value.tabId!==sender.tab.id)throw failure('BROWSER_CONTEXT_AMBIGUOUS','This widget belongs to another tab.');return {ok:true};}
    if(!online()) {const result=await connect();if(!result.ok)throw failure(result.errorCode,'Connect this Chrome profile in ResearchTube Settings.');}
    const revision=generation;
    const work=(async()=>{
      const identity=await host.identity(sender.tab.id);
      await host.claimGroup?.(identity.tabId);
      const result=await api('/api/browser/bind',{nonce,target:identity});
      if(!UUID.test(result.bindingId || '') || !Number.isFinite(result.expiresAt) || result.expiresAt<=now())throw failure('SERVER_INVALID_RESPONSE','The server returned an invalid binding.');
      if(revision!==generation || !online())throw failure('CONNECTION_CHANGED','The server connection changed.');
      const live=await host.identity(identity.tabId);if(!same(identity,live))throw failure('BROWSER_TARGET_MISMATCH','The conversation changed while connecting.');
      if(bindings.size>=200)throw failure('BROWSER_BUSY','Too many connected chats.');
      const binding={...identity,bindingId:result.bindingId,expiresAt:result.expiresAt,localEpoch:bindings.get(result.bindingId)?.localEpoch || crypto.randomUUID()};
      bindings.set(binding.bindingId,binding);
      return binding;
    })();
    handshakes.set(nonce,work);if(handshakes.size>200)handshakes.delete(handshakes.keys().next().value);
    try{await work;return {ok:true};}catch(error){handshakes.delete(nonce);throw error;}
  }
  return {connect,stop,bind,verify,api,online,
    async changed(tabId){for(const binding of [...bindings.values()])if(binding.tabId===tabId){try{await verify(binding);}catch{await invalidate(binding.bindingId);}}},
    async disconnect(){const config=await host.config();await stop();try{await api('/api/installations/revoke-current',{},config);}finally{await host.clearCredential();await status('not-configured','SERVER_SIGN_IN_REQUIRED');}}
  };
}

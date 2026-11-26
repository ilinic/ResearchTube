// Outbound loopback transport, independent of the public relay/ChatGPT.
export function createLocalMcpConnection(host) {
  let socket = null, opening = null, heartbeat = null, handshake = null, generation = 0;
  let lastPong = 0, retryTimer=null, attempts=0;
  const diagnostic=(event,fields={})=>{try{host.diagnostic?.(event,fields);}catch{}};
  const retry=()=>{if(retryTimer!==null)return;const delay=Math.min(60000,2000*2**Math.min(attempts++,5));retryTimer=setTimeout(()=>{retryTimer=null;void start();},delay);};
  const pending = new Set();
  let tail = Promise.resolve();
  const close = () => { clearTimeout(retryTimer);retryTimer=null;generation++; if (heartbeat) host.clearInterval(heartbeat); clearTimeout(handshake); heartbeat = handshake = null; const old = socket; socket = null; pending.clear(); old?.close(); };
  async function start() {
    if (socket && socket.readyState <= 1 || opening) return opening;
    clearTimeout(retryTimer);retryTimer=null;
    const revision = ++generation;
    opening = (async () => {
      const port = await host.port();
      const response = await host.fetch(`http://127.0.0.1:${port}/internal/local-mcp/bootstrap`, { method: "POST", headers: { "Content-Type": "application/json", "X-ResearchTube-Extension": host.extensionId }, body: "{}", signal: AbortSignal.timeout(5000), credentials: "omit" });
      if (!response.ok) {diagnostic("LOCAL_BRIDGE_BOOTSTRAP_FAILED",{httpStatus:response.status,level:"WARN"});retry();return;}
      const config = await response.json();
      if (revision !== generation) return;
      if (config.interfaceVersion !== host.interfaceVersion || !/^[A-Za-z0-9_-]{43}$/.test(config.token)) {diagnostic("LOCAL_BRIDGE_VERSION_MISMATCH",{level:"WARN"});return;}
      const ws = host.webSocket(`ws://127.0.0.1:${port}/internal/local-mcp/bridge`);
      socket = ws;
      handshake = setTimeout(() => { if (socket === ws) {close();retry();} }, 8000);
      const send = value => { if (socket === ws && ws.readyState === 1) ws.send(JSON.stringify(value)); };
      const ready = async () => send({ type: "hello", token: config.token, interfaceVersion: host.interfaceVersion, extensionVersion: host.extensionVersion, enabledTools: await host.enabledTools() });
      ws.onopen = () => {
        if (socket !== ws || revision !== generation) { ws.close(); return; }
        clearTimeout(handshake); handshake = null; lastPong = Date.now();attempts=0;diagnostic("LOCAL_BRIDGE_CONNECTED");
        void ready().then(() => send({ type: "ping" })).catch(() => ws.close());
        heartbeat = host.setInterval(() => {
          if (Date.now() - lastPong > 45000) { diagnostic("LOCAL_BRIDGE_HEARTBEAT_TIMEOUT",{level:"WARN"});close();retry();return; }
          send({ type: "ping" }); void ready().catch(() => ws.close());
        }, 20000);
      };
      ws.onmessage = event => {
        if (socket !== ws || revision !== generation) return;
        let message;
        try { if (typeof event.data !== "string" || event.data.length > 131072) throw Error(); message = JSON.parse(event.data); } catch { ws.close(); return; }
        if (message.type === "pong") { lastPong = Date.now(); return; }
        if (message.type !== "request" || Object.keys(message).some(key => !["type", "id", "name", "arguments"].includes(key)) || !/^[a-f0-9]{32}$/.test(message.id) || typeof message.name !== "string" || !message.arguments || typeof message.arguments !== "object" || Array.isArray(message.arguments) || pending.has(message.id) || pending.size >= 32) { ws.close(); return; }
        pending.add(message.id);
        const execute = async () => {
          try {
            if (socket !== ws || revision !== generation) return;
            send({ type: "response", id: message.id, result: await host.dispatch(message.name, message.arguments, message.id) });
          }
          catch (error) { send({ type: "response", id: message.id, error: { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code) ? error.code : "YOUTUBE_REQUEST_FAILED", message: "The YouTube request could not complete. Check login, availability and retry delay." } }); }
          finally { pending.delete(message.id); }
        };
        tail = tail.catch(() => {}).then(execute);
      };
      ws.onclose = () => { if (socket === ws) { diagnostic("LOCAL_BRIDGE_DISCONNECTED",{level:"WARN"});close();retry(); } };
      ws.onerror = () => ws.close();
    })().catch(error => {if(revision===generation){diagnostic("LOCAL_BRIDGE_CONNECT_FAILED",{level:"WARN",exceptionType:error?.name});retry();}}).finally(() => { opening = null; });
    return opening;
  }
  return { start, close };
}

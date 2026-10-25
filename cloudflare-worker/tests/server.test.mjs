import { beforeAll, afterAll, expect, test } from "vitest";
import { start, seedSession, rpc, post, BASE, EXTENSION } from "./helpers.mjs";
let mf, db;
beforeAll(async () => { ({ mf, db } = await start()); });
afterAll(async () => { await mf?.dispose(); });
test("extension setup requires a browser login and keeps credentials out of HTML", async () => {
  const params = new URLSearchParams({ extensionId: "a".repeat(32), nonce: "a".repeat(72) });
  const missing = await mf.dispatchFetch(BASE + "/connect-extension?" + params, { redirect: "manual" });
  expect(missing.status).toBe(302);
  expect(missing.headers.get("Location")).toBe(BASE + "/sign-in?" + params);
  const session = await seedSession(db);
  const page = await mf.dispatchFetch(BASE + "/connect-extension?" + params, { headers: { Cookie: session.cookie } });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('data-page="extension-connect"');
  expect(html).not.toContain("installationToken");
  expect((await mf.dispatchFetch(BASE + "/connect-extension?extensionId=invalid&nonce=invalid")).status).toBe(400);
});
test("an installation can revoke only its own credential", async () => {
  const session = await seedSession(db);
  const enroll = async () => (await mf.dispatchFetch(BASE + "/api/installations", post({ name: "Chrome", extensionOrigin: EXTENSION }, { Cookie: session.cookie, Origin: BASE }))).json();
  const first = await enroll(), second = await enroll();
  const auth = { Authorization: "Bearer " + first.installationToken };
  expect((await mf.dispatchFetch(BASE + "/api/installations/revoke-current", post({}, auth))).status).toBe(200);
  expect((await mf.dispatchFetch(BASE + "/api/relay-ticket", post({}, auth))).status).toBe(401);
  expect((await mf.dispatchFetch(BASE + "/api/relay-ticket", post({}, { Authorization: "Bearer " + second.installationToken }))).status).toBe(200);
});
test("public pages do not start auth initialization or require its secret", async () => {
  const { mf: pages } = await start({ BETTER_AUTH_SECRET: "" });
  try {
    for (const path of ["/", "/sign-in", "/consent", "/auth-ui.js"])
      expect((await pages.dispatchFetch(BASE + path)).status).toBe(200);
  } finally { await pages.dispose(); }
});
test("Google sign-in starts with a real D1 state cookie and the exact callback", async () => {
  const { mf: google } = await start({ GOOGLE_CLIENT_ID: "client.test", GOOGLE_CLIENT_SECRET: "test-only-google-secret" });
  try {
    await google.dispatchFetch(BASE + "/");
    const response = await google.dispatchFetch(BASE + "/api/auth/sign-in/social",
      post({ provider: "google", callbackURL: BASE + "/account", disableRedirect: true }, { Origin: BASE }));
    expect(response.status).toBe(200);
    const result = await response.json(), url = new URL(result.url);
    expect(result.redirect).toBe(false);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(BASE + "/api/auth/callback/google");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(response.headers.get("Set-Cookie")).toContain("state");
    expect((await google.dispatchFetch(BASE + "/api/auth/get-session")).status).toBe(200);
  } finally { await google.dispose(); }
});
test("serves bounded public status and OAuth discovery without a browser", async () => {
  expect(await (await mf.dispatchFetch(BASE + "/health")).json()).toMatchObject({ status: "ok" });
  const resource = await (await mf.dispatchFetch(BASE + "/.well-known/oauth-protected-resource/mcp")).json();
  expect(resource.resource).toBe(BASE + "/mcp");
  const discovery = await mf.dispatchFetch(BASE + "/.well-known/oauth-authorization-server/api/auth");
  expect(discovery.status).toBe(200);
  const metadata = await discovery.json();
  expect(metadata.issuer).toBe(BASE + "/api/auth");
  expect(metadata.code_challenge_methods_supported).toContain("S256");
});
test("MCP discovery uses canonical Extension tools; execution challenges missing credentials", async () => {
  const response = await rpc(mf, "tools/list"); expect(response.status).toBe(200);
  const listing = await response.json(); expect(listing.result.tools).toHaveLength(84);
  const search = listing.result.tools.find(t => t.name === "youtube_search");
  expect(search.inputSchema.required).toContain("browserBindingId");
  const unauthorized = await rpc(mf, "tools/call", { name: "system_connection_status", arguments: {} });
  expect(unauthorized.status).toBe(401); expect(unauthorized.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource/mcp");
});
test("refuses foreign origins, unknown private routes and oversized payloads", async () => {
  expect((await mf.dispatchFetch(BASE + "/health", { headers: { Origin: "https://evil.test" } })).status).toBe(403);
  expect((await mf.dispatchFetch(BASE + "/api/auth/researchtube-verify", post({ token: "secret" }))).status).toBe(404);
  expect((await mf.dispatchFetch(BASE + "/api/auth/oauth2/create-client", post({}))).status).toBe(404);
  expect((await mf.dispatchFetch(BASE + "/mcp", post({ value: "x".repeat(1024 * 1024) }))).status).toBe(413);
});
test("enrolls a separate credential per installation, stores only its hash and consumes tickets once", async () => {
  const { cookie } = await seedSession(db);
  const enroll = () => mf.dispatchFetch(BASE + "/api/installations", post({ name: "Test Chrome", extensionOrigin: EXTENSION }, { Cookie: cookie, Origin: BASE }));
  const first = await enroll(); expect(first.status).toBe(201);
  const one = await first.json(), two = await (await enroll()).json();
  expect(one.installationId).not.toBe(two.installationId);
  expect(one.installationToken).not.toBe(two.installationToken);
  const saved = await db.prepare("SELECT token_hash FROM rt_installation WHERE id = ?").bind(one.installationId).first();
  expect(saved.token_hash).not.toBe(one.installationToken);
  const auth = { Authorization: "Bearer " + one.installationToken, Origin: EXTENSION };
  const issued = await mf.dispatchFetch(BASE + "/api/relay-ticket", post({}, auth)); expect(issued.status).toBe(200);
  const ticket = await issued.json();
  const connected = await mf.dispatchFetch(BASE + "/relay?ticket=" + ticket.ticket, { headers: { Upgrade: "websocket", Origin: EXTENSION } });
  expect(connected.status).toBe(101); connected.webSocket.accept(); connected.webSocket.close();
  const replay = await mf.dispatchFetch(BASE + "/relay?ticket=" + ticket.ticket, { headers: { Upgrade: "websocket", Origin: EXTENSION } });
  expect(replay.status).toBe(401);
  const revoked = await mf.dispatchFetch(BASE + "/api/installations/" + one.installationId, { method: "DELETE", headers: { Cookie: cookie, Origin: BASE } });
  expect(revoked.status).toBe(200);
  expect((await mf.dispatchFetch(BASE + "/api/relay-ticket", post({}, auth))).status).toBe(401);
});

test("the Chrome adapter binds a tab and answers through the real Worker relay", async () => {
  const { createServerConnection, SERVER_ORIGIN } = await import('../../extension/server-connection.js');
  const { randomUUID } = await import('node:crypto');
  const { doRoom, roomPost } = await import('./helpers.mjs');
  const session = await seedSession(db);
  const enrollment = await (await mf.dispatchFetch(BASE + '/api/installations', post({ name:'Adapter Chrome', extensionOrigin:EXTENSION }, { Cookie:session.cookie, Origin:BASE }))).json();
  const target = {tabId:77,documentId:'real-top-document',conversationId:'real-chat'};
  let nextResult;
  class BrowserSocket extends EventTarget {
    readyState=0; socket;
    constructor(url) {
      super();
      void mf.dispatchFetch(url.replace('wss://rtube.win',BASE), { headers:{Upgrade:'websocket',Origin:EXTENSION} }).then(response=>{
        if(response.status!==101)throw Error('WebSocket failed');
        this.socket=response.webSocket;this.socket.accept();this.readyState=1;
        this.socket.addEventListener('message',event=>this.dispatchEvent(new MessageEvent('message',{data:event.data})));
        this.dispatchEvent(new Event('open'));
      });
    }
    send(data){this.socket.send(data);}
    close(){this.readyState=3;this.socket?.close();this.dispatchEvent(new Event('close'));}
  }
  const adapter=createServerConnection({
    extensionId:'a'.repeat(32),now:Date.now,config:async()=>({connectionMode:'server',serverInstallationId:enrollment.installationId,serverInstallationToken:enrollment.installationToken}),
    setTimeout,clearTimeout,setInterval,clearInterval,status:async()=>{},invalidate:async()=>{},identity:async()=>target,
    socket:url=>new BrowserSocket(url),fetch:(url,options)=>mf.dispatchFetch(url.replace(SERVER_ORIGIN,BASE),options),
    tool:()=>({inputSchema:{properties:{tabId:{}}}}),
    execute:async(request,context)=>{
      nextResult={request,context};return {jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:'Adapter acknowledged'}]}};
    }
  });
  try {
    expect((await adapter.connect()).ok).toBe(true);
    const room=await doRoom(mf,session.userId);
    const challenge=await (await roomPost(room,'/challenge',{session:'adapter-conversation'})).json();
    expect((await adapter.bind(challenge.nonce,{id:'a'.repeat(32),tab:{id:77}})).ok).toBe(true);
    const state=await (await roomPost(room,'/status',{session:'adapter-conversation'})).json();
    const response=await roomPost(room,'/dispatch',{bindingId:state.bindings[0].bindingId,session:'adapter-conversation',request:{jsonrpc:'2.0',method:'tools/call',params:{name:'media_capture_frame',arguments:{workspacePath:'test.mp4'}}}});
    expect(response.status).toBe(200);
    expect((await response.json()).result.content[0].text).toBe('Adapter acknowledged');
    expect(nextResult.request.params.arguments.tabId).toBe(77);
    expect(nextResult.context.documentId).toBe('real-top-document');
  } finally {await adapter.stop();}
});

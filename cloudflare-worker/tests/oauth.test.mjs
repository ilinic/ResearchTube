import { beforeAll, afterAll, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { start, seedSession, rpc, post, message, BASE, EXTENSION, target } from "./helpers.mjs";
let mf, db, tokenResponse;
beforeAll(async () => { ({ mf, db } = await start()); });
afterAll(async () => { await mf?.dispose(); });
const CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";
const verifier = "a-valid-PKCE-verifier-of-more-than-forty-three-characters-12345";
const form = body => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
async function begin() {
  const response = await mf.dispatchFetch(BASE + "/api/auth/oauth2/register", post({ client_name: "ResearchTube test", redirect_uris: [CALLBACK],
    token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }));
  const client = await response.json(); expect(response.status, JSON.stringify(client)).toBe(201);
  const session = await seedSession(db);
  const params = new URLSearchParams({ client_id: client.client_id, response_type: "code", redirect_uri: CALLBACK,
    scope: "openid profile email offline_access researchtube:use", resource: BASE, state: "test-state",
    code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
  const authorize = await mf.dispatchFetch(BASE + "/api/auth/oauth2/authorize?" + params, { headers: { Cookie: session.cookie, Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" }, redirect: "manual" });
  // Miniflare's Node fetch transport sets sec-fetch-mode:cors; Better Auth
  // returns a JSON redirect for fetch and a 302 for document navigation.
  expect([200, 302]).toContain(authorize.status);
  const consentUrl = new URL(authorize.headers.get("Location") || (await authorize.json()).url, BASE);
  expect(consentUrl.pathname).toBe("/consent");
  const consent = await mf.dispatchFetch(BASE + "/api/auth/oauth2/consent", post({ accept: true, oauth_query: consentUrl.search.slice(1) }, { Cookie: session.cookie, Origin: BASE }));
  const accepted = await consent.json(); expect(consent.status, JSON.stringify(accepted)).toBe(200);
  const callback = new URL(accepted.url);
  expect(callback.origin + callback.pathname).toBe(CALLBACK);
  expect(callback.searchParams.get("state")).toBe("test-state");
  expect(callback.searchParams.get("iss")).toBe(BASE + "/api/auth");
  return { client, session, code: callback.searchParams.get("code") };
}
test("real D1-backed OAuth code + consent + PKCE token authorizes only account-scoped calls", async () => {
  const { client, code } = await begin();
  const response = await mf.dispatchFetch(BASE + "/api/auth/oauth2/token", form({ grant_type: "authorization_code", client_id: client.client_id,
    code, code_verifier: verifier, redirect_uri: CALLBACK, resource: BASE }));
  const tokens = await response.json(); expect(response.status, JSON.stringify(tokens)).toBe(200);
  expect(tokens.access_token).toBeTypeOf("string"); expect(tokens.refresh_token).toBeTypeOf("string");
  tokenResponse = { ...tokens, clientId: client.client_id };
  const status = await rpc(mf, "tools/call", { name: "system_connection_status", arguments: {}, _meta: { "openai/session": "chat-oauth" } }, tokens.access_token);
  const value = await status.json(); expect(status.status, JSON.stringify(value)).toBe(200);
  expect(value.result.structuredContent).toMatchObject({ connected: false, extensionConnected: false });
  const noContext = await (await rpc(mf, "tools/call", { name: "system_connection_status", arguments: {} }, tokens.access_token)).json();
  expect(noContext.result.structuredContent).toMatchObject({ accountConnected: true, cloudToolsAvailable: false, setupUrl: BASE + "/setup" });
  const listing = await (await rpc(mf, "tools/list")).json();
  expect(listing.result.tools.some(tool => ["system_connect_browser", "system_disconnect_browser"].includes(tool.name))).toBe(false);

});
test("refresh rotates credentials and a revoked refresh token cannot mint new access", async () => {
  expect(tokenResponse).toBeDefined();
  const refreshed = await mf.dispatchFetch(BASE + "/api/auth/oauth2/token", form({ grant_type: "refresh_token", client_id: tokenResponse.clientId,
    refresh_token: tokenResponse.refresh_token, resource: BASE }));
  const tokens = await refreshed.json(); expect(refreshed.status, JSON.stringify(tokens)).toBe(200);
  expect(tokens.refresh_token).not.toBe(tokenResponse.refresh_token);
  const revoke = await mf.dispatchFetch(BASE + "/api/auth/oauth2/revoke", form({ client_id: tokenResponse.clientId, token: tokens.refresh_token, token_type_hint: "refresh_token" }));
  expect(revoke.status, await revoke.clone().text()).toBe(200);
  const denied = await mf.dispatchFetch(BASE + "/api/auth/oauth2/token", form({ grant_type: "refresh_token", client_id: tokenResponse.clientId,
    refresh_token: tokens.refresh_token, resource: BASE }));
  expect(denied.status).toBe(400);
  // Signed access tokens expire after five minutes; disconnecting a browser
  // binding or installation separately blocks routing immediately.
});
test("rejects an unregistered redirect and a wrong PKCE verifier", async () => {
  const { client, code } = await begin();
  const redirect = await mf.dispatchFetch(BASE + "/api/auth/oauth2/authorize?" + new URLSearchParams({ client_id: client.client_id,
    response_type: "code", redirect_uri: "https://evil.test/callback", scope: "researchtube:use", resource: BASE }), { redirect: "manual" });
  expect(redirect.headers.get("Location") || "").not.toContain("evil.test");
  const refusal = await redirect.json();
  if (refusal.url) expect(new URL(refusal.url, BASE).origin).not.toBe("https://evil.test");
  else expect(refusal.error).toBeTruthy();
  const exchange = await mf.dispatchFetch(BASE + "/api/auth/oauth2/token", form({ grant_type: "authorization_code", client_id: client.client_id,
    code, code_verifier: "wrong-pkce-verifier-of-more-than-forty-three-characters", redirect_uri: CALLBACK, resource: BASE }));
  expect(exchange.status).toBe(400);
});
test("the first OAuth-authenticated tool executes without a conversation or connection widget", async () => {
  const { client, code, session } = await begin();
  const tokens = await (await mf.dispatchFetch(BASE + "/api/auth/oauth2/token", form({ grant_type: "authorization_code", client_id: client.client_id,
    code, code_verifier: verifier, redirect_uri: CALLBACK, resource: BASE }))).json();
  const installed = await (await mf.dispatchFetch(BASE + "/api/installations", post({ name: "Test profile", extensionOrigin: EXTENSION }, { Cookie: session.cookie, Origin: BASE }))).json();
  const headers = { Authorization: "Bearer " + installed.installationToken, Origin: EXTENSION };
  const ticket = await (await mf.dispatchFetch(BASE + "/api/relay-ticket", post({}, headers))).json();
  const upgraded = await mf.dispatchFetch(BASE + "/relay?ticket=" + ticket.ticket, { headers: { Upgrade: "websocket", Origin: EXTENSION } });
  const socket = upgraded.webSocket; socket.accept();
  try {
    const ready = new Promise(resolve => socket.addEventListener("message", event => resolve(event.data), { once: true }));
    socket.send("direct-tools-v1"); expect(await ready).toBe("direct-tools-ready");
    // No openai/session metadata, challenge, bind call, status check or resource read.
    const call = (name, args) => rpc(mf, "tools/call", { name, arguments: args }, tokens.access_token);
    for (const [name,args] of [["youtube_get_transcript",{videoId:"aqz-KE-bpKQ"}],["media_probe",{workspacePath:"a.mp4"}],["timer_start",{duration:1,tabId:7}]]) {
      const received = message(socket), pending = call(name,args), command = await Promise.race([received,pending.then(async response => {throw Error("Call completed without dispatch: "+await response.clone().text());})]);
      expect(command.request.params).toEqual({ name, arguments: args });
      expect(command.installationId).toBe(installed.installationId);
      expect(command).not.toHaveProperty("target");
      socket.send(JSON.stringify({ type: "response", requestId: command.requestId, result: { content: [{ type: "text", text: "Direct response" }] } }));
      expect((await (await pending).json()).result.content[0].text).toBe("Direct response");
    }
    const invalid = await (await call("youtube_get_video", { videoId: "aqz-KE-bpKQ", unknown: true })).json();
    expect(invalid.result.structuredContent.error.code).toBe("INVALID_ARGUMENT");
    const forged = await (await call("youtube_get_video", { videoId: "aqz-KE-bpKQ", browserBindingId: "forged" })).json();
    expect(forged.result.structuredContent.error.code).toBe("INVALID_ARGUMENT");
    const unknown = await (await call("constructor", {})).json();
    expect(unknown.result.structuredContent.error.code).toBe("TOOL_NOT_FOUND");
    const foreign = await begin();
    const foreignTokens = await (await mf.dispatchFetch(BASE + "/api/auth/oauth2/token", form({ grant_type: "authorization_code", client_id: foreign.client.client_id,
      code: foreign.code, code_verifier: verifier, redirect_uri: CALLBACK, resource: BASE }))).json();
    const refused = await (await rpc(mf,"tools/call",{name:"youtube_get_video",arguments:{videoId:"aqz-KE-bpKQ"}},foreignTokens.access_token)).json();
    expect(refused.result.structuredContent.error.code).toBe("EXTENSION_OFFLINE");
    const status = await (await call("system_connection_status", {})).json();
    expect(status.result.structuredContent.connected).toBe(true);
  } finally { socket.close(); }
});

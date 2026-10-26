import { beforeAll, afterAll, expect, test } from "vitest";
import { start, seedSession, rpc, post, BASE, EXTENSION, doRoom, roomPost, message } from "./helpers.mjs";
let mf, db;
beforeAll(async () => { ({ mf, db } = await start()); });
afterAll(async () => { await mf?.dispose(); });
test("public pages do not start auth initialization or require its secret", async () => {
  const { mf: pages } = await start({ BETTER_AUTH_SECRET: "" });
  try {
    for (const path of ["/", "/sign-in", "/consent", "/auth-ui.js", "/home-ui.js", "/icons/researchtube-128.png"])
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
  const homepage = await mf.dispatchFetch(BASE);
  expect(homepage.headers.get("Content-Type")).toContain("text/html");
  expect(await homepage.text()).toContain("add a custom MCP server");
  expect((await mf.dispatchFetch(BASE + "/mcp", post({}))).status).toBe(404);
  expect((await mf.dispatchFetch(BASE, { headers: { Accept: "text/event-stream" } })).status).toBe(405);
  expect(await (await mf.dispatchFetch(BASE + "/health")).json()).toMatchObject({ status: "ok" });
  const resource = await (await mf.dispatchFetch(BASE + "/.well-known/oauth-protected-resource")).json();
  expect(resource.resource).toBe(BASE);
  const discovery = await mf.dispatchFetch(BASE + "/.well-known/oauth-authorization-server/api/auth");
  expect(discovery.status).toBe(200);
  const metadata = await discovery.json();
  expect(metadata.issuer).toBe(BASE + "/api/auth");
  expect(metadata.code_challenge_methods_supported).toContain("S256");
  expect(resource.resource).toBe(BASE);
  const setup = await mf.dispatchFetch(BASE + "/setup");
  expect(await setup.text()).toContain("First add");
});
test("MCP discovery uses canonical Extension tools; execution challenges missing credentials", async () => {
  const response = await rpc(mf, "tools/list"); expect(response.status).toBe(200);
  const listing = await response.json(); expect(listing.result.tools).toHaveLength(84);
  for (const name of ["site_diagnostics_start", "site_diagnostics_report"]) {
    const diagnostic = listing.result.tools.find(tool => tool.name === name);
    expect(diagnostic).toBeDefined();
    expect(diagnostic.inputSchema.required).toContain("chatTabId");
    expect(diagnostic.inputSchema.additionalProperties).toBe(false);
  }
  const search = listing.result.tools.find(t => t.name === "youtube_search");
  expect(search.inputSchema.required || []).not.toContain("browserBindingId");
  expect(search.inputSchema.properties).not.toHaveProperty("browserBindingId");
  const unauthorized = await rpc(mf, "tools/call", { name: "system_connection_status", arguments: {} });
  expect(unauthorized.status).toBe(401); expect(unauthorized.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource");
});
test("refuses foreign origins, unknown private routes and oversized payloads", async () => {
  expect((await mf.dispatchFetch(BASE + "/health", { headers: { Origin: "https://evil.test" } })).status).toBe(403);
  expect((await mf.dispatchFetch(BASE + "/api/auth/researchtube-verify", post({ token: "secret" }))).status).toBe(404);
  expect((await mf.dispatchFetch(BASE + "/api/auth/oauth2/create-client", post({}))).status).toBe(404);
  expect((await mf.dispatchFetch(BASE, post({ value: "x".repeat(1024 * 1024) }))).status).toBe(413);
});
test("keeps one active installation, stores credential hashes and consumes tickets once", async () => {
  const { cookie } = await seedSession(db);
  const enroll = () => mf.dispatchFetch(BASE + "/api/installations", post({ name: "Test Chrome", extensionOrigin: EXTENSION }, { Cookie: cookie, Origin: BASE }));
  const first = await enroll(); expect(first.status).toBe(201);
  const one = await first.json(), two = await (await enroll()).json();
  const profiles = await (await mf.dispatchFetch(BASE + "/api/installations", { headers: { Cookie: cookie } })).json();
  expect(profiles.installations).toHaveLength(1);
  expect(JSON.stringify(profiles)).not.toMatch(/installationToken|token_hash/);
  const other = await seedSession(db);
  const foreign = await mf.dispatchFetch(BASE + "/api/installations/" + one.installationId, { method: "DELETE", headers: { Cookie: other.cookie, Origin: BASE } });
  expect(foreign.status).toBe(404);
  expect(one.installationId).not.toBe(two.installationId);
  expect(one.installationToken).not.toBe(two.installationToken);
  const saved = await db.prepare("SELECT token_hash FROM rt_installation WHERE id = ?").bind(one.installationId).first();
  expect(saved.token_hash).not.toBe(one.installationToken);
  const auth = { Authorization: "Bearer " + two.installationToken, Origin: EXTENSION };
  const checked = await mf.dispatchFetch(BASE + "/api/installation/check", post({}, auth));
  expect(await checked.json()).toEqual({ installationId: two.installationId });
  const issued = await mf.dispatchFetch(BASE + "/api/relay-ticket", post({}, auth)); expect(issued.status).toBe(200);
  const ticket = await issued.json();
  const connected = await mf.dispatchFetch(BASE + "/relay?ticket=" + ticket.ticket, { headers: { Upgrade: "websocket", Origin: EXTENSION } });
  expect(connected.status).toBe(101); connected.webSocket.accept(); connected.webSocket.close();
  const replay = await mf.dispatchFetch(BASE + "/relay?ticket=" + ticket.ticket, { headers: { Upgrade: "websocket", Origin: EXTENSION } });
  expect(replay.status).toBe(401);
  const revoked = await mf.dispatchFetch(BASE + "/api/installations/" + two.installationId, { method: "DELETE", headers: { Cookie: cookie, Origin: BASE } });
  expect(revoked.status).toBe(200);
  expect((await mf.dispatchFetch(BASE + "/api/relay-ticket", post({}, auth))).status).toBe(401);
});
test("replacement disconnects the old extension and invalidates credentials and unconsumed tickets", async () => {
  const owner = await seedSession(db), other = await seedSession(db);
  const enroll = async cookie => (await mf.dispatchFetch(BASE + "/api/installations", post({ name: "Chrome", extensionOrigin: EXTENSION }, { Cookie: cookie, Origin: BASE }))).json();
  const one = await enroll(owner.cookie), foreign = await enroll(other.cookie);
  const auth = token => ({ Authorization: "Bearer " + token, Origin: EXTENSION });
  const ticket = await (await mf.dispatchFetch(BASE + "/api/relay-ticket", post({}, auth(one.installationToken)))).json();
  const upgraded = await mf.dispatchFetch(BASE + "/relay?ticket=" + ticket.ticket, { headers: { Upgrade: "websocket", Origin: EXTENSION } });
  upgraded.webSocket.accept();
  const replaced = message(upgraded.webSocket);
  const two = await enroll(owner.cookie);
  expect(await replaced).toEqual({ type: "disconnect", code: "EXTENSION_REPLACED" });
  expect((await mf.dispatchFetch(BASE + "/api/installation/check", post({}, auth(one.installationToken)))).status).toBe(401);
  expect((await mf.dispatchFetch(BASE + "/api/relay-ticket", post({}, auth(one.installationToken)))).status).toBe(401);
  expect((await mf.dispatchFetch(BASE + "/api/installation/check", post({}, auth(two.installationToken)))).status).toBe(200);
  expect((await mf.dispatchFetch(BASE + "/api/installation/check", post({}, auth(foreign.installationToken)))).status).toBe(200);
  // An already issued but unused ticket also loses authority on replacement.
  const secondTicket = await (await mf.dispatchFetch(BASE + "/api/relay-ticket", post({}, auth(two.installationToken)))).json();
  await enroll(owner.cookie);
  expect((await mf.dispatchFetch(BASE + "/relay?ticket=" + secondTicket.ticket, { headers: { Upgrade: "websocket", Origin: EXTENSION } })).status).toBe(401);
});

test("an installation can revoke only its own credential", async () => {
  const session = await seedSession(db);
  const enroll = async cookie => (await mf.dispatchFetch(BASE + "/api/installations", post({ name: "Chrome", extensionOrigin: EXTENSION }, { Cookie: cookie, Origin: BASE }))).json();
  const first = await enroll(session.cookie), second = await enroll((await seedSession(db)).cookie);
  const auth = { Authorization: "Bearer " + first.installationToken, Origin: EXTENSION };
  expect((await mf.dispatchFetch(BASE + "/api/installation/revoke", post({}, auth))).status).toBe(200);
  expect((await mf.dispatchFetch(BASE + "/api/installation/check", post({}, auth))).status).toBe(401);
  expect((await mf.dispatchFetch(BASE + "/api/installation/check", post({}, { Authorization: "Bearer " + second.installationToken, Origin: EXTENSION }))).status).toBe(200);
});

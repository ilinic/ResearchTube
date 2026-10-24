import { beforeAll, afterAll, expect, test } from "vitest";
import { start, seedSession, rpc, post, BASE, EXTENSION } from "./helpers.mjs";
let mf, db;
beforeAll(async () => { ({ mf, db } = await start()); });
afterAll(async () => { await mf?.dispose(); });
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

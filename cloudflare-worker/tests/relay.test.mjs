import { beforeAll, afterAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { start, doRoom, roomPost, socketFor, target, bind, message } from "./helpers.mjs";
let mf; const sockets = [];
beforeAll(async () => { ({ mf } = await start()); });
afterAll(async () => { for (const socket of sockets) { try { socket.close(); } catch {} } await mf?.dispose(); });
async function setup() { const stub = await doRoom(mf, randomUUID()); const connection = await socketFor(stub); sockets.push(connection.socket); return { stub, ...connection }; }
test("pins a request and its reply to installation + tab + document", async () => {
  const { stub, socket, installationId } = await setup();
  const binding = await bind(stub, installationId);
  const incoming = message(socket);
  const pending = roomPost(stub, "/dispatch", { bindingId: binding.bindingId, session: "chat-1", request: { jsonrpc: "2.0", method: "tools/call", params: { name: "youtube_get_video", arguments: { videoId: "aqz-KE-bpKQ" } } } });
  const request = await incoming;
  expect(request.target.tabId).toBe(7);
  socket.send(JSON.stringify({ type: "response", requestId: request.requestId, target: target(), result: { content: [{ type: "text", text: "correct tab" }] } }));
  expect(await (await pending).json()).toEqual({ result: { content: [{ type: "text", text: "correct tab" }] } });
});
test("another conversation or user cannot use a binding", async () => {
  const { stub, installationId } = await setup();
  const binding = await bind(stub, installationId);
  const body = { bindingId: binding.bindingId, session: "other-chat", request: { jsonrpc: "2.0", method: "tools/list" } };
  expect((await roomPost(stub, "/dispatch", body)).status).toBe(409);
  expect((await roomPost(await doRoom(mf, randomUUID()), "/dispatch", { ...body, session: "chat-1" })).status).toBe(409);
});
test("one-time widget proof cannot be replayed or bound offline", async () => {
  const { stub, installationId } = await setup();
  const challenge = await (await roomPost(stub, "/challenge", { session: "chat" })).json();
  const body = { installationId, nonce: challenge.nonce, target: target() };
  expect((await roomPost(stub, "/bind", body)).status).toBe(200);
  expect((await roomPost(stub, "/bind", body)).status).toBe(409);
  const other = await (await roomPost(stub, "/challenge", { session: "chat" })).json();
  expect((await roomPost(stub, "/bind", { ...body, nonce: other.nonce, installationId: randomUUID() })).status).toBe(409);
});
test("same conversation observed in a second installation blocks both instead of switching", async () => {
  const { stub, socket, installationId } = await setup();
  const first = await bind(stub, installationId);
  const second = await socketFor(stub); sockets.push(second.socket);
  const challenge = await (await roomPost(stub, "/challenge", { session: "chat-1" })).json();
  const invalidated = message(socket);
  const conflict = await roomPost(stub, "/bind", { installationId: second.installationId, nonce: challenge.nonce, target: target(9) });
  expect((await conflict.json()).error.code).toBe("BROWSER_CONTEXT_AMBIGUOUS");
  expect((await invalidated).bindingId).toBe(first.bindingId);
  const result = await roomPost(stub, "/dispatch", { bindingId: first.bindingId, session: "chat-1", request: { jsonrpc: "2.0", method: "tools/list" } });
  expect((await result.json()).error.code).toBe("BROWSER_CONTEXT_AMBIGUOUS");
  const retry = await (await roomPost(stub, "/challenge", { session: "chat-1" })).json();
  const oldController = await roomPost(stub, "/bind", { installationId, nonce: retry.nonce, target: target() });
  expect((await oldController.json()).error.code).toBe("BROWSER_CONTEXT_AMBIGUOUS");
});
test("document navigation rejects an otherwise matching response", async () => {
  const { stub, socket, installationId } = await setup(); const binding = await bind(stub, installationId);
  const incoming = message(socket);
  const pending = roomPost(stub, "/dispatch", { bindingId: binding.bindingId, session: "chat-1", request: { jsonrpc: "2.0", method: "tools/list" } });
  const request = await incoming;
  socket.send(JSON.stringify({ type: "response", requestId: request.requestId, target: { ...target(), documentId: "new-document" }, result: { tools: [] } }));
  expect((await (await pending).json()).error.code).toBe("BROWSER_TARGET_MISMATCH");
});
test("disconnect fails an in-flight request and never forwards it to another browser", async () => {
  const { stub, socket, installationId } = await setup(); const binding = await bind(stub, installationId);
  const incoming = message(socket);
  const pending = roomPost(stub, "/dispatch", { bindingId: binding.bindingId, session: "chat-1", request: { jsonrpc: "2.0", method: "tools/list" } });
  await incoming;
  socket.close();
  expect((await (await pending).json()).error.code).toBe("BROWSER_DISCONNECTED");
});
test("a caller cannot override the bound leading chat ID", async () => {
  const { stub, installationId } = await setup(); const binding = await bind(stub, installationId);
  const response = await roomPost(stub, "/dispatch", { bindingId: binding.bindingId, session: "chat-1", request: { jsonrpc: "2.0", method: "tools/call", params: { name: "site_list_tabs", arguments: { chatTabId: 100 } } } });
  expect((await response.json()).error.code).toBe("BROWSER_TARGET_MISMATCH");
  const notification = await roomPost(stub, "/dispatch", { bindingId: binding.bindingId, session: "chat-1", request: { jsonrpc: "2.0", method: "tools/call", params: { name: "timer_start", arguments: { tabId: 100 } } } });
  expect((await notification.json()).error.code).toBe("BROWSER_TARGET_MISMATCH");
});
test("concurrent claims consume a nonce only once without resetting other sockets", async () => {
  const { stub, installationId } = await setup();
  const challenge = await (await roomPost(stub, "/challenge", { session: "race-chat" })).json();
  const body = { installationId, nonce: challenge.nonce, target: target() };
  const responses = await Promise.all([roomPost(stub, "/bind", body), roomPost(stub, "/bind", body)]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  expect((await (await roomPost(stub, "/status", { session: "race-chat" })).json()).connected).toBe(true);
  const existing = (await responses.find(r => r.status === 200).json()).bindingId;
  expect((await bind(stub, installationId, "race-chat")).bindingId).toBe(existing);
});
test("a different installation cannot settle or release the originating request", async () => {
  const { stub, socket, installationId } = await setup(); const binding = await bind(stub, installationId);
  const second = await socketFor(stub); sockets.push(second.socket);
  const received = message(socket);
  const pending = roomPost(stub, "/dispatch", { bindingId: binding.bindingId, session: "chat-1", request: { jsonrpc: "2.0", method: "tools/list" } });
  const command = await received;
  second.socket.send(JSON.stringify({ type: "response", requestId: command.requestId, target: target(), result: { tools: ["wrong browser"] } }));
  expect((await roomPost(stub, "/release", { installationId: second.installationId, bindingId: binding.bindingId })).status).toBe(404);
  socket.send(JSON.stringify({ type: "response", requestId: command.requestId, target: target(), result: { tools: ["correct browser"] } }));
  expect((await (await pending).json()).result.tools).toEqual(["correct browser"]);
});

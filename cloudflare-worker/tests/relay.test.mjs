import { beforeAll, afterAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { start, doRoom, roomPost, socketFor, message } from "./helpers.mjs";
let mf; const sockets = [];
beforeAll(async () => { ({ mf } = await start()); });
afterAll(async () => { for (const socket of sockets) { try { socket.close(); } catch {} } await mf?.dispose(); });
const request = (name = "youtube_get_transcript", args = {videoId:"aqz-KE-bpKQ"}) => ({request:{jsonrpc:"2.0",method:"tools/call",params:{name,arguments:args}}});
async function setup(ready = true) {
  const stub = await doRoom(mf, randomUUID()), connection = await socketFor(stub); sockets.push(connection.socket);
  if (ready) {
    const ack = new Promise(resolve => connection.socket.addEventListener("message", event => resolve(event.data), {once:true}));
    connection.socket.send("direct-tools-v1"); expect(await ack).toBe("direct-tools-ready");
  }
  return {stub,...connection};
}
test("productive dispatch needs only the account extension and returns its first response", async () => {
  const {stub,socket,installationId} = await setup();
  const incoming = message(socket), pending = roomPost(stub,"/dispatch",request()), command = await incoming;
  expect(command).toMatchObject({type:"request",installationId});expect(command).not.toHaveProperty("target");
  socket.send(JSON.stringify({type:"response",requestId:command.requestId,result:{content:[{type:"text",text:"transcript"}]}}));
  expect(await (await pending).json()).toEqual({result:{content:[{type:"text",text:"transcript"}]}});
});
test("offline and old extensions fail immediately without a queued request", async () => {
  const empty = await doRoom(mf,randomUUID());
  expect((await (await roomPost(empty,"/dispatch",request())).json()).error.code).toBe("EXTENSION_OFFLINE");
  const {stub} = await setup(false);
  expect((await (await roomPost(stub,"/dispatch",request())).json()).error.code).toBe("EXTENSION_UPDATE_REQUIRED");
});
test("unknown or extra arguments cannot enter the relay", async () => {
  const {stub} = await setup();
  for (const body of [request("constructor",{}),request("youtube_get_video",{videoId:"x",tabId:9}),request("timer_start",{durationSeconds:1,unknown:true})])
    expect((await roomPost(stub,"/dispatch",body)).status).toBe(400);
  expect((await roomPost(stub,"/dispatch",{...request(),session:"legacy"})).status).toBe(400);
  expect((await roomPost(stub,"/challenge",{session:"legacy"})).status).toBe(404);
});
test("another account cannot resolve a pending request even with its requestId", async () => {
  const one = await setup(), two = await setup();
  const incoming = message(one.socket), pending = roomPost(one.stub,"/dispatch",request()), command = await incoming;
  two.socket.send(JSON.stringify({type:"response",requestId:command.requestId,result:{content:[{type:"text",text:"foreign"}]}}));
  one.socket.send(JSON.stringify({type:"response",requestId:command.requestId,result:{content:[{type:"text",text:"owner"}]}}));
  expect((await (await pending).json()).result.content[0].text).toBe("owner");
});
test("heartbeat survives hibernation state and same-installation reconnect rejects pending work", async () => {
  const {stub,socket,installationId} = await setup();
  const pong = new Promise(resolve=>socket.addEventListener("message",event=>resolve(event.data),{once:true}));socket.send("ping");expect(await pong).toBe("pong");
  const incoming = message(socket), pending = roomPost(stub,"/dispatch",request());await incoming;
  const next = await socketFor(stub,installationId);sockets.push(next.socket);
  expect((await (await pending).json()).error.code).toBe("EXTENSION_OFFLINE");
  expect((await (await roomPost(stub,"/status",{})).json()).extensionConnected).toBe(true);
  const rejected = await stub.fetch("https://room.internal/connect",{headers:{Upgrade:"websocket","X-Installation-Id":randomUUID()}});
  expect(rejected.status).toBe(401);
});
test("malformed response closes only its socket and settles its pending request", async () => {
  const {stub,socket} = await setup();
  const incoming = message(socket), pending = roomPost(stub,"/dispatch",request());await incoming;
  socket.send(JSON.stringify({type:"response",requestId:randomUUID(),result:{},error:{code:-1,message:"both"}}));
  expect((await (await pending).json()).error.code).toBe("BROWSER_PROTOCOL_ERROR");
});
test("revocation fails in-flight work and leaves the account offline", async () => {
  const {stub,socket,installationId} = await setup();
  const incoming = message(socket), pending = roomPost(stub,"/dispatch",request());await incoming;
  await roomPost(stub,"/revoke",{installationId});
  expect((await (await pending).json()).error.code).toBe("EXTENSION_OFFLINE");
  expect((await (await roomPost(stub,"/status",{})).json()).extensionConnected).toBe(false);
  const stale = await stub.fetch("https://room.internal/connect", {headers:{Upgrade:"websocket","X-Installation-Id":installationId}});
  expect(stale.status).toBe(401,"late reconnect cannot revive a revoked installation");
});

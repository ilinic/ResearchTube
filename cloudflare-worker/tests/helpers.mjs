import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import { createHmac, randomUUID } from "node:crypto";
export const BASE = "https://rt.test";
export const EXTENSION = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const AUTH_SECRET = "test-only-random-auth-secret-12345678901234567890";
export async function start() {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: "dist/index.js", compatibilityDate: "2026-10-24", compatibilityFlags: ["nodejs_compat"],
    bindings: { PUBLIC_ORIGIN: BASE, EXTENSION_ORIGINS: JSON.stringify([EXTENSION]), BETTER_AUTH_SECRET: AUTH_SECRET },
    d1Databases: ["DB"], durableObjects: { BROWSER_ROOMS: { className: "BrowserRoom", useSQLite: true } },
    cf: false, logRequests: false
  }));
  const db = await mf.getD1Database("DB");
  for (const name of ["0001_auth.sql", "0002_browser_relay.sql"]) {
    const sql = await readFile(new URL("../migrations/" + name, import.meta.url), "utf8");
    const statements = sql.replace(/^--.*$/gm, "").split(";").map(s => s.trim()).filter(Boolean);
    await db.batch(statements.map(s => db.prepare(s)));
  }
  return { mf, db };
}
export const post = (body, headers = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
export async function seedSession(db, userId = randomUUID()) {
  const now = new Date().toISOString(), token = randomUUID();
  await db.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').bind(userId, "Test User", userId + "@example.test", 1, now, now).run();
  await db.prepare('INSERT INTO session (id,token,userId,createdAt,updatedAt,expiresAt) VALUES (?,?,?,?,?,?)')
    .bind(randomUUID(), token, userId, now, now, new Date(Date.now() + 3_600_000).toISOString()).run();
  const signature = createHmac("sha256", AUTH_SECRET).update(token).digest("base64");
  return { userId, cookie: "__Secure-better-auth.session_token=" + encodeURIComponent(token + "." + signature) };
}
export async function doRoom(mf, userId = "user-1") {
  const ns = await mf.getDurableObjectNamespace("BROWSER_ROOMS");
  return ns.get(ns.idFromName(userId));
}
export async function roomPost(stub, path, body) { return stub.fetch("https://room.internal" + path, post(body)); }
export async function socketFor(stub, installationId = randomUUID()) {
  const response = await stub.fetch("https://room.internal/connect", { headers: { Upgrade: "websocket", "X-Installation-Id": installationId } });
  if (response.status !== 101) throw Error(await response.text());
  const socket = response.webSocket; socket.accept();
  return { socket, installationId };
}
export const target = (tabId = 7) => ({ tabId, documentId: "doc-" + tabId, conversationId: "conversation-" + tabId });
export async function bind(stub, installationId, session = "chat-1", page = target()) {
  const challenge = await (await roomPost(stub, "/challenge", { session })).json();
  const response = await roomPost(stub, "/bind", { installationId, nonce: challenge.nonce, target: page });
  if (!response.ok) throw Error(JSON.stringify(await response.json()));
  return response.json();
}
export const message = socket => new Promise(resolve => socket.addEventListener("message", e => resolve(JSON.parse(e.data)), { once: true }));
export async function rpc(mf, method, params, token) {
  return mf.dispatchFetch(BASE + "/mcp", post({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }, {
    Accept: "application/json, text/event-stream", ...(token ? { Authorization: "Bearer " + token } : {})
  }));
}

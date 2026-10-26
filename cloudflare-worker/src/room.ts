import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { BINDING_TTL, CHALLENGE_TTL, MAX_BYTES, PublicError, errorResponse, json, readJson, secret, type Binding, type Env, type RpcRequest, type Target } from "./types";

const targetSchema = z.object({
  tabId: z.number().int().nonnegative(), documentId: z.string().min(1).max(128),
  conversationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
}).strict();
const sameTarget = (a: Target, b: Target) => a.tabId === b.tabId && a.documentId === b.documentId && a.conversationId === b.conversationId;
// These tabId fields identify a source page or a read-only diagnostic filter.
// Other built-in tabId fields are chat delivery/completion destinations.
const SOURCE_TAB_TOOLS = new Set(["site_read", "site_get_children", "site_get_node", "site_get_text", "site_interact", "site_get_images", "site_get_files", "system_get_diagnostics"]);
interface SocketIdentity { installationId: string; expiresAt: number }
interface Challenge { session: string; expiresAt: number }
interface StoredBinding extends Binding { ambiguous?: boolean }
interface Pending {
  socket: WebSocket; target: Binding;
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: PublicError) => void;
  timer: ReturnType<typeof setTimeout>;
}

// One object per authenticated ResearchTube user. It is never addressed by an
// untrusted installation ID, email, active tab, or MCP transport session ID.
export class BrowserRoom extends DurableObject<Env> {
  private pending = new Map<string, Pending>();

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/connect") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
        const installationId = request.headers.get("X-Installation-Id")!;
        const pair = new WebSocketPair();
        // A restarted adapter has no live document proofs. Never restore old
        // routes solely from its installation credential.
        for (const [key, binding] of await this.ctx.storage.list<StoredBinding>({ prefix: "binding:", limit: 201 })) {
          if (binding.installationId === installationId) { this.invalidate(binding); await this.ctx.storage.delete(key); }
        }
        for (const old of this.ctx.getWebSockets(installationId)) {
          this.rejectSocket(old, "BROWSER_DISCONNECTED", "The browser connection was replaced. The operation was not retried.");
          old.close(1000, "Replaced");
        }
        this.ctx.acceptWebSocket(pair[1], [installationId]);
        pair[1].serializeAttachment({ installationId, expiresAt: Date.now() + BINDING_TTL } satisfies SocketIdentity);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (path === "/challenge") {
        const { session } = z.object({ session: z.string().min(1).max(512) }).strict().parse(await readJson(request));
        await this.prune();
        if ((await this.ctx.storage.list({ prefix: "challenge:", limit: 101 })).size >= 100)
          throw new PublicError("BROWSER_BUSY", "Too many browser connections are pending.", 429);
        const nonce = secret();
        const value: Challenge = { session, expiresAt: Date.now() + CHALLENGE_TTL };
        await this.ctx.storage.put(`challenge:${nonce}`, value);
        await this.ctx.storage.setAlarm(Date.now() + CHALLENGE_TTL);
        return json({ nonce, expiresAt: value.expiresAt });
      }
      if (path === "/enrollment-check") {
        const { nonce } = z.object({ nonce: z.string().length(72) }).strict().parse(await readJson(request, 256));
        const challenge = await this.ctx.storage.get<Challenge>(`challenge:${nonce}`);
        if (!challenge || challenge.expiresAt <= Date.now()) throw new PublicError("BROWSER_ACCOUNT_MISMATCH", "This chat challenge does not belong to the ResearchTube account signed in to this browser, or it expired.", 409);
        return json({ valid: true });
      }
      if (path === "/bind") {
        const body = z.object({ installationId: z.string().uuid(), nonce: z.string().length(72), target: targetSchema }).strict().parse(await readJson(request));
        const challenge = await this.ctx.storage.get<Challenge>(`challenge:${body.nonce}`);
        if (!challenge || challenge.expiresAt <= Date.now()) throw new PublicError("BROWSER_BINDING_EXPIRED", "Reconnect this chat using the ResearchTube widget.", 409);
        // Block input interleaving across the single-use check, deletion and
        // persistent target updates while this capability is consumed.
        return await this.ctx.blockConcurrencyWhile(async () => {
          try {
            const current = await this.ctx.storage.get<Challenge>(`challenge:${body.nonce}`);
            if (!current || current.expiresAt <= Date.now()) throw new PublicError("BROWSER_BINDING_EXPIRED", "Reconnect this chat.", 409);
            await this.ctx.storage.delete(`challenge:${body.nonce}`);
            this.socket(body.installationId);
            const bindings = await this.ctx.storage.list<StoredBinding>({ prefix: "binding:", limit: 201 });
            const active = [...bindings.values()].filter(b => b.expiresAt > Date.now());
            if (active.some(b => b.session === current.session && b.ambiguous))
              throw new PublicError("BROWSER_CONTEXT_AMBIGUOUS", "Disconnect this conversation's conflicting bindings before reconnecting.", 409);
            const conflicts = active.filter(b => b.session === current.session && (b.installationId !== body.installationId || !sameTarget(b, body.target)));
            if (conflicts.length) {
              for (const binding of conflicts) {
                binding.ambiguous = true;
                await this.ctx.storage.put(`binding:${binding.bindingId}`, binding);
                this.invalidate(binding);
              }
              throw new PublicError("BROWSER_CONTEXT_AMBIGUOUS", "This conversation has another browser binding. Disconnect its bindings and reconnect from one tab.", 409);
            }
            const previous = active.find(b => b.session === current.session && b.installationId === body.installationId && sameTarget(b, body.target));
            if (previous) {
              previous.expiresAt = Date.now() + BINDING_TTL;
              await this.ctx.storage.put(`binding:${previous.bindingId}`, previous);
              return json({ bindingId: previous.bindingId, expiresAt: previous.expiresAt });
            }
            if (active.length >= 200) throw new PublicError("BROWSER_BUSY", "Too many browser bindings. Disconnect unused chats.", 429);
            const binding: Binding = { ...body.target, installationId: body.installationId, session: current.session,
              bindingId: crypto.randomUUID(), expiresAt: Date.now() + BINDING_TTL };
            await this.ctx.storage.put(`binding:${binding.bindingId}`, binding);
            return json({ bindingId: binding.bindingId, expiresAt: binding.expiresAt });
          } catch (error) {
            // Throwing out of blockConcurrencyWhile resets the Durable Object,
            // disconnecting unrelated browsers. Expected refusals are responses.
            return errorResponse(error);
          }
        });
      }
      if (path === "/status") {
        const { session } = z.object({ session: z.string().max(512) }).strict().parse(await readJson(request));
        const bindings = await this.ctx.storage.list<StoredBinding>({ prefix: "binding:", limit: 201 });
        const active = [...bindings.values()].filter(b => b.session === session && b.expiresAt > Date.now());
        const installations = [...new Set(this.ctx.getWebSockets().map(ws => ws.deserializeAttachment() as SocketIdentity)
          .filter(identity => identity?.expiresAt > Date.now()).map(identity => identity.installationId))].length;
        return json({ extensionConnected: installations > 0, connected: active.some(b => !b.ambiguous && this.online(b.installationId)),
          ambiguous: active.some(b => b.ambiguous), bindings: active.filter(b => !b.ambiguous).map(b => ({ bindingId: b.bindingId, expiresAt: b.expiresAt })) });
      }
      if (path === "/disconnect") {
        const { session } = z.object({ session: z.string().max(512) }).strict().parse(await readJson(request));
        for (const [key, binding] of await this.ctx.storage.list<StoredBinding>({ prefix: "binding:", limit: 201 })) {
          if (binding.session === session) { this.invalidate(binding); await this.ctx.storage.delete(key); }
        }
        return json({ disconnected: true });
      }
      if (path === "/release") {
        const { installationId, bindingId } = z.object({ installationId: z.string().uuid(), bindingId: z.string().uuid() }).strict().parse(await readJson(request));
        const binding = await this.ctx.storage.get<Binding>(`binding:${bindingId}`);
        if (!binding || binding.installationId !== installationId) throw new PublicError("NOT_FOUND", "This browser binding was not found.", 404);
        this.invalidate(binding);
        await this.ctx.storage.delete(`binding:${bindingId}`);
        return json({ released: true });
      }
      if (path === "/revoke") {
        const { installationId } = z.object({ installationId: z.string().uuid() }).strict().parse(await readJson(request));
        for (const socket of this.ctx.getWebSockets(installationId)) {
          this.rejectSocket(socket, "BROWSER_DISCONNECTED", "The extension was disconnected."); socket.close(1000, "Revoked");
        }
        for (const [key, binding] of await this.ctx.storage.list<StoredBinding>({ prefix: "binding:", limit: 201 })) {
          if (binding.installationId === installationId) { this.invalidate(binding); await this.ctx.storage.delete(key); }
        }
        return json({ revoked: true });
      }
      if (path === "/dispatch") {
        const body = z.object({ bindingId: z.string().uuid().optional(), session: z.string().min(1).max(512),
          request: z.object({ jsonrpc: z.literal("2.0"), method: z.enum(["tools/list", "tools/call", "resources/list", "resources/read"]),
            params: z.record(z.string(), z.unknown()).optional() }).strict()
        }).strict().parse(await readJson(request));
        let binding: StoredBinding | undefined;
        if (body.bindingId) binding = await this.ctx.storage.get<StoredBinding>(`binding:${body.bindingId}`);
        else {
          const records = await this.ctx.storage.list<StoredBinding>({ prefix: "binding:", limit: 201 });
          const matches = [...records.values()].filter(value => value.session === body.session && value.expiresAt > Date.now());
          if (matches.length > 1 || matches.some(value => value.ambiguous))
            throw new PublicError("BROWSER_CONTEXT_AMBIGUOUS", "Reconnect this conversation from one Chrome tab.", 409);
          binding = matches[0];
        }
        if (!binding || binding.expiresAt <= Date.now() || binding.session !== body.session)
          throw new PublicError("BROWSER_BINDING_REQUIRED", "Connect this ChatGPT tab with ResearchTube first.", 409);
        if (binding.ambiguous) throw new PublicError("BROWSER_CONTEXT_AMBIGUOUS", "Disconnect duplicate conversation bindings and reconnect from one tab.", 409);
        // A numeric Chrome tab ID is only meaningful inside this installation.
        const args = body.request.params?.arguments as Record<string, unknown> | undefined;
        if (args?.chatTabId !== undefined && args.chatTabId !== binding.tabId)
          throw new PublicError("BROWSER_TARGET_MISMATCH", "chatTabId differs from the connected chat.", 409);
        if (args?.tabId !== undefined && !SOURCE_TAB_TOOLS.has(String(body.request.params?.name)) && args.tabId !== binding.tabId)
          throw new PublicError("BROWSER_TARGET_MISMATCH", "The completion or file delivery tab differs from the connected chat.", 409);
        return json(await this.dispatch(binding, body.request));
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      if (error instanceof z.ZodError) return errorResponse(new PublicError("INVALID_REQUEST", "Invalid browser relay request."));
      return errorResponse(error);
    }
  }

  private online(id: string): boolean {
    return this.ctx.getWebSockets(id).some(ws => (ws.deserializeAttachment() as SocketIdentity)?.expiresAt > Date.now());
  }
  private socket(id: string): WebSocket {
    const socket = this.ctx.getWebSockets(id).find(ws => (ws.deserializeAttachment() as SocketIdentity)?.expiresAt > Date.now());
    if (!socket) throw new PublicError("BROWSER_DISCONNECTED", "Open Chrome with the ResearchTube extension on the connected browser profile.", 409);
    return socket;
  }
  private invalidate(binding: Binding) {
    for (const ws of this.ctx.getWebSockets(binding.installationId)) {
      try { ws.send(JSON.stringify({ type: "invalidate", bindingId: binding.bindingId })); } catch { /* Already closed. */ }
    }
    for (const [id, pending] of this.pending) if (pending.target.bindingId === binding.bindingId) {
      clearTimeout(pending.timer); this.pending.delete(id);
      pending.reject(new PublicError("BROWSER_BINDING_CHANGED", "The chat binding changed. The operation was not retried.", 409));
    }
  }
  private dispatch(target: Binding, request: RpcRequest): Promise<Record<string, unknown>> {
    if (this.pending.size >= 100) throw new PublicError("BROWSER_BUSY", "Too many browser requests are running.", 429);
    const socket = this.socket(target.installationId), requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new PublicError("BROWSER_OUTCOME_UNKNOWN", "The browser did not acknowledge the request. Do not automatically repeat an action; inspect its state first.", 504));
      }, 25_000);
      this.pending.set(requestId, { socket, target: structuredClone(target), resolve, reject, timer });
      try { socket.send(JSON.stringify({ type: "request", requestId, target, request })); }
      catch { clearTimeout(timer); this.pending.delete(requestId); reject(new PublicError("BROWSER_DISCONNECTED", "The browser disconnected. The request was not retried.", 409)); }
    });
  }

  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    const identity = socket.deserializeAttachment() as SocketIdentity;
    if (!identity || identity.expiresAt <= Date.now()) { this.rejectSocket(socket, "BROWSER_DISCONNECTED", "Reconnect the extension."); socket.close(1008, "Expired"); return; }
    // Heartbeats keep Chrome's MV3 worker alive without replaying tool calls.
    if (data === '{"type":"ping"}') { socket.send('{"type":"pong"}'); return; }
    if (typeof data !== "string" || new TextEncoder().encode(data).length > MAX_BYTES) { socket.close(1009, "Invalid payload"); this.rejectSocket(socket, "BROWSER_PROTOCOL_ERROR", "The browser returned an invalid response."); return; }
    if (data === "ping") { socket.send("pong"); return; }
    try {
      const msg = z.object({ type: z.literal("response"), requestId: z.string().uuid(), target: targetSchema,
        result: z.record(z.string(), z.unknown()).optional(), error: z.object({ code: z.number().int(), message: z.string().max(500) }).strict().optional()
      }).strict().refine(v => (v.result !== undefined) !== (v.error !== undefined)).parse(JSON.parse(data));
      const pending = this.pending.get(msg.requestId);
      if (!pending) return; // Late/duplicate responses never acknowledge another call.
      if (pending.socket !== socket || pending.target.installationId !== identity.installationId || !sameTarget(pending.target, msg.target)) {
        // A different installation cannot settle, fail, or cancel this request.
        if (pending.socket !== socket) return;
        clearTimeout(pending.timer); this.pending.delete(msg.requestId);
        pending.reject(new PublicError("BROWSER_TARGET_MISMATCH", "The browser response came from a different document.", 409)); return;
      }
      clearTimeout(pending.timer); this.pending.delete(msg.requestId);
      pending.resolve(msg.error ? { error: msg.error } : { result: msg.result });
    } catch { socket.close(1008, "Invalid response"); this.rejectSocket(socket, "BROWSER_PROTOCOL_ERROR", "The browser returned an invalid response."); }
  }
  private rejectSocket(socket: WebSocket, code: string, message: string) {
    for (const [id, pending] of this.pending) if (pending.socket === socket) {
      clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new PublicError(code, message, 409));
    }
  }
  webSocketClose(socket: WebSocket) { this.rejectSocket(socket, "BROWSER_DISCONNECTED", "The browser disconnected. The operation was not retried."); }
  webSocketError(socket: WebSocket) { this.webSocketClose(socket); }
  private async prune() {
    let next = Infinity;
    for (const prefix of ["binding:", "challenge:"]) {
      for (const [key, value] of await this.ctx.storage.list<{ expiresAt: number }>({ prefix, limit: 301 })) {
        if (value.expiresAt <= Date.now()) {
          if (prefix === "binding:") this.invalidate(value as Binding);
          await this.ctx.storage.delete(key);
        }
        else next = Math.min(next, value.expiresAt);
      }
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }
  async alarm() { await this.prune(); }
}

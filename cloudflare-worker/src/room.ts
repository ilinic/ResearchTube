import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import validateArguments from "./validators.js";
import { SOCKET_TTL, MAX_BYTES, PublicError, errorResponse, json, readJson, type Env } from "./types";

type ToolCallRequest = { jsonrpc: "2.0"; method: "tools/call"; params: { name: string; arguments: Record<string, unknown> } };

interface SocketIdentity { installationId: string; expiresAt: number; directTools?: boolean }
interface Pending {
  socket: WebSocket;
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: PublicError) => void;
  timer: ReturnType<typeof setTimeout>;
  chatTabId?: number;
  tool: string;
}
// Exactly one authenticated extension per account. No conversation handshakes,
// focus guesses, queued execution or automatic replay after an unknown outcome.
export class BrowserRoom extends DurableObject<Env> {
  private pending = new Map<string, Pending>();
  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/activate") {
        const { installationId } = z.object({ installationId: z.string().uuid() }).strict().parse(await readJson(request));
        return await this.ctx.blockConcurrencyWhile(async () => {
          const valid = await this.env.DB.prepare("SELECT id FROM rt_installation WHERE id = ? AND revoked_at IS NULL").bind(installationId).first();
          if (!valid) return errorResponse(new PublicError("EXTENSION_AUTHENTICATION_REQUIRED", "This extension connection was replaced.", 401));
          await this.ctx.storage.put("active-installation", installationId);
          for (const ws of this.ctx.getWebSockets()) {
            if ((ws.deserializeAttachment() as SocketIdentity)?.installationId === installationId) continue;
            try { ws.send(JSON.stringify({ type: "disconnect", code: "EXTENSION_REPLACED" })); } catch {}
            this.rejectSocket(ws, "EXTENSION_REPLACED", "Another extension connected to this account.");
            ws.close(1000, "Replaced");
          }
          return json({ active: true });
        });
      }
      if (path === "/connect") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
        const installationId = z.string().uuid().parse(request.headers.get("X-Installation-Id"));
        return await this.ctx.blockConcurrencyWhile(async () => {
          const active = await this.ctx.storage.get<string>("active-installation");
          if (active && active !== installationId) return errorResponse(new PublicError("EXTENSION_REPLACED", "Another extension is connected to this account.", 401));
          await this.ctx.storage.put("active-installation", installationId);
          for (const old of this.ctx.getWebSockets()) {
            this.rejectSocket(old, "EXTENSION_OFFLINE", "The extension connection ended. The operation was not retried.");
            old.close(1000, "Replaced");
          }
          const pair = new WebSocketPair();
          this.ctx.acceptWebSocket(pair[1], [installationId]);
          pair[1].serializeAttachment({ installationId, expiresAt: Date.now() + SOCKET_TTL } satisfies SocketIdentity);
          return new Response(null, { status: 101, webSocket: pair[0] });
        });
      }
      if (path === "/status") {
        z.object({}).strict().parse(await readJson(request));
        return json({ extensionConnected: Boolean(await this.activeSocket(false)) });
      }
      if (path === "/revoke") {
        const { installationId } = z.object({ installationId: z.string().uuid() }).strict().parse(await readJson(request));
        for (const ws of this.ctx.getWebSockets(installationId)) {
          this.rejectSocket(ws, "EXTENSION_OFFLINE", "The extension was disconnected."); ws.close(1000, "Revoked");
        }
        if (await this.ctx.storage.get("active-installation") === installationId) await this.ctx.storage.put("active-installation", "revoked:" + installationId);
        return json({ revoked: true });
      }
      if (path === "/dispatch") {
        const body = z.object({ request: z.object({ jsonrpc: z.literal("2.0"), method: z.literal("tools/call"),
          params: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }).strict() }).strict(),
          workerReceivedAtMs: z.number().int().nonnegative() }).strict().parse(await readJson(request));
        const name = body.request.params.name;
        if (!Object.hasOwn(validateArguments, name) || name === "system_connection_status" || !(validateArguments as Record<string, any>)[name](body.request.params.arguments))
          throw new PublicError("INVALID_ARGUMENT", "Arguments do not match an available tool.");
        const socket = await this.activeSocket();
        if (!socket) throw new PublicError("EXTENSION_OFFLINE", "Open Chrome with the connected ResearchTube extension.", 409);
        return json(await this.dispatch(socket, body.request, body.workerReceivedAtMs, Date.now()));
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      if (error instanceof z.ZodError) return errorResponse(new PublicError("INVALID_REQUEST", "Invalid extension relay request."));
      return errorResponse(error);
    }
  }
  private async activeSocket(requireDirect = true): Promise<WebSocket | undefined> {
    const active = await this.ctx.storage.get<string>("active-installation");
    const sockets = this.ctx.getWebSockets().filter(ws => {
      const value = ws.deserializeAttachment() as SocketIdentity;
      return value?.expiresAt > Date.now() && value.installationId === active && ws.readyState === 1;
    });
    if (sockets.length > 1) throw new PublicError("EXTENSION_AMBIGUOUS", "Reconnect one ResearchTube extension.", 409);
    if (requireDirect && sockets.length && !(sockets[0].deserializeAttachment() as SocketIdentity).directTools)
      throw new PublicError("EXTENSION_UPDATE_REQUIRED", "Update the ResearchTube extension to run tools directly.", 409);
    return sockets[0];
  }
  private dispatch(socket: WebSocket, request: ToolCallRequest, workerReceivedAtMs: number, roomReceivedAtMs: number): Promise<Record<string, unknown>> {
    if (this.pending.size >= 100) throw new PublicError("BROWSER_BUSY", "Too many requests are running.", 429);
    const requestId = crypto.randomUUID();
    const argumentChatTabId = request.params.arguments.chatTabId;
    const chatTabId = typeof argumentChatTabId === "number" && Number.isSafeInteger(argumentChatTabId) && argumentChatTabId >= 0 ? argumentChatTabId : undefined;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new PublicError("BROWSER_OUTCOME_UNKNOWN", "The extension did not acknowledge the request. Inspect its state before repeating an action.", 504));
      }, 25_000);
      this.pending.set(requestId, { socket, resolve, reject, timer, tool: request.params.name,
        ...(chatTabId !== undefined ? { chatTabId } : {}) });
      try { socket.send(JSON.stringify({ type: "request", requestId, installationId: (socket.deserializeAttachment() as SocketIdentity).installationId, request,
        timing: { workerReceivedAtMs, roomReceivedAtMs, roomForwardedAtMs: Date.now() } })); }
      catch { clearTimeout(timer); this.pending.delete(requestId); reject(new PublicError("EXTENSION_OFFLINE", "The extension disconnected. The request was not retried.", 409)); }
    });
  }
  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    const identity = socket.deserializeAttachment() as SocketIdentity;
    if (!identity || identity.expiresAt <= Date.now()) { this.rejectSocket(socket, "EXTENSION_OFFLINE", "The extension session expired."); socket.close(1008, "Expired"); return; }
    if (data === "direct-tools-v1") {
      socket.serializeAttachment({ ...identity, directTools: true }); socket.send("direct-tools-ready"); return;
    }
    if (data === "ping") { socket.send("pong"); return; }
    if (typeof data !== "string" || new TextEncoder().encode(data).length > MAX_BYTES) { socket.close(1009, "Invalid payload"); this.rejectSocket(socket, "BROWSER_PROTOCOL_ERROR", "Invalid extension response."); return; }
    try {
      const msg = z.object({ type: z.literal("response"), requestId: z.string().uuid(),
        result: z.record(z.string(), z.unknown()).optional(), error: z.object({ code: z.number().int(), message: z.string().max(500) }).strict().optional()
      }).strict().refine(value => (value.result !== undefined) !== (value.error !== undefined)).parse(JSON.parse(data));
      const pending = this.pending.get(msg.requestId);
      if (!pending || pending.socket !== socket) return;
      clearTimeout(pending.timer); this.pending.delete(msg.requestId);
      // Only safe correlation/timestamps return to the extension recorder.
      if (pending.tool.startsWith("site_") && pending.chatTabId !== undefined) {
        try { socket.send(JSON.stringify({ type: "timing", requestId: msg.requestId, tool: pending.tool,
          chatTabId: pending.chatTabId, roomRespondedAtMs: Date.now() })); } catch {}
      }
      pending.resolve(msg.error ? { error: msg.error } : { result: msg.result });
    } catch { socket.close(1008, "Invalid response"); this.rejectSocket(socket, "BROWSER_PROTOCOL_ERROR", "Invalid extension response."); }
  }
  private rejectSocket(socket: WebSocket, code: string, message: string) {
    for (const [id, pending] of this.pending) if (pending.socket === socket) {
      clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new PublicError(code, message, 409));
    }
  }
  webSocketClose(socket: WebSocket) { this.rejectSocket(socket, "EXTENSION_OFFLINE", "The extension disconnected. The operation was not retried."); }
  webSocketError(socket: WebSocket) { this.webSocketClose(socket); }
  // Retire alarms left by the former conversation-binding protocol.
  async alarm() { await this.ctx.storage.deleteAlarm(); }
}

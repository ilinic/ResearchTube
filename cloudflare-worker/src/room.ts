import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import validateArguments from "./validators.js";
import { MAX_BYTES, PublicError, errorResponse, json, readJson, type Env } from "./types";

type ToolCallRequest = { jsonrpc: "2.0"; method: "tools/call"; params: { name: string; arguments: Record<string, unknown> } };

interface SocketIdentity { installationId: string; connectionId?: string; directTools?: boolean }
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
  private reconnectWaiters = 0;
  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/activate") {
        const { installationId } = z.object({ installationId: z.string().uuid() }).strict().parse(await readJson(request));
        return await this.ctx.blockConcurrencyWhile(async () => {
          const valid = await this.env.DB.prepare("SELECT id FROM rt_installation WHERE id = ? AND revoked_at IS NULL").bind(installationId).first();
          if (!valid) return errorResponse(new PublicError("EXTENSION_AUTHENTICATION_REQUIRED", "This extension connection was replaced.", 401));
          const previous = await this.ctx.storage.get<string>("active-installation");
          await this.ctx.storage.put("active-installation", installationId);
          if (previous !== installationId) await this.ctx.storage.delete("active-connection");
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
          const connectionId = crypto.randomUUID();
          this.ctx.acceptWebSocket(pair[1], [installationId, connectionId]);
          pair[1].serializeAttachment({ installationId, connectionId } satisfies SocketIdentity);
          await this.ctx.storage.put("active-connection", connectionId);
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
        if (await this.ctx.storage.get("active-installation") === installationId) {
          await this.ctx.storage.put("active-installation", "revoked:" + installationId);
          await this.ctx.storage.delete("active-connection");
        }
        return json({ revoked: true });
      }
      if (path === "/dispatch") {
        const body = z.object({ request: z.object({ jsonrpc: z.literal("2.0"), method: z.literal("tools/call"),
          params: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }).strict() }).strict(),
          workerReceivedAtMs: z.number().int().nonnegative(), requestId: z.string().uuid().optional() }).strict().parse(await readJson(request));
        const name = body.request.params.name;
        if (!Object.hasOwn(validateArguments, name) || name === "system_connection_status" || !(validateArguments as Record<string, any>)[name](body.request.params.arguments))
          throw new PublicError("INVALID_ARGUMENT", "Arguments do not match an available tool.");
        const socket = await this.waitForSocket();
        return json(await this.dispatch(socket, body.request, body.workerReceivedAtMs, Date.now(), body.requestId));
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      if (error instanceof z.ZodError) return errorResponse(new PublicError("INVALID_REQUEST", "Invalid extension relay request."));
      return errorResponse(error);
    }
  }
  private async activeSocket(requireDirect = true): Promise<WebSocket | undefined> {
    const active = await this.ctx.storage.get<string>("active-installation");
    const connectionId = await this.ctx.storage.get<string>("active-connection");
    if (!connectionId) {
      // One-time migration: legacy sockets have no connection ID. Close them so
      // their owner reconnects with an explicit active connection; never guess.
      for (const old of this.ctx.getWebSockets()) {
        this.rejectSocket(old, "EXTENSION_OFFLINE", "Reconnect ResearchTube to select the active extension.");
        try { old.close(1012, "Reconnect required"); } catch {}
      }
      return undefined;
    }
    const socket = this.ctx.getWebSockets(connectionId).find(ws => {
      const value = ws.deserializeAttachment() as SocketIdentity;
      return value?.connectionId === connectionId && value.installationId === active &&
        ws.readyState === 1;
    });
    if (requireDirect && socket && !(socket.deserializeAttachment() as SocketIdentity).directTools)
      throw new PublicError("EXTENSION_UPDATE_REQUIRED", "Update the ResearchTube extension to run tools directly.", 409);
    return socket;
  }
  // Wait only before forwarding; never replay a request after it may have run.
  private async waitForSocket(): Promise<WebSocket> {
    const installation = await this.ctx.storage.get<string>("active-installation");
    if (!installation || installation.startsWith("revoked:")) throw new PublicError("EXTENSION_OFFLINE", "Open Chrome with the connected ResearchTube extension.", 409);
    if (this.reconnectWaiters >= 100) throw new PublicError("BROWSER_BUSY", "Too many requests are waiting for reconnect.", 429);
    this.reconnectWaiters++;
    try {
      const deadline=Date.now()+12000;
      do {
        if(await this.ctx.storage.get<string>("active-installation")!==installation) throw new PublicError("EXTENSION_REPLACED", "The authorized extension changed before dispatch.",409);
        const socket=await this.activeSocket(false);
        if(socket && (socket.deserializeAttachment() as SocketIdentity).directTools && (socket.deserializeAttachment() as SocketIdentity).installationId===installation) return socket;
        if(Date.now()>=deadline) break;
        await new Promise<void>(resolve=>setTimeout(resolve,250));
      } while(true);
      if(await this.activeSocket(false)) throw new PublicError("EXTENSION_UPDATE_REQUIRED", "The extension did not complete its protocol handshake.",409);
      throw new PublicError("EXTENSION_OFFLINE", "Extension reconnect timed out; no tool was dispatched. Retry after Chrome reconnects.",503);
    } finally {this.reconnectWaiters--;}
  }
  private dispatch(socket: WebSocket, request: ToolCallRequest, workerReceivedAtMs: number, roomReceivedAtMs: number, requestId: string = crypto.randomUUID()): Promise<Record<string, unknown>> {
    if (this.pending.size >= 100) throw new PublicError("BROWSER_BUSY", "Too many requests are running.", 429);
    const argumentChatTabId = request.params.arguments.chatTabId;
    const chatTabId = typeof argumentChatTabId === "number" && Number.isSafeInteger(argumentChatTabId) && argumentChatTabId >= 0 ? argumentChatTabId : undefined;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        console.warn(JSON.stringify({component:"relay",event:"REQUEST_TIMEOUT",requestId,tool:request.params.name,atMs:Date.now(),executionState:"unknown"}));
        reject(new PublicError("BROWSER_OUTCOME_UNKNOWN", "The extension did not acknowledge the request. Inspect its state before repeating an action.", 504));
      }, 25_000);
      this.pending.set(requestId, { socket, resolve, reject, timer, tool: request.params.name,
        ...(chatTabId !== undefined ? { chatTabId } : {}) });
      try { socket.send(JSON.stringify({ type: "request", requestId, installationId: (socket.deserializeAttachment() as SocketIdentity).installationId, request,
        timing: { workerReceivedAtMs, roomReceivedAtMs, roomForwardedAtMs: Date.now() } })); }
      catch { clearTimeout(timer); this.pending.delete(requestId); reject(new PublicError("BROWSER_OUTCOME_UNKNOWN", "The extension disconnected during dispatch. Reconcile before retrying.", 409)); }
    });
  }
  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    const identity = socket.deserializeAttachment() as SocketIdentity;
    if (!identity?.connectionId) { this.rejectSocket(socket, "BROWSER_OUTCOME_UNKNOWN", "The extension session is invalid."); socket.close(1008, "Invalid session"); return; }
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
      clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new PublicError(["EXTENSION_OFFLINE","EXTENSION_REPLACED"].includes(code)?"BROWSER_OUTCOME_UNKNOWN":code, ["EXTENSION_OFFLINE","EXTENSION_REPLACED"].includes(code)?"Connection ended after dispatch; reconcile before retrying.":message, 409));
    }
  }
  webSocketClose(socket: WebSocket) { this.rejectSocket(socket, "EXTENSION_OFFLINE", "The extension disconnected. The operation was not retried."); }
  webSocketError(socket: WebSocket) { this.webSocketClose(socket); }
  // Retire alarms left by the former conversation-binding protocol.
  async alarm() { await this.ctx.storage.deleteAlarm(); }
}

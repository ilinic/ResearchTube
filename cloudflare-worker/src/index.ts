import { z } from "zod";
import { createAuth, browserUser, MCP_SCOPE } from "./auth";
import { mcpResponse, roomRequest } from "./mcp";
import { authScript, page } from "./pages";
import { WORKER_VERSION } from "./version";
import { bearer, digest, errorResponse, extensionOrigins, json, origin, PublicError, readBytes, readJson, room, secret, type Env } from "./types";
export { BrowserRoom } from "./room";

const authPaths = new Set(["/get-session", "/sign-in/social", "/sign-out", "/jwks", "/oauth2/authorize", "/oauth2/token", "/oauth2/register",
  "/oauth2/consent", "/oauth2/continue", "/oauth2/introspect", "/oauth2/revoke", "/oauth2/userinfo", "/oauth2/logout",
  "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]);
interface Installation { id: string; user_id: string }
async function installation(request: Request, env: Env): Promise<Installation> {
  const found = await env.DB.prepare("SELECT id, user_id FROM rt_installation WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(await digest(bearer(request))).first<Installation>();
  if (!found) throw new PublicError("EXTENSION_AUTHENTICATION_REQUIRED", "Reconnect the ResearchTube extension.", 401);
  return found;
}
function sameOrigin(request: Request, env: Env) {
  if (request.headers.get("Origin") !== origin(env)) throw new PublicError("ORIGIN_NOT_ALLOWED", "Open the ResearchTube setup page to continue.", 403);
}
function checkHostAndOrigin(request: Request, env: Env) {
  const expected = origin(env);
  if (new URL(request.url).origin !== expected) throw new PublicError("HOST_NOT_ALLOWED", "Use the configured ResearchTube HTTPS address.", 403);
  const supplied = request.headers.get("Origin");
  if (supplied && ![expected, "https://chatgpt.com", ...extensionOrigins(env)].includes(supplied))
    throw new PublicError("ORIGIN_NOT_ALLOWED", "This origin is not allowed.", 403);
}

async function route(request: Request, env: Env): Promise<Response> {
  checkHostAndOrigin(request, env);
  const url = new URL(request.url), base = origin(env), path = url.pathname;
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (path === "/health" && request.method === "GET") return json({ service: "ResearchTube", version: WORKER_VERSION, status: "ok" });
  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")
    return json({ resource: `${base}/mcp`, authorization_servers: [`${base}/api/auth`], scopes_supported: [MCP_SCOPE], bearer_methods_supported: ["header"] });
  // These pages must not start asynchronous auth/D1 work that outlives their
  // response. Only endpoints that use authentication initialize it below.
  if (path === "/" || path === "/sign-in") return page("sign-in", env);
  if (path === "/consent") return page("consent", env);
  if (path === "/auth-ui.js") return authScript();
  const auth = await createAuth(env);
  if (path === "/.well-known/oauth-authorization-server/api/auth" || path === "/.well-known/openid-configuration/api/auth") {
    const endpoint = path.includes("openid") ? "openid-configuration" : "oauth-authorization-server";
    return auth.handler(new Request(`${base}/api/auth/.well-known/${endpoint}`, request));
  }
  if (path.startsWith("/api/auth/")) {
    const suffix = path.slice("/api/auth".length);
    // Private verifier and account/client/resource administration are never
    // exposed merely because a library adds an endpoint.
    if (!authPaths.has(suffix) && !/^\/callback\/(google|microsoft)$/.test(suffix)) return new Response(null, { status: 404 });
    if (request.method === "POST" && request.body) {
      // Bound upstream library input too, including form-encoded token requests.
      const bytes = await readBytes(request, 32_768);
      return auth.handler(new Request(request, { body: bytes }));
    }
    return auth.handler(request);
  }
  if (path === "/account") { await browserUser(request, auth); return page("account", env); }
  if (path === "/mcp") return mcpResponse(request, env, auth);
  if (path === "/api/installations" && request.method === "POST") {
    sameOrigin(request, env);
    const userId = await browserUser(request, auth);
    const input = z.object({ name: z.string().trim().min(1).max(80), extensionOrigin: z.string() }).strict().parse(await readJson(request, 2048));
    if (!extensionOrigins(env).includes(input.extensionOrigin)) throw new PublicError("EXTENSION_NOT_ALLOWED", "This extension is not configured on the server.", 403);
    const id = crypto.randomUUID(), token = secret();
    const result = await env.DB.prepare(`INSERT INTO rt_installation (id, user_id, name, extension_origin, token_hash, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM rt_installation WHERE user_id = ? AND revoked_at IS NULL) < 20`)
      .bind(id, userId, input.name, input.extensionOrigin, await digest(token), Date.now(), userId).run();
    if (!result.meta.changes) throw new PublicError("INSTALLATION_LIMIT", "Disconnect an unused extension installation first.", 409);
    // This credential goes only to the local setup bridge, never MCP or a URL.
    return json({ installationId: id, installationToken: token }, 201);
  }
  if (/^\/api\/installations\/[a-f0-9-]{36}$/.test(path) && request.method === "DELETE") {
    sameOrigin(request, env);
    const userId = await browserUser(request, auth), id = path.split("/").pop()!;
    const result = await env.DB.prepare("UPDATE rt_installation SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(Date.now(), id, userId).run();
    if (!result.meta.changes) throw new PublicError("NOT_FOUND", "The extension installation was not found.", 404);
    await roomRequest(env, userId, "/revoke", { installationId: id });
    return json({ revoked: true });
  }
  if (path === "/api/relay-ticket" && request.method === "POST") {
    const device = await installation(request, env);
    // Bound ticket issuance and clean expired tickets without a paid cron job.
    const updated = await env.DB.prepare("UPDATE rt_installation SET ticket_at = ? WHERE id = ? AND (ticket_at IS NULL OR ticket_at < ?)").bind(Date.now(), device.id, Date.now() - 5000).run();
    if (!updated.meta.changes) throw new PublicError("RETRY_LATER", "Wait before reconnecting the extension.", 429);
    const ticket = secret(), expiresAt = Date.now() + 15_000;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM rt_relay_ticket WHERE expires_at <= ?").bind(Date.now()),
      env.DB.prepare("INSERT INTO rt_relay_ticket (token_hash, installation_id, expires_at) VALUES (?, ?, ?)").bind(await digest(ticket), device.id, expiresAt)
    ]);
    return json({ ticket, expiresAt });
  }
  if (path === "/relay" && request.method === "GET") {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
    const ticket = url.searchParams.get("ticket");
    if (!ticket || ticket.length !== 72) throw new PublicError("EXTENSION_AUTHENTICATION_REQUIRED", "A fresh relay ticket is required.", 401);
    const consumed = await env.DB.prepare("DELETE FROM rt_relay_ticket WHERE token_hash = ? AND expires_at > ? RETURNING installation_id")
      .bind(await digest(ticket), Date.now()).first<{ installation_id: string }>();
    const device = consumed && await env.DB.prepare("SELECT id, user_id FROM rt_installation WHERE id = ? AND revoked_at IS NULL").bind(consumed.installation_id).first<Installation>();
    if (!device) throw new PublicError("EXTENSION_AUTHENTICATION_REQUIRED", "The relay ticket expired or was already used.", 401);
    return room(env, device.user_id).fetch(new Request("https://room.internal/connect", { headers: { Upgrade: "websocket", "X-Installation-Id": device.id } }));
  }
  if (path === "/api/browser/bind" && request.method === "POST") {
    const device = await installation(request, env);
    const input = z.object({ nonce: z.string().length(72), target: z.object({ tabId: z.number().int().nonnegative(),
      documentId: z.string().min(1).max(128), conversationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict() }).strict().parse(await readJson(request, 2048));
    return json(await roomRequest(env, device.user_id, "/bind", { installationId: device.id, ...input }));
  }
  if (path === "/api/browser/release" && request.method === "POST") {
    const device = await installation(request, env);
    const input = z.object({ bindingId: z.string().uuid() }).strict().parse(await readJson(request, 2048));
    return json(await roomRequest(env, device.user_id, "/release", { installationId: device.id, ...input }));
  }
  return new Response(null, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response;
    try { response = await route(request, env); }
    catch (error) { response = errorResponse(error instanceof z.ZodError ? new PublicError("INVALID_REQUEST", "Invalid ResearchTube request.") : error); }
    if (response.status === 101) return response;
    const headers = new Headers(response.headers);
    headers.set("X-Content-Type-Options", "nosniff"); headers.set("Referrer-Policy", "no-referrer");
    const supplied = request.headers.get("Origin");
    try {
      if (supplied && [origin(env), "https://chatgpt.com", ...extensionOrigins(env)].includes(supplied)) {
        headers.set("Access-Control-Allow-Origin", supplied);
        headers.set("Vary", "Origin");
        headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id");
        headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        headers.set("Access-Control-Expose-Headers", "WWW-Authenticate");
        if (supplied === origin(env)) headers.set("Access-Control-Allow-Credentials", "true");
      }
    } catch { /* Invalid deployment configuration was already reported safely. */ }
    return new Response(response.body, { status: response.status, headers });
  }
};

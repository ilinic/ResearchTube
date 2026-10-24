import type { BrowserRoom } from "./room";

export interface Env {
  DB: D1Database;
  BROWSER_ROOMS: DurableObjectNamespace<BrowserRoom>;
  PUBLIC_ORIGIN: string;
  EXTENSION_ORIGINS: string;
  ALLOW_LOCAL_DEVELOPMENT?: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Target {
  tabId: number;
  documentId: string;
  conversationId: string;
}
export interface Binding extends Target {
  installationId: string;
  bindingId: string;
  session: string;
  expiresAt: number;
}
export interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export class PublicError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export const MAX_BYTES = 1024 * 1024;
export const BINDING_TTL = 60 * 60 * 1000;
export const CHALLENGE_TTL = 30_000;

export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
}
export function errorResponse(error: unknown): Response {
  return error instanceof PublicError ? json({ error: { code: error.code, message: error.message } }, error.status)
    : json({ error: { code: "INTERNAL_ERROR", message: "ResearchTube could not complete this request." } }, 500);
}
export async function readJson(request: Request, limit = MAX_BYTES): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new PublicError("CONTENT_TYPE_REQUIRED", "Use application/json.", 415);
  const bytes = await readBytes(request, limit);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new PublicError("INVALID_JSON", "The request is not valid UTF-8 JSON."); }
}
export async function readBytes(request: Request, limit: number): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > limit) throw new PublicError("REQUEST_TOO_LARGE", "Request is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new PublicError("INVALID_JSON", "A JSON body is required.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new PublicError("REQUEST_TOO_LARGE", "Request is too large.", 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { reader.releaseLock(); }
}
export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join("");
}
export function secret(): string { return crypto.randomUUID() + crypto.randomUUID(); }
export function bearer(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9._~-]{20,4096})$/.exec(request.headers.get("authorization") || "");
  if (!match) throw new PublicError("AUTHENTICATION_REQUIRED", "Connect your ResearchTube account.", 401);
  return match[1];
}
export function origin(env: Env): string {
  const url = new URL(env.PUBLIC_ORIGIN);
  if (url.origin !== env.PUBLIC_ORIGIN || url.username || url.password ||
      (url.protocol !== "https:" && !(env.ALLOW_LOCAL_DEVELOPMENT === "true" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))))
    throw new Error("PUBLIC_ORIGIN must be an HTTPS origin (or explicit local development).");
  return url.origin;
}
export function extensionOrigins(env: Env): string[] {
  const values: unknown = JSON.parse(env.EXTENSION_ORIGINS);
  if (!Array.isArray(values) || values.some(v => typeof v !== "string" || !/^chrome-extension:\/\/[a-p]{32}$/.test(v)))
    throw new Error("EXTENSION_ORIGINS must contain exact Chrome extension origins.");
  return values;
}
export function room(env: Env, userId: string) {
  return env.BROWSER_ROOMS.get(env.BROWSER_ROOMS.idFromName(userId));
}

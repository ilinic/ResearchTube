import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { getOAuthProviderApi, oauthProvider, type OAuthOptions, type Scope, type ActiveAccessTokenPayload } from "@better-auth/oauth-provider";
import { z } from "zod";
import { bearer, extensionOrigins, origin, PublicError, type Env } from "./types";

export const MCP_SCOPE = "researchtube:use";

// Reuse one configuration for schema generation, authorization and verification.
export function authOptions(env: Env): BetterAuthOptions {
  const base = origin(env);
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) throw new Error("Set BETTER_AUTH_SECRET to at least 32 random characters.");
  const oauth: OAuthOptions<Scope[]> = {
    loginPage: "/sign-in", consentPage: "/consent",
    scopes: ["openid", "profile", "email", "offline_access", MCP_SCOPE],
    resources: [{ identifier: `${base}/mcp`, allowedScopes: [MCP_SCOPE, "openid", "profile", "email", "offline_access"], accessTokenTtl: 300 }],
    clientRegistrationDefaultResources: [`${base}/mcp`],
    grantTypes: ["authorization_code", "refresh_token"],
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    // Only pre-registered exact redirect URIs are accepted; no wildcard relaxation.
    clientPrivileges: () => false,
    resourcePrivileges: () => false,
    accessTokenExpiresIn: 300
  };
  return {
    appName: "ResearchTube", baseURL: base, basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET, database: env.DB,
    trustedOrigins: [base, ...extensionOrigins(env)],
    emailAndPassword: { enabled: false },
    account: { accountLinking: { enabled: false }, encryptOAuthTokens: true },
    advanced: { database: { generateId: () => crypto.randomUUID() }, ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    logger: { disabled: true },
    rateLimit: { enabled: true, storage: "database" as const, window: 60, max: 60 },
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { google: {
        clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET
      } } : {}),
      ...(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET ? { microsoft: {
        clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET, tenantId: "common"
      } } : {})
    },
    plugins: [jwt({ jwt: { issuer: `${base}/api/auth` } }), oauthProvider(oauth), {
      id: "researchtube-token-verification",
      endpoints: {
        verifyResearchTubeToken: createAuthEndpoint("/researchtube-verify", {
          method: "POST", body: z.object({ token: z.string().max(4096) })
        }, async ctx => getOAuthProviderApi(ctx, oauth).requireActiveAccessToken(ctx.body.token))
      }
    } satisfies BetterAuthPlugin]
  };
}
// Keep the application boundary small; do not instantiate the entire library's
// deeply inferred endpoint surface in every Worker and test module.
export interface Auth {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(options: { headers: Headers }): Promise<{ user: { id: string } } | null>;
    verifyResearchTubeToken(options: { body: { token: string } }): Promise<ActiveAccessTokenPayload>;
  };
}
const instances = new WeakMap<object, { key: string; auth: Auth }>();
export function createAuth(env: Env): Auth {
  const key = JSON.stringify([env.PUBLIC_ORIGIN, env.EXTENSION_ORIGINS, env.BETTER_AUTH_SECRET,
    env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET]);
  const cached = instances.get(env.DB);
  if (cached?.key === key) return cached.auth;
  const auth = betterAuth(authOptions(env)) as unknown as Auth;
  instances.set(env.DB, { key, auth });
  return auth;
}

export async function authenticateMcp(request: Request, env: Env, auth: Auth): Promise<string> {
  const token = bearer(request);
  let claims;
  try { claims = await auth.api.verifyResearchTubeToken({ body: { token } }); }
  catch { throw new PublicError("AUTHENTICATION_REQUIRED", "Reconnect your ResearchTube account.", 401); }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const scopes = typeof claims.scope === "string" ? claims.scope.split(" ") : [];
  if (claims.cnf || claims.iss !== `${origin(env)}/api/auth` || !audiences.includes(`${origin(env)}/mcp`) ||
      typeof claims.sub !== "string" || !claims.sub || typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now())
    throw new PublicError("AUTHENTICATION_REQUIRED", "The access token is not valid for ResearchTube.", 401);
  if (!scopes.includes(MCP_SCOPE)) throw new PublicError("INSUFFICIENT_SCOPE", "Authorize access to ResearchTube tools.", 403);
  return claims.sub;
}

export async function browserUser(request: Request, auth: Auth): Promise<string> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new PublicError("AUTHENTICATION_REQUIRED", "Sign in to ResearchTube first.", 401);
  return session.user.id;
}

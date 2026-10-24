# ResearchTube Cloudflare Worker

Development server for a public ResearchTube MCP connection. TypeScript runs on
Cloudflare Workers, Better Auth handles Google/Microsoft sign-in and OAuth 2.1,
D1 stores accounts and installation credentials, and SQLite-backed Durable
Objects route requests to authenticated extension WebSockets.

**This is the server implementation, not a deployed or Store-approved plugin.**
The existing Chrome Extension still uses the OpenAI Secure MCP Tunnel. Its public
connection Settings, sign-in/enrollment bridge, cloud widget listener and relay
client are not wired into the shipped Extension yet. Implement those using
[PROTOCOL.md](PROTOCOL.md), then test real Chrome/ChatGPT before public rollout.
The Worker never launches a browser, reads cookies or runs FFmpeg/yt-dlp.

## Implemented

- Stateless Streamable HTTP MCP at `/mcp`, using the official MCP SDK.
- The built-in Extension catalog and existing UI resources are exported from the
  shipped Extension bundle, with three cloud connection tools added. Each
  proxied tool requires `browserBindingId`; original arguments/results and local
  task IDs remain the Extension's contract. Custom Tool catalogs are not yet
  published by the cloud server.
- Google and Microsoft sign-in buttons, explicit OAuth consent, protected-resource
  and authorization-server discovery, public-client DCR, S256 PKCE, resource-bound
  five-minute access tokens, rotating refresh tokens and a refresh revocation
  endpoint. No passwords or email delivery service are configured.
- OAuth issuer: `PUBLIC_ORIGIN/api/auth`; protected resource:
  `PUBLIC_ORIGIN/mcp`. For the personal ChatGPT connection, select OAuth with
  dynamic client registration (DCR). CIMD is not configured in this version.
- Separate random credentials per extension installation; only SHA-256 hashes
  are stored. A one-use, 15-second ticket opens its WebSocket. The long-lived
  installation credential is never placed in a URL or MCP response.
- One-use, 30-second widget binding challenges; user-isolated rooms; exact
  installation/tab/document/conversation routing; no active-tab or alternate-
  device fallback. Bindings and socket authentication last one hour.
- Explicit browser-binding release and installation revocation. Disconnect,
  navigation mismatch, conflicting binds and transport failures fail closed.
  A timed-out dispatched request reports an unknown outcome and is never retried.

Google/Microsoft prove account ownership; they do not select a browser profile
or provide its YouTube session. Existing browser work stays in the Extension,
and local file/media work stays in the loopback Agent. Text and tool results
pass through Cloudflare; large media should stay on the existing local delivery
path. Codex has no supported browser binding in this design.

## Local development

Use Node.js 22 or later (CI uses Node.js 24):

```sh
cd cloudflare-worker
npm ci
cp .dev.vars.example .dev.vars
```

Set a fresh random `BETTER_AUTH_SECRET` of at least 32 characters in `.dev.vars`.
For example, generate it locally with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Then initialize the local database and start the Worker:

```sh
npm run db:local
npm run dev
```

The checked-in config uses `http://localhost:8787`, explicit local-development
mode and no allowed extension IDs. `/health` reports that the Worker responds;
it does not claim that OAuth providers or a Chrome connection are ready. Sign-in
buttons appear only for fully configured providers. Never commit `.dev.vars`.

`npm ci` generates the catalog and Worker-compatible standalone validators.
After changing Extension tools, build the Extension and regenerate:

```sh
npm run build --prefix ../extension
npm run generate
```

Generated `src/catalog.json` and `src/validators.js` are ignored by Git. Runtime
schema validation uses generated code, without `eval`/`new Function` in Workers.
The generated catalog is not an independently maintained copy of tool schemas.

## Configure a public address

1. Create a D1 database with `npx wrangler d1 create researchtube`. Put its ID in
   `wrangler.jsonc` instead of the zero placeholder.
2. Set `PUBLIC_ORIGIN` to the exact HTTPS origin, without a trailing slash,
   and set `ALLOW_LOCAL_DEVELOPMENT` to `false`. A `workers.dev` origin can be
   used before the custom domain is ready. Host checks intentionally reject
   other addresses, so update this setting when changing the public origin.
3. Put the exact allowed Chrome extension origins in `EXTENSION_ORIGINS`, for
   example `["chrome-extension://<32-letter-extension-id>"]`. An unpacked
   development extension's ID may differ from a published extension's ID.
4. Configure at least one provider and upload its secrets:

```sh
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put MICROSOFT_CLIENT_ID
npx wrangler secret put MICROSOFT_CLIENT_SECRET
```

Register the web callback URLs with the respective providers:

```text
https://<your-host>/api/auth/callback/google
https://<your-host>/api/auth/callback/microsoft
```

For Microsoft, register a Web application accepting both personal Microsoft
accounts and accounts in organizational directories. Corporate consent policies
still apply. These provider credentials belong only to the Worker; they are
different from ChatGPT's OAuth client registration.

Apply reviewed migrations before deployment:

```sh
npm run db:remote
npm run deploy
```

For a custom domain, add an appropriate `routes` entry with `custom_domain: true`
in Wrangler. This repository does not create DNS records, provision provider
applications, upload secrets or deploy automatically. The CI workflow only
builds and tests.

Connect the public URL `https://<your-host>/mcp` as a personal custom MCP plugin
in ChatGPT to test before Store submission. Actual browser calls also require
the Extension integration described above. Test the Google and Microsoft
redirects with real accounts after configuring the domain. The automated tests
seed local test sessions; they do not pretend to complete external social login.

## Accounts and revocation

Each provider identity maps to a ResearchTube account. Automatic cross-provider
account linking is disabled: an email match, especially a Microsoft claim, is
not enough to prove two identities belong to the same person. Use the original
provider for an existing account until explicit authenticated linking is added.
Do not mark an unverified provider email as verified for OpenAI domain policies.

Revoking a refresh token stops new token issuance. Signed access tokens remain
valid for at most five minutes; the library does not revoke individual JWT
access tokens. Releasing a browser binding or revoking an installation blocks
that browser route immediately, independently of token expiry.

The first enrollment request runs on the signed-in, same-origin setup page,
not as an LLM tool. It must hand its credential only to the initiating allowed
extension. There is no device-selection UI and no implicit pairing by email.

## Routing limits to verify in Chrome

`openai/session` correlates a conversation; it is not a Chrome tab ID or proof
of which physical copy of the conversation initiated a request. A fresh widget
handshake must supply that proof. Detected conflicting bindings quarantine the
old route instead of electing a browser. A copied conversation's old widget
cannot reuse a consumed nonce.

The server alone cannot detect another computer displaying a historical copy
of the same conversation. The Extension integration must reject duplicate
controllers and require fresh binding on resumed/moved chats. Do not claim
transparent multi-device support or enable public rollout based solely on
the protocol simulator. Test identical conversation copies on different
computers/profiles, not just different conversations.

## Verification and costs

```sh
npm run check
npm test
```

Tests build and run the actual Worker in Cloudflare's local workerd/Miniflare
runtime, use real local D1 migrations, exercise OAuth code/consent/PKCE and
refresh flows, and simulate multiple extension WebSockets. Existing Agent and
Extension suites remain required at repository root.

The code uses no paid auth subscription, SMS, transactional email or hosted LLM
API. Workers, D1 and SQLite Durable Objects have Free tiers; configure the
Cloudflare account to remain on Free. Capacity is limited by request, database,
storage and CPU quotas, not simply by the number of registered users. Benchmark
OAuth cold starts and token issuance against the Free CPU budget on Cloudflare
before promising zero-cost production capacity. No paid plan is enabled here.

The server version comes only from this folder's `package.json`. Extension and
Agent versions are unchanged. Auth dependencies are pinned by `package-lock.json`.
The initial auth migration is generated with `npm run schema`; after deployment,
add a new reviewed migration rather than rewriting `0001_auth.sql`.

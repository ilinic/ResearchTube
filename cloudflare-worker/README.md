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

## Publish on rtube.win

The `production` environment in `wrangler.jsonc` targets the root domain
`https://rtube.win` in Cloudflare account `bb4ba8acee199cf7da2a9aabddf2c8fd`.
It disables local-development mode, workers.dev and preview URLs. No static
folder or Pages project is required. The default environment remains local;
`npm run dev` and `npm run db:local` still use localhost and local D1.

Run these commands from `cloudflare-worker/` with your Cloudflare account:

```sh
npx wrangler login
npx wrangler d1 create researchtube --env production
```

Put the returned database ID into **`env.production.d1_databases[0].database_id`**,
replacing the zero placeholder. If the database already exists, use its ID
instead of creating another. Leave the top-level local binding unchanged.
Bindings and variables are explicitly repeated because named environments do
not inherit them. `EXTENSION_ORIGINS` starts empty: add only the exact approved
Chrome extension origins before enabling enrollment, for example
`["chrome-extension://<32-letter-extension-id>"]`. An unpacked extension's ID
may differ from its published ID.

Generate a fresh random `BETTER_AUTH_SECRET` of at least 32 characters and
upload it using Wrangler's hidden input. Configure at least one login provider;
Google and Microsoft are independent options. Do not commit or send secrets.

```sh
npx wrangler secret put BETTER_AUTH_SECRET --env production
npx wrangler secret put GOOGLE_CLIENT_ID --env production
npx wrangler secret put GOOGLE_CLIENT_SECRET --env production
npx wrangler secret put MICROSOFT_CLIENT_ID --env production
npx wrangler secret put MICROSOFT_CLIENT_SECRET --env production
```

Register these Web callback URLs with the corresponding providers:

```text
https://rtube.win/api/auth/callback/google
https://rtube.win/api/auth/callback/microsoft
```

For Microsoft, accept both personal Microsoft accounts and accounts in
organizational directories. Corporate consent policies still apply. Provider
credentials belong to the Worker and differ from ChatGPT's client registration.

Before switching the domain, remove its association with the old static project
(for Pages, its Custom domains setting). If an old root CNAME remains, remove
that conflicting record only. Keep unrelated DNS and email records. The
production Custom Domain route lets Cloudflare provision the Worker's DNS and
HTTPS certificate. Review the database migrations, then run:

```sh
npm run check
npm run build:production
npm run db:remote
npm run deploy
```

The last two commands explicitly select `production`. A dry-run build does not
create D1, upload secrets, modify DNS or deploy. CI builds and tests both
configurations, without publishing. After deployment, check
`https://rtube.win/health`, `https://rtube.win/` and the OAuth metadata. Health
only confirms an HTTP response, not provider or browser readiness.

The ChatGPT MCP address is **`https://rtube.win/mcp`**. Use a personal custom MCP
connection with OAuth/DCR for testing before Store submission. Actual browser
calls still require the Extension integration described above. Test provider
redirects with real accounts; automated tests seed local sessions and do not
complete external social login.

To change domains later, update the production route, `PUBLIC_ORIGIN` and the
provider callback registrations together. Host checks intentionally reject
other public addresses.

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

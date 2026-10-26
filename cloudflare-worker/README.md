# ResearchTube Cloudflare Worker

Public ResearchTube MCP/OAuth server at the root origin **https://rtube.win**. TypeScript runs on
Cloudflare Workers, Better Auth handles Google/Microsoft sign-in and OAuth 2.1,
D1 stores accounts and installation credentials, and SQLite-backed Durable
Objects route requests to authenticated extension WebSockets.

Setup starts in ChatGPT: add the root URL, choose OAuth and sign in. Install the Chrome Extension afterwards; it connects automatically through the ResearchTube website session in that Chrome profile. Start the optional Agent for local work. Tools run through the single active desktop extension; there are no server-side transcripts or free transcript quotas.

## Implemented

- Stateless Streamable HTTP MCP at `/` using the official SDK. Browser GET shows installation instructions; MCP POST executes the protocol. No `/mcp` alias.
- Canonical built-in Extension tools and media UI resources, plus optional `system_connection_status` diagnostics. No connect/disconnect-chat tools, conversation widgets or preliminary status calls. Custom Tool catalogs are not yet published by the cloud server.
- Google/Microsoft sign-in, OAuth consent, protected-resource and authorization-server discovery, public-client DCR, S256 PKCE, resource-bound five-minute access tokens and rotating/revocable refresh tokens. OAuth issuer is `PUBLIC_ORIGIN/api/auth`; protected resource is `PUBLIC_ORIGIN`.
- Separate random installation credentials; only their SHA-256 hashes are stored. One-use 15-second tickets open outbound WebSockets. Credentials never enter URLs or MCP.
- One active extension installation per account. New enrollment revokes the previous credential, closes its socket and stops its retries. User-isolated rooms route productive tools directly to the active installation, without openai/session or per-chat binding.
- Explicit tabId/chatTabId for chat actions. The Extension pins and validates the exact live document inside execution; no focus-based fallback. Tab-free YouTube/local reads do not inspect ChatGPT.
- Bounded pending requests and replay history, socket-bound replies and no automatic action replay after disconnect/timeout. Toolbar and popup display disconnected/replaced status.

Provider login identifies the ResearchTube account; it does not provide YouTube credentials. Existing browser work stays in the extension; local files/media stay in the loopback Agent. Text/tool results pass through Cloudflare. Account-scoped calls can originate in another client while the connected desktop remains online. See [protocol](PROTOCOL.md) and [public connection](../docs/features/PUBLIC_CONNECTION.md).

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
not inherit them. `EXTENSION_ORIGINS` explicitly allowlists the unpacked identity
fixed by the packaged public manifest key:
`chrome-extension://jnnhjpkdhmghpbgfcalbhmkagdeelgnp`. No wildcard origin is
allowed. A future Web Store release must use its actual approved identity.

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

The ChatGPT MCP address is **`https://rtube.win`**. Use a personal custom MCP
connection with OAuth/DCR for testing before Store submission. Actual browser
calls require the active Extension; targeted chat actions require an explicit tab ID pinned locally inside execution. Test provider
redirects with real accounts; automated tests seed local sessions and do not
complete external social login.

To change domains later, update the production route, `PUBLIC_ORIGIN` and the
provider callback registrations together. Host checks intentionally reject
other public addresses.

## Sign-in troubleshooting

If Continue with Google stays disabled without navigating, update and redeploy
this Worker. Authentication instances and D1 adapters are scoped to one request;
public pages do not start auth initialization. Never cache an in-flight auth
context across Cloudflare invocations: an interrupted initialization can leave
later requests waiting forever. Initialization is awaited, automatic background
schema checks are disabled, and reviewed migrations plus CI remain authoritative.
Initialization and auth execution share a 20-second deadline; a timeout returns
`AUTH_TIMEOUT` (HTTP 503), without automatically retrying an OAuth operation.

The page requests a JSON redirect explicitly and allows 25 seconds for the full
HTTP response, including its body. A timeout, HTTP failure, invalid JSON or
missing redirect restores the button and displays a bounded error. Diagnostics
show only HTTP status and a safe error code, never provider response bodies,
secrets or authorization URLs. After deployment, test the real provider redirect
and callback in Chrome; `/health` alone does not exercise authentication.

## Accounts and revocation

Each provider identity maps to a ResearchTube account. Automatic cross-provider
account linking is disabled: an email match, especially a Microsoft claim, is
not enough to prove two identities belong to the same person. Use the original
provider for an existing account until explicit authenticated linking is added.
Do not mark an unverified provider email as verified for OpenAI domain policies.

Revoking a refresh token stops new token issuance. Signed access tokens remain
valid for at most five minutes; the library does not revoke individual JWT
access tokens. Revoking an installation blocks its route immediately, independently of token expiry.

The first enrollment request runs on the signed-in, same-origin setup page,
not as an LLM tool. It must hand its credential only to the initiating allowed
extension. There is no device-selection UI and no implicit pairing by email.

## Routing limits to verify in Chrome

One account authorizes one active extension. Numeric tab IDs are explicit routing within that installation, not proof of a physical caller's origin. New enrollment replaces the old installation; old credentials and unused tickets must fail. Verify replacement notice, stopped retries, popup/badge state, restart and delayed chat-delivery guards. No per-chat widget is used.

## Verification and costs

```sh
npm run check
npm test
```

The optional `npm run test:chrome` exercises the actual unpacked Extension in an
isolated Chromium profile against local workerd, with seeded test login and
simulated ChatGPT/YouTube pages. It verifies native enrollment, first-call transcript dispatch without widgets, exact tab/document guards, replacement status and revocation. See
[Development](../docs/DEVELOPMENT.md) for its browser/runtime requirements.

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

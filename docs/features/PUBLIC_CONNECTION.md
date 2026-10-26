# Public ResearchTube connection

## Setup order

Add `https://rtube.win` as a custom MCP server in ChatGPT, choose OAuth, sign in
through Google (or the configured Microsoft provider), authorize ResearchTube
and install the resulting personal plugin. Catalog publication is not required.
The server URL has no `/mcp` suffix. Its OAuth resource identifier is the exact
configured origin; old endpoint/audience configurations are not supported.

Call `system_connection_status` before installing anything locally. It confirms
account connection and returns `/setup` instructions without requiring an
extension, Agent, conversation correlation or browser binding. It never fetches
YouTube data. There are no cloud transcripts, free quotas or mobile execution.

Then download and extract a release, load its `extension/` in desktop Chrome and
call `system_connect_browser` from the saved ChatGPT conversation. Installation
grants the declared browser capabilities. Pairing is automatic: an inactive
nonce-bound setup tab uses the existing ResearchTube website session, obtains a
private installation credential and closes after acknowledgement. If that
web session is absent, expired or belongs to another account, sign in to
ResearchTube in this Chrome profile and retry. Chrome/YouTube login state is not
used as ResearchTube identity proof. The optional Agent needs no separate account.

Return to a saved ChatGPT conversation in Chrome. `system_connect_browser`
renders the binding widget; `system_connection_status` then returns the
nonsecret `browserBindingId` required by browser-backed tools. Desktop/mobile
client capability is established by this live handshake, not a user-agent guess.

## Boundaries

ResearchTube owns the MCP OAuth authorization server. Google/Microsoft identify
the account; their tokens do not authorize YouTube access or select a computer.
The MCP token and each extension installation's random credential are separate.
Automatic enrollment additionally validates that the MCP challenge belongs to
the account authenticated by this browser's cookie before creating credentials.
A foreign plugin/widget nonce therefore cannot link this computer to another
account. Enrollment challenges expire and are consumed by binding; failed
automatic attempts are bounded and do not repeat for the same widget nonce.
Only hashes of installation credentials are stored server-side. Credentials
never enter tool arguments/results, model context, URLs or diagnostics.

The extension's packaged public manifest key fixes the unpacked extension ID.
The Worker explicitly allowlists that origin. The public key is an identity
configuration, not a secret. A later Web Store distribution must use its actual
approved identity and update the allowlist accordingly.

Enrollment uses Chrome external messaging restricted to the ResearchTube
origin. The worker verifies the initiating tab, top frame, setup URL, extension
ID, random nonce, deadline and single-use receipt. Session storage owns the
pending enrollment; trusted local extension storage owns installation secrets.
No generic page-message receiver accepts credentials. Pairing verifies the new
credential before replacing the previous one and attempts to revoke the old one.

The extension obtains a one-use WebSocket ticket and connects outbound to the
Worker. It exchanges bounded keepalive messages every 20 seconds, reconnects
with bounded exponential backoff and rotates its socket before hourly expiry.
Authentication failures stop retrying until the user reconnects the extension.
An alarm restores the connection after worker suspension.

Each browser binding identifies one installation, tab, top-level document and
saved conversation. Chrome supplies tab/document identity; no model input,
active-tab selection or email match establishes this authority. Duplicate local
conversation copies and conflicting server bindings fail closed. A new socket
invalidates its installation's old bindings; the chat needs a fresh handshake.

Requests reuse the existing Extension MCP dispatcher and response projection.
Replay receipts are bounded; at capacity the socket rotates instead of forgetting
them and permitting replay. In-flight actions are never retried automatically.
Timeout means the outcome may be unknown.

Navigation, tab closure, Stop, binding invalidation or installation revocation
stop routing and suppress dependent chat delivery. Current-document checks run
before execution and before delayed Composer actions. Local tasks retain their
original private binding context; a restarted worker cannot revive old delivery
from a tab number alone. Created Workspace files are preserved on delivery failure.

## Verification and deployment

Run the Extension and Agent suites plus Worker `npm run check`, `npm test` and
`npm run build:production`. Protocol/runtime tests cover OAuth, enrollment API,
relay isolation and revocation. Extension tests cover private credential storage,
nonce/tab/frame validation, reconnect races, exact documents, duplicate chats,
request replay, navigation and widget origin checks.

The optional Worker `npm run test:chrome` also exercises the unpacked Extension
with real Chromium sender/document identity and a local workerd relay. It uses
an isolated profile, a seeded test login and simulated host/widget pages, never
production traffic or the user's browser. See [Development](../DEVELOPMENT.md).

Production publication is a separate operation. Before rollout test real Chrome
external messaging, provider redirects, a personal ChatGPT OAuth connection,
widget frames, duplicate conversations across profiles/computers, worker restart
and delayed media delivery. Automated tests do not establish that live integration.
See the [server deployment guide](../../cloudflare-worker/README.md) and
[relay protocol](../../cloudflare-worker/PROTOCOL.md).

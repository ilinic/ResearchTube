# Public ResearchTube connection

## Setup

Add `https://rtube.win` as a custom MCP server in ChatGPT, choose OAuth and sign in through Google (or the configured Microsoft provider). Download the latest [release](https://github.com/ilinic/ResearchTube/releases), extract it and load its `extension/` folder in desktop Chrome. Start the optional Agent for local media work. The root URL is both website and MCP endpoint.

The extension connects automatically using the ResearchTube website session in that Chrome profile. An inactive, nonce-bound setup page obtains its private installation credential and closes. If the session is missing, sign in to ResearchTube in that Chrome profile. Chrome's Google login is a local availability check, not authentication proof or an email-based account link. An absent local Google account stops connection attempts.

## One connection per account

Each account has one current extension installation. Enrolling a new extension revokes the old installation credential and closes its socket. The old extension displays Disconnected with a red toolbar badge and stays stopped, including after restart. It does not automatically enroll again or reclaim the account. Other users' connections are unaffected. Explicit installation revocation also stops access.

Transient network loss displays an error on the toolbar and connection status in the popup. The current extension reconnects with bounded exponential backoff. An alarm restores its outbound connection after service-worker suspension; bounded heartbeat messages keep it alive between requests. The Agent remains on `127.0.0.1`.

## Productive calls

Every productive MCP call routes directly from the OAuth-authenticated account to its one active extension. There is no conversation connection widget, challenge, binding ID, `openai/session` prerequisite or model-side readiness check. The public catalog has no connect/disconnect-chat tools. `system_connection_status` is optional diagnostics only.

YouTube research and local reads need no ChatGPT tab. Chat delivery requires explicit `tabId` from the startup prompt; Site tools use its `chatTabId`. Missing targets return a structured error without guessing, opening a widget or queueing execution. The extension captures the exact top document and saved conversation inside the useful request, then checks them before delayed browser/Composer actions. Navigation, closure, duplicate conversations and socket replacement invalidate this local context. Existing task files survive failed delivery. Site group ownership is checked inside the productive operation; stopped groups require explicit resume with `system_get_chat_context` and the exact `chatTabId`.

The MCP account authorizes tools on its active extension. Numeric tab IDs are explicit routing within that installation, not proof of the calling chat's physical origin. Clients on other devices can use account-scoped tools while that desktop extension is online. The extension itself requires desktop Chrome; no server-side transcript service or free transcript quota is provided.

## Boundaries

ResearchTube issues its own resource-bound MCP OAuth tokens. Provider tokens do not authorize YouTube actions. Installation credentials are separate random secrets; D1 stores only their hashes. Cookie-authenticated enrollment checks exact website Origin and allowed extension identity. Chrome external messaging verifies top frame, initiating setup tab, URL, extension ID, nonce, deadline and a single-use receipt. Credentials stay in trusted local extension storage and never enter MCP, URLs or diagnostics.

Relay tickets expire in 15 seconds and are consumed once. Ticket issuance rechecks revocation. The socket negotiates the direct-tools protocol before reporting ready. Both server and extension allowlist request envelopes and tool arguments; the existing MCP dispatcher owns normalization and response projection. Replies settle only their original socket's pending request. Replay receipts are bounded; at capacity the socket closes instead of forgetting them. Disconnected or timed-out actions are never automatically replayed.

## Verification

Run Extension and Agent suites and Worker `npm run check`, `npm test` and `npm run build:production`. `npm run test:chrome` uses the actual unpacked Extension in an isolated Chromium profile against local workerd, seeded login and simulated host/YouTube pages. It checks automatic enrollment, first-call transcript execution without a chat widget, exact document guards, replacement status and revocation. It does not use the user's profile or live accounts.

Real provider redirects and ChatGPT behavior still require live verification after deployment. See [Development](../DEVELOPMENT.md), the [server guide](../../cloudflare-worker/README.md) and [protocol](../../cloudflare-worker/PROTOCOL.md).

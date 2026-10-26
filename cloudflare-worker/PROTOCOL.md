# Chrome relay protocol v2

The root origin is both MCP endpoint and website. OAuth in ChatGPT precedes extension installation. `cloud-connection.js` owns the outbound adapter; the Agent stays on loopback.

## Enrollment and one active installation

The extension automatically opens an inactive `/setup?extensionId=...&nonce=...` helper. Cookie-authenticated `POST /api/installations` supplies name and allowed extensionOrigin. External messaging verifies initiating top-frame tab, exact origin/path/query, extension ID, nonce, deadline and single-use receipt. Installation credentials stay in trusted local extension storage; D1 stores their hashes. Chrome/Google email matching is never an enrollment credential.

Enrolling a new installation atomically revokes the account's previous credential. Its user-isolated Durable Object activates the new installation, rejects old pending requests and sends the old socket `{"type":"disconnect","code":"EXTENSION_REPLACED"}` before closing it. The old extension persists revocation and never reconnects or automatically reenrolls. Other accounts are unaffected.

## Socket

`POST /api/relay-ticket` uses the installation bearer token. It returns a one-use ticket with a 15-second expiry and `capabilities.directTools: 1`. Ticket issuance is limited to once per installation per five seconds and rechecks revocation transactionally. Connect to `/relay?ticket=...`; do not log ticket query strings. Consumed tickets and revoked credentials cannot reconnect. A socket lasts at most one hour; the adapter rotates it before expiry after pending calls finish. Replacement invalidates old pending work.

The extension sends `direct-tools-v1`; the server acknowledges `direct-tools-ready`. Only then does the extension publish Connected. Old clients receive an update-required error for productive calls. `ping`/`pong` exchange every 20 seconds. Reconnect uses bounded exponential backoff and jitter; authentication failures stop retries.

## Dispatch

The Worker authenticates the MCP token and validates the canonical Extension input schema. Every tool call routes directly to that account's current socket. No conversation handshake, openai/session, widget, preliminary status call or model-supplied binding ID is needed.

Server envelope:

```json
{"type":"request","requestId":"<UUID>","installationId":"<UUID>","request":{"jsonrpc":"2.0","method":"tools/call","params":{"name":"youtube_get_transcript","arguments":{"videoId":"aqz-KE-bpKQ"}}},"timing":{"workerReceivedAtMs":1793000000000,"roomReceivedAtMs":1793000000002,"roomForwardedAtMs":1793000000003}}
```

The extension validates envelope, installation, request ID, tool and allowed fields, then invokes handleMcpRequest once. Reply:

```json
{"type":"response","requestId":"<same UUID>","result":{"content":[{"type":"text","text":"<result>"}]}}
```

Exactly one of result/error is required. Reply IDs settle only requests originally dispatched to that socket; foreign, late and duplicate replies cannot settle another call. Messages are capped at 1 MiB and pending calls at 100. A 25-second timeout reports BROWSER_OUTCOME_UNKNOWN; neither side retries an action automatically. Replay history closes the socket at capacity rather than forgetting execution receipts.

The mandatory `timing` envelope contains millisecond UTC timestamps from the Worker and Durable Object. For completed `site_*` calls with a valid `chatTabId`, the Durable Object follows the normal response with a separate safe `{ "type": "timing", "requestId": "<UUID>", "tool": "site_read", "chatTabId": 123, "roomRespondedAtMs": 1793000001000 }` message. The Extension adds receive/reply timestamps and, only when explicitly recording, stores these numeric events for `site_diagnostics_report`. Clock differences mean durations across machines are approximate; these timing frames never contain MCP arguments, input text or URLs.

## Local targets

The account authorizes its active extension. Tab numbers route within that installation; they do not prove the physical caller's origin. Tab-free tools do not read ChatGPT. Delivery requires tabId, Site tools require chatTabId, from the startup prompt. Missing targets fail immediately without focus guesses, widget fallback or queueing.

Inside execution the extension pins the specified tab's saved conversation and Chrome top-document ID and rejects local duplicates. Navigation, closure, disconnect or expiry invalidate local guards. Guards run before delayed Composer actions, require no server binding or handshake and cannot be revived after restart from a numeric tab alone. Site tools additionally enforce group ownership and site membership. Files survive delivery failure.

## Diagnostics

Offline/replaced extensions fail immediately. Toolbar and popup display connection status. system_connection_status is optional user-requested diagnostics, never a preflight. Public connect/disconnect-chat tools and their connection resources are removed. Media presentation resources retain their own display contracts.

# Chrome relay protocol v1

The Extension implements the public adapter in `cloud-connection.js` and
`chatgpt-cloud-bridge.js`. The canonical MCP URL is the root origin; there is
no `/mcp` alias. ChatGPT OAuth precedes local installation. Reuse `handleMcpRequest` for the tool implementations. Keep the Agent on loopback.

## Account and installation

An account may own several extension installations. A browser profile owns one
installation; multiple Chrome windows in that profile share it. A tab ID is
never a global address.

First connect the public MCP URL in ChatGPT and complete OAuth. Setup/status
tools work without a browser binding. Afterwards the initiating extension opens
the Worker's `/setup?extensionId=...&nonce=...` page from Settings. Chrome
external messaging verifies the initiating top-frame tab, exact URL, extension
ID, nonce and deadline before accepting a single-use credential receipt.
After Google/Microsoft sign-in, that page sends a cookie-authenticated
`POST /api/installations` with:

```json
{
  "name": "Chrome profile",
  "extensionOrigin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

The page's `Origin` must equal `PUBLIC_ORIGIN`, and `extensionOrigin` must be in
the server's explicit allowlist. The setup bridge must authenticate its
initiating extension and return the new `{installationId, installationToken}`
only to that extension. Do not publish a generic window-message token receiver.
Implement a nonce-bound handshake and verify message source and exact origins.
The credential is private, stored in local Extension storage, never synced to
other profiles or included in an LLM response, URL, logs or diagnostics.

The Extension implements this enrollment bridge. The server API
requires an actual browser login session; an MCP token cannot enroll a device.

## Connect the extension

1. `POST /api/relay-ticket` with `Authorization: Bearer <installationToken>`.
2. The result is `{ticket, expiresAt}`. Connect a WebSocket to
   `wss://<host>/relay?ticket=<ticket>` within 15 seconds.
3. A ticket is consumed once. It cannot open a second socket. Obtaining tickets
   is limited to one per installation per five seconds. Use bounded reconnect
   backoff with jitter; never spin on a failed or revoked credential.
4. A new connection replaces that installation's old socket and invalidates its old browser bindings. In-flight commands
   fail with an unknown/disconnected outcome and are not retried. Reauthenticate
   the socket at least hourly, after current requests settle.

Cloudflare URLs may contain the short-lived ticket. Keep request logging off
or configure query-string redaction before enabling observability. Persistent
installation credentials go in headers only. The server does not log payloads.

## Prove the invoking tab

ChatGPT calls `system_connect_browser` after OAuth account linking. The tool
returns a compact widget with a nonce in private tool-result metadata:

```json
{
  "researchtube/cloudBinding": {
    "nonce": "<one-use-72-character-value>"
  }
}
```

The widget announces `{source: "researchtube-cloud-binding", nonce}` to its
parent. Add a dedicated cloud listener alongside the existing local chat-target
bridge, not by weakening that bridge's task/token validators.

The Extension must verify:

- The event came from this widget's actual frame, using the existing
  sandbox-origin/frame validation and canonical tool-result metadata rules.
- Chrome's `sender.id` is this extension and `sender.tab.id` identifies a real
  `https://chatgpt.com/` tab. Never accept a tab ID from window-message data.
- A fixed, Extension-owned top-frame script reads the live conversation path.
  Its `chrome.scripting.executeScript` injection result supplies the **top
  document's** `documentId`. The widget frame's `sender.documentId` is not the
  top document ID.
- The conversation has a saved ID, and this profile does not contain duplicate
  controllers for it. Existing single-leading-chat group rules still apply.

The extension then sends `POST /api/browser/bind` authenticated with its own
installation token:

```json
{
  "nonce": "<widget nonce>",
  "target": {
    "tabId": 123,
    "documentId": "<Chrome top-document ID>",
    "conversationId": "<saved conversation ID>"
  }
}
```

The server derives the user and installation from the credential, and the
OpenAI conversation correlation from the nonce. A foreign installation cannot
consume another user's challenge. The response is `{bindingId, expiresAt}`;
acknowledge the widget with:

```json
{
  "source": "researchtube-cloud-binding",
  "type": "result",
  "nonce": "<same widget nonce>",
  "ok": true
}
```

ChatGPT calls the productive tool with its original arguments. Inside dispatch,
the Worker resolves exactly one active binding for the OAuth-authenticated user
and `openai/session`. Missing, expired, offline or ambiguous bindings fail before
execution. No routing ID is supplied by the model and no preliminary status call
is made. `system_connection_status` is optional diagnostics; `system_connect_browser`
repairs a connection only after an actual error or an explicit connection request.

`openai/session` identifies a conversation, not a physical browser instance.
Simultaneous physical copies of one conversation cannot be distinguished from
OAuth or that field alone. A conflicting fresh handshake quarantines its old
bindings; it does not authorize a second controller or retarget an existing
task. Historical/replayed widgets must not silently acquire authority. The
browser adapter must establish fresh context on resumed/moved conversations
and reject ambiguous copies. This is an explicit live integration acceptance
test, not a guarantee supplied by the Worker alone.

## Dispatch and reply

The Worker sends:

```json
{
  "type": "request",
  "requestId": "<unique UUID>",
  "target": {
    "bindingId": "<binding UUID>",
    "installationId": "<installation UUID>",
    "session": "<opaque OpenAI conversation correlation>",
    "tabId": 123,
    "documentId": "<top document ID>",
    "conversationId": "<conversation ID>",
    "expiresAt": 1800000000000
  },
  "request": {
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": { "name": "youtube_get_video", "arguments": { "videoId": "aqz-KE-bpKQ" } }
  }
}
```

Before invoking `handleMcpRequest`, verify installation, binding, live tab,
top-document identity and conversation again. Set the internal MCP request ID
to `requestId`. Existing target arguments must agree with the verified chat;
no active-tab fallback is permitted. Check the same target after asynchronous
preparation and immediately before Composer changes/Send.

Send one response with the exact request ID and observed target:

```json
{
  "type": "response",
  "requestId": "<same UUID>",
  "target": {
    "tabId": 123,
    "documentId": "<same top document ID>",
    "conversationId": "<same conversation ID>"
  },
  "result": { "content": [{ "type": "text", "text": "<normalized tool result>" }] }
}
```

Alternatively send `error: {code: <JSON-RPC integer>, message: <safe bounded
message>}`, never both fields. Strip stack traces, cookies, headers and host
paths. The Extension's existing response projection remains authoritative.
Messages and MCP bodies are bounded to 1 MiB. Tool operations should return
their existing asynchronous task handle promptly; the relay's 25-second
response deadline is not a media-processing deadline.

Late, duplicate or foreign-socket replies cannot settle another request.
A mismatched document is an error, never permission to redirect results.
After a timeout, the operation might already have executed; inspect its state
instead of automatically resending it. Media bytes use the existing local
delivery paths rather than the relay.

## Closure and invalidation

On tab closure, navigation to another document/conversation, owner departure or
local Stop, release the route with `POST /api/browser/release`:

```json
{ "bindingId": "<binding UUID>" }
```

Authenticate with the installation token. A different installation cannot
release it. The server can also send
`{type: "invalidate", bindingId: "<UUID>"}`. The adapter must immediately
invalidate that context and cancel or suppress pending chat delivery, while
preserving already created Workspace files. Do not only remove the socket.
Every asynchronous local task retains its original immutable destination.

Account-side `DELETE /api/installations/<installationId>` requires same-origin
cookie authentication and revokes the installation and its routes. The cloud
tool `system_disconnect_browser` removes this conversation's routes only.

## Before public rollout

Enrollment, connection Settings and the dedicated widget listener are implemented.
Exercise real Google and Microsoft callbacks and a personal
ChatGPT OAuth connection. Test several computers/profiles, duplicated copies
of the same conversation, reused widget frames, worker suspension, navigation,
profile restarts and delayed media delivery. Protocol tests cannot establish
Chrome sender identity or guarantee ChatGPT widget behavior.

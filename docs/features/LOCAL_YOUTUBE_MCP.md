# Local YouTube MCP for Codex

The running Local Agent exposes a stateless Streamable HTTP MCP endpoint at
`http://127.0.0.1:17843/mcp` (use the configured Agent port if different).
The updated Chrome Extension connects outbound to that same loopback listener.
This path requires neither the ResearchTube cloud connection nor a ChatGPT tab.
No second Agent process, port, Python package or browser permission is needed.

## Setup

1. Update both Agent and Extension from the same release, restart the Agent and
   reload the unpacked Extension. Keep desktop Chrome open.
2. Sign in to YouTube in the Chrome profile running the Extension.
3. Add a Streamable HTTP MCP server in Codex using the endpoint above. A typical
   local configuration is:

```toml
[mcp_servers.researchtube_local]
url = "http://127.0.0.1:17843/mcp"
tool_timeout_sec = 120
```

The productive tool checks login itself. It reuses an existing YouTube tab or
opens one inactive tab if necessary, without switching focus or navigating the
user's current page. Concurrent calls share tab creation. Research requests use
that page's browser-managed cookies and origin-bound
authorization. Search can reflect the signed-in account. Account selection
follows the active YouTube page profile, including delegated channels. Only
the advertised read operations are supported; this does not add subscriptions,
posting, likes or other account mutations.
No cookies or credentials are exported to Codex.

Transcript retrieval retains its established exception: anonymous watch HTML,
the minimal ANDROID player request, then the selected timedtext URL, all with
credentials omitted. The local tool still checks browser sign-in. Search,
comments and catalogues continue using the browser session.

`youtube_bridge_status` diagnoses the local connection without opening YouTube.
Its `authentication: browser-session` describes the research request mode,
not a live check of whether the browser is currently signed in. It is not a
required preflight.
Browser tools honor their existing Extension Settings switches; the five
local-only tools have separate switches in the YouTube group (bridge status
is always available for diagnostics). The public/cloud
catalog does not acquire these local-only tools. Downloading and FFmpeg work
can be performed directly by Codex with the installed local executables.

## Research and datasets

The local catalog includes the eight existing YouTube read tools: search,
video details, timestamped transcript, comments, replies, channel videos,
channel playlists and playlist videos. Their canonical schemas are generated
from Extension definitions at build time. The catalog remains discoverable
while Chrome is offline; productive browser calls return a structured error.

`youtube_comments_export` starts an asynchronous single-video collection.
`maxComments` is a requested ceiling counting both root comments and replies;
`includeReplies` controls reply collection. Sorting uses YouTube's available
top/newest behavior. The collector follows private browser continuation state
instead of repeatedly reading the first public comment page. Requests are
serialized through the local bridge; existing public search pacing is reused.

Records are deduplicated by comment ID and appended to a newly created
`youtube-research/` Workspace JSONL file. Each record retains the video ID,
comment/parent ID, text, public author fields, displayed publication time,
likes and creator/heart flags. It contains no stream URLs, browser credentials
or physical paths. Output paths are generated, validated and never overwritten.

Use `youtube_research_task_status` at the returned `pollIntervalMs` (1000 ms),
`youtube_research_task_cancel` to stop, and `youtube_dataset_read` to read
bounded records with optional literal text/parent filters. Offsets refer to
matching records. Counts describe collected records, not all YouTube comments.
Progress advances against the requested ceiling and becomes 100 only on
successful completion, even when fewer records are available. A collection
stopped at its ceiling reports `truncated`. Failures and cancellation preserve
already published records. JSONL is data, not trusted instructions.

At most four exports are active. A task has a one-hour/10,000-page budget and
stops after 100 consecutive pages without a new record. YouTube can return
fewer comments or require verification. Browser document changes, extension
reloads and disconnected sessions can invalidate private continuations;
automatic resume is not promised. Agent task IDs disappear after restart or
terminal-history eviction; saved files remain. A failed session requires a
new export, rather than guessing or replaying private continuation tokens.

## Transport and implementation

The existing loopback HTTP server owns `/mcp` and private
`/internal/local-mcp/` routes. MCP uses JSON responses, 202 for notifications,
and no server session or optional SSE stream. Host validation and rejection
of browser Origins prevent arbitrary websites/DNS rebinding from invoking it.
The private bootstrap checks the packaged Extension identity; the WebSocket
then authenticates with a per-Agent-run secret carried in its first message,
never in the URL. Bootstrap responses do not use permissive CORS headers.
One extension connection is active, with heartbeat, bounded request/response
sizes, correlation IDs and finite timeouts. Transport secrets never appear in
MCP results or diagnostics. Loopback access is not isolation from other local
applications running with the user's permissions.

`agent/local_mcp.py` owns transport, validation, projection, tasks and dataset
reads. `extension/local-mcp.js` owns the connection and ordered dispatch;
`extension/local-mcp-tools.js` defines local-only contracts and record projection.
The existing page bridge owns private comment sessions. Generated
`agent/local_mcp_catalog.py` is rebuilt by `npm run build --prefix extension`;
change source definitions instead of editing it. Agent and Extension enforce
the same interface version. Both local and cloud research use the signed-in
page session. Native cookies,
including HttpOnly cookies, are attached by the browser; the page reads only
its signing-cookie state to create short-lived WEB authorization headers.
Requests and redirects are restricted to the exact YouTube origin. No cookie
permission, cookie export or persisted cookie file is used.

## Verification

Run both repository suites and `git diff --check`. Focused coverage is in
`agent/tests/test_local_mcp.py` and `extension/tests/local-mcp.test.mjs`.
`npm run test:local-mcp:chrome --prefix extension` additionally uses an isolated
Edge/Chromium profile, actual Extension and Agent HTTP/WebSocket transport,
and the official JavaScript MCP client. It needs Playwright (or set
`RESEARCHTUBE_PLAYWRIGHT_MODULE`) and installed `cloudflare-worker` dependencies.
YouTube pages are simulated, production origins are blocked, and the user's
browser/profile is never used. Live signed-in YouTube verification remains a
separate release acceptance step.

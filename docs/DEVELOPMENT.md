# Developing ResearchTube

This guide is for human contributors and coding agents. Read repository-root `AGENTS.md` and `ARCHITECTURE.md` first.

## Prerequisites

- Python 3.10 or later.
- Node.js and npm for Extension builds and tests.
- Chrome or Chromium for live Extension verification.
- FFmpeg and ffprobe for real media integration tests.
- yt-dlp and Deno when testing local YouTube downloads and the PO-token provider.

Install Extension dependencies with:

```sh
npm ci --prefix extension
```

## Development sources

| Area | Edit these files |
| --- | --- |
| MCP tools, Settings metadata and most browser orchestration | `extension/background.js` |
| Storyboard public contract | `extension/storyboards.js` |
| YouTube MAIN-world behavior | `extension/youtube-page-bridge.src.js` |
| YouTube isolated bridge | `extension/youtube-content.js` |
| ChatGPT media overlay | `extension/chatgpt-image-viewer-bridge.js`, `extension/chatgpt-capture-frame-bridge.js`, `extension/media-viewer.html`, `extension/media-viewer.js`, `extension/media-stream.js` |
| ChatGPT Composer inspection and upload editing guard | `extension/chat-composer.js` |
| Settings and popup | `extension/settings.*`, `extension/popup.*` |
| Local Agent | `agent/researchtube_agent.py` |
| Timer behavior and task retention | `agent/timers.py`, `agent/task_history.py`, `extension/timers.js`, `extension/task-history.js` |
| Storyboard Agent behavior | `agent/storyboards.py` |

Do not implement changes directly in `extension/dist/background.js` or `extension/youtube-page-bridge.js`; the build regenerates them.

## Adding an MCP tool

### 1. Define the public contract

Add a public definition to the owning Extension module. Give it:

- a stable snake_case name;
- a user-readable title;
- a concise LLM-facing description (at most 600 characters for built-ins) with purpose, essential constraints and follow-up calls; put parameter details in their schema descriptions and implementation details in docs;
- strict input and output JSON Schemas with `additionalProperties: false`;
- MCP annotations;
- invocation labels when the operation is visible or asynchronous.

Do not expose internal URLs, Chrome tab IDs, opaque browser state or host paths.

### 2. Register Settings metadata

Add the exact public name to `MCP_TOOL_SETTINGS`. Tool grouping is explicit; it is not inferred from the name. `system_agent_status` remains always enabled. Private widget actions are not public Settings tools.

### 3. Normalize input

Validate again in executable code even though a schema exists. Apply defaults before calling the browser or Agent. Reject unknown fields and cross-field conflicts. Normalize Workspace paths before transport.

### 4. Implement and route

Add the `tools/call` route in `handleMcpRequest`. Browser-only work stays in the Extension or page bridge. Local filesystem, FFmpeg, ffprobe and yt-dlp work belongs to the Agent.

For a new Agent operation:

1. define Agent-side option validation;
2. resolve input and output paths through `WorkspacePathResolver`;
3. use a fixed executable argument vector rather than a shell command;
4. add a narrow HTTP endpoint in `handle_client`;
5. translate stable `AgentApiError` codes into bounded HTTP responses;
6. normalize the response again in the Extension.

### 5. Use the task lifecycle for long work

Artifact producers must register in `extension/artifact-tasks.js`, provide validated native start/status/cancel callbacks and an explicit output-path extractor in `extension/background.js`, and use `extension/artifact-tools.js` for common options and public schemas. Never select newly created outputs with a directory scan. Public paths use `workspacePath` for the source and an explicit destination role; private Agent adapters retain native names. A producer's specialized status/cancel tools must forward the public supervisor ID, not poll/cancel just the underlying creation handle. Keep graceful recording Stop separate from workflow cancellation. See [Artifact tasks](features/ARTIFACT_TASKS.md).

An asynchronous feature normally has start, status and cancel public tools. The task should expose:

- an opaque task ID;
- `working`, `completed`, `failed` or `cancelled`;
- a specific phase;
- monotonic `progressPercent`;
- `statusMessage` where useful;
- `pollIntervalMs`;
- completed output metadata;
- one bounded public error object on failure.

Use real progress: FFmpeg `-progress pipe:1`, yt-dlp progress templates, received content length or completed units. Cap a working task below 100%; set exactly 100 only on successful completion.

Cancellation must stop child processes or transfers, remove temporary partial output and retain already published complete files where the tool promises partial preservation.

### 6. Add diagnostics deliberately

Normal status should be enough for successful work. A separate diagnostics tool is appropriate only when users need bounded failure details, such as sanitized yt-dlp output. Never return raw process output, signed URLs, cookies, tokens or physical paths.

Agent console lines are user-facing. Keep them short. Ordinary status polling should appear as a compact route plus percentage.

### 7. Test the contract

Agent tests belong in `agent/tests/`. Extension contract tests belong in `extension/tests/` and must be added to the `test` script in `extension/package.json`.

Tests should cover:

- valid defaults and explicit options;
- unknown fields and cross-field conflicts;
- missing files and invalid logical paths;
- output collision and no-overwrite behavior;
- response projection and secret-field rejection;
- progress, completion, failure and cancellation;
- preservation of earlier completed outputs;
- HTTP routing and not-found behavior;
- Settings registration;
- generated bundle and version consistency;
- documentation inventory when public tools change.

## Browser bridge changes

Keep the isolated ↔ MAIN boundary typed and narrow. Validate origin and source on page messages. Avoid passing complete page objects or raw response documents. Prefer normalized public fields.

When a stale content script is possible, use the existing bounded recovery pattern rather than reloading the user's tab. Background service tabs should open inactive and should not be closed unless the feature contract says so.

CDP attachment is serialized where Chrome permits only one debugger session. Always detach and clear temporary focus emulation in cleanup paths. Do not log CDP response bodies.

## Workspace and output files

- Use lowercase stable output directories such as `captures/`, `clips/`, `storyboards/` and `text-to-speech/`.
- Generate portable filenames and preserve meaningful Unicode when safe.
- Add an opaque task or operation tag when outputs could otherwise collide.
- Check the destination before expensive work and publish atomically/exclusively afterward.
- Never use an unresolved environment variable, user-controlled shell string or raw MCP path as a filesystem target.
- Temporary files must live outside public Workspace results or use an intentionally hidden bounded location and must be cleaned up.

## Versions

There are three separate concepts:

1. Extension implementation version.
2. Agent implementation version.
3. Extension ↔ Agent interface version.

Agent and Extension implementation versions are independent. Increment a component's version only when its behavior changes; behavior-driving MCP descriptions count as an Extension change. Leave the other component's version unchanged. Documentation/test-only edits do not by themselves require implementation-version bumps. Synchronize implementation versions only when the user explicitly requests it, such as before a chosen public release. Matching interface versions determine compatibility, not matching implementation versions.

Change the interface version only for a required compatibility change. A new required Agent endpoint or response contract normally increments it. Documentation-only and Extension-only behavior does not.

When the Extension version changes, update:

- `extension/package.json`;
- the root package entry in `extension/package-lock.json`;
- `extension/manifest.json`;
- `EXTENSION_VERSION` in `extension/background.js`.

When the Agent version changes, update `AGENT_VERSION`. When the interface changes, update both Agent and Extension interface constants in the same change.

## Build and verification

```sh
npm run build --prefix extension
python -m unittest discover -s agent/tests -p 'test_*.py'
npm test --prefix extension
git diff --check
```

The Extension test command rebuilds both bundles. The full Agent suite must be run from the repository root so the `agent` package imports correctly.

For media changes, create a temporary synthetic source and run the real FFmpeg path. For Windows-only or Chrome-only behavior, record that automated tests passed but live verification remains required.

## Documentation checklist

When behavior changes:

- update `TOOLS.md` for public tool changes;
- update `ERRORS.md` for stable new error codes;
- update `TROUBLESHOOTING.md` for a new user-visible failure mode;
- update the feature document for substantive semantics;
- update `ARCHITECTURE.md` only for a boundary or data-flow change;
- keep release numbers out of durable documents;
- run the documentation contract test.

## Packaging

Package the repository with generated bundles and the bundled Workspace demo, excluding `.git`, `node_modules`, Python caches, user-created Workspace files and prior archives. Verify the ZIP with `unzip -t` or an equivalent archive tester.

Do not commit, push or publish unless the user explicitly requests it.

## Task history and developer configuration

Use `TaskHistory(configured_task_history_limit)` for Agent task registries; bind a runner immediately after registration so done callbacks can prune terminal records after actual final publication. Keep failed/cancelled records as well as completed ones. Never evict queued/working records or remove Workspace files as part of history maintenance. Browser task Maps are pruned before persistence and status/cancellation access. Test small configured limits and active-runner publication races.

`newToolsEnabledByDefault` belongs to the single Agent JSON configuration, not a developer control in user Settings. It initializes preferences for automatically discovered custom tools only; newly introduced built-in tools default to enabled independently of this parameter; never overwrite saved per-tool choices. `value` and `comment` sit beside each other inside every setting object, preserving strict JSON parsing without duplicate parameter names. `read_agent_config()` unwraps values at one boundary; internal code and HTTP responses continue using ordinary typed values. New settings must include an adjacent meaningful explanation. `mediaWidgetHandshakeTimeoutSeconds` defaults to 10 (integer 1–300) and is read for each media_show call and sent through private tool-result metadata, so a cached widget template does not pin an old setting. It controls image, video and audio connection/loading attempts; the retry interval remains one second. Older Agents without the optional response field use 10; invalid configuration values are reported instead of silently coerced. See [TIMERS.md](features/TIMERS.md) for clock semantics and limitations.

Configuration example (all settings use this layout):

```json
{
  "port": {
    "value": 17843,
    "comment": "Loopback HTTP port. Restart the Agent after changing it."
  },
  "limits": {
    "completedTaskHistoryLimit": {
      "value": 2000,
      "comment": "Maximum retained terminal records per task manager; output files remain."
    }
  }
}
```

### Browser Agent changes

Keep page JS fixed and Extension-owned; never add a public eval/source-string parameter. Preserve AX hierarchy and deferred text access. Keep all physical tabs and authenticated resource URLs private, validate current page versions, and refuse alternate-tab fallbacks. Popup sessions and resource continuations do not use media widgets to identify their destination. Run `extension/tests/browser-agent.test.mjs` and `agent/tests/test_browser_resources.py` with the normal suite; then verify actual Chrome/ChatGPT behavior separately. See [Browser Agent](features/BROWSER_AGENT.md).

Run `extension/tests/browser-page-updates.test.mjs` for full first reads, actual serialized payload ceilings, automatic action differences, selected-target guards, resource replacement and navigation races. Preserve unchanged IDs outside a navigating iframe, but reject its old IDs even if Chrome reuses AX/backend identifiers. Never reinstall an invalidated frame from an in-flight read. Main-document replacement still invalidates all references. `site_interact` must distinguish dispatched input from a later failed observation, so the model does not repeat an already executed click. Keep new Agent observation settings optional for compatibility; explicit MCP limits may lower configured ceilings only.

## Browser Agent timing diagnostics

Keep optional timing instrumentation behind `extension/browser-diagnostics.js` and `browserStudyDetailedLogging` in the single Agent config. Use `trace.span`/`begin` around waits/work and `trace.command` for CDP aggregates; emit only allowlisted counts, IDs, stage names and durations. Never log tool arguments, page contents, request URLs, exception messages or CDP bodies. Logger failures must not alter automation. Timing spans can overlap; gaps between tool calls are not pure model inference time. Tests exercise disabled/enabled logging, unchanged public results and target tabs, aggregation, failure transparency and private-data exclusion.

## Shared Composer media retry policy

`extension/composer-media-retry.js` centralizes bounded readiness/acknowledgement polling. `composerMediaRetryCount` and `composerMediaRetryIntervalSeconds` are top-level commented Agent settings exposed through the optional private `composerMediaRetry` field of `/internal/tool-limits`; absence uses 15/2 defaults, while invalid values remain explicit configuration errors. Count denotes repeats **after** an initial immediate probe. Use the helper for shared file acceptance, enabled-Send readiness and post-click UI acknowledgement; Never repeat file insertion in its probe. The Send controller may dispatch again only with enabled Send, expected attachment count, guarded text and unchanged target and no acknowledgement. Keep exact-target/edit/cancellation guards before every pre-Send probe and at the existing synchronous Send commitment boundary. Preserve the separate active-generation wait and uploaded drafts on failure.

All service-worker action logs pass through `consoleAction`: one string starting with an ISO UTC timestamp and serialized details. The optional Browser Agent timing field allowlist/privacy policy remains in `browser-diagnostics.js`. Rebuild the worker after source changes. Unit and shipped-worker tests cover late background readiness/acknowledgement, immediate success, one upload, bounded repeated Send, response waits, cancellation and exact-tab/user-edit guards.

Shared Composer submission alternates owning-form `requestSubmit` and trusted pointer input for unacknowledged enabled Send attempts; no-form layouts use pointer input. A successful dispatch is not acknowledgement. Check acknowledgement before guards, after the readiness await and after dispatch; a late acknowledgement must end retries even if clearing the sent Composer makes its old payload guard fail. Disabled/missing Send is never dispatched. Before the first attempt, active generation retains the existing bounded response wait; afterwards the normal retry budget bounds acknowledgement and repeated dispatches. Keep the synchronous cancellation commitment before the first dispatch. Test ignored initial sends, delayed acknowledgement with disabled Send, timeout, user edits, target closure and no duplicate uploads.

Browser resource batches resolve all IDs before creating a task, enforce the existing current-chat count limit, save bounded bytes under `study-this-site/`, then attach once. Pass the shared public task ID and observed resource ID through the private Agent ingestion protocol. Validate these naming fields independently in the Agent; keep filenames Windows-safe, deterministic and non-overwriting. Expose ordered per-resource file receipts, never private URLs/host paths. On partial save failure or cancellation, retain already published receipts and avoid uploading an incomplete batch. Startup clear is restricted to the explicit new-tab target and happens before monitoring later user edits.

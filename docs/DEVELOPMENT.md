# Developing ResearchTube

This guide is for human contributors and coding agents. Read repository-root `AGENTS.md` and `ARCHITECTURE.md` first.

## Prerequisites

- Python 3.10 or later.
- Node.js and npm for Extension builds and tests.
- Chrome or Chromium for live Extension verification.
- FFmpeg and ffprobe for real media integration tests.
- yt-dlp and Deno when testing local YouTube downloads and the PO-token provider.

The independent TypeScript Cloudflare server lives in
[`cloudflare-worker/`](../cloudflare-worker/README.md). It requires Node.js 22+
and has its own lockfile, D1 migrations, build and local workerd integration
tests. Run `npm ci`, `npm run check` and `npm test` in that directory. Its
generated catalog and validators come from the built Extension and are not
committed. `extension/cloud-connection.js` implements enrollment and the outbound
adapter; `chatgpt-cloud-bridge.js` owns the separate widget handshake. Setup
starts in ChatGPT with root-origin MCP/OAuth before local installation. Follow
[Public connection](features/PUBLIC_CONNECTION.md) and the protocol document;
no device/focus-based fallback may replace exact chat binding. CI checks this package without
deploying or requiring Cloudflare/provider credentials.

Productive calls resolve the authenticated conversation's binding inside the
server dispatch. Keep startup free of model-side status checks and routing IDs.
Connection repair follows an actual connection error; it must not become a
preflight before ordinary work. Unbound calls fail immediately without queueing.

`npm run test:chrome` in `cloudflare-worker/` runs the real unpacked Extension
in an isolated Windows Chromium profile against local workerd. It needs an
available Playwright module (optionally set `RESEARCHTUBE_PLAYWRIGHT_MODULE` to
its directory) and defaults to installed Microsoft Edge. Override
`RESEARCHTUBE_BROWSER_CHANNEL` for another browser supporting unpacked-extension
launch flags. Browser page/widget origins and provider session are simulated;
extension messaging, sender identity, document IDs, dispatch and WebSockets are
real. The test routes extension transport to loopback and blocks production
DNS. It does not replace real Google/ChatGPT rollout verification.

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
| System context and diagnostics | `extension/system-tools.js`, `extension/chat-context.js`, `extension/system-diagnostics.js` |
| Settings and popup | `extension/settings.*`, `extension/popup.*` |
| Browser Agent contracts and page operations | `extension/browser-tools.js`, `extension/browser-agent.js`, `extension/browser-groups.js`, `extension/tab-automation.js`, `extension/browser-page.js`, `extension/browser-observation-options.js`, `extension/browser-frame-policy.js` |
| Artifact workflow/public contracts | `extension/artifact-tasks.js`, `extension/artifact-tools.js` |
| Custom Tools | `agent/custom_tools.py`, package manifests/implementations under `agent/custom-tools/` |
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

GitHub Releases have no additional shared version. Their title lists both implementation versions; the tag is `ext-<Extension version>_agent-<Agent version>`. Each new pair identifies one release in chronological publication history. No comparison of component version numbers or automatic synchronization is performed. `release.json` contains `prerelease: true` for preliminary builds; change it to `false` when publishing the first stable version pair. Published pairs and their assets are preserved.

Change the interface version only for a required compatibility change. A new required Agent endpoint or response contract normally increments it. Documentation-only and Extension-only behavior does not.

Change the Extension version only in `extension/manifest.json`, then run `npm run build --prefix extension`. The build synchronizes the derived versions in `extension/package.json` and `extension/package-lock.json`. Chrome, the popup and service worker read the installed manifest version; the service worker also inserts it into the media widget template. Do not add hardcoded implementation versions to JavaScript or widget HTML.

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

The release workflow builds four platform archives with checksum-pinned copies of FFmpeg/ffprobe, yt-dlp, Deno and cloudflared. Mac archives preserve FFmpeg's adjacent libraries and license files. Each runner invokes every bundled tool, packages the source Agent and tests it from the extracted archive; the Windows runner also builds and tests the frozen EXE and Windows speech.

`scripts/tool-bundles.json` must pin versioned download URLs together with their SHA-256 digests; rolling `latest` URLs change their contents and break checksum verification. For BtbN FFmpeg, choose the last build of a completed month, retained upstream for two years, rather than a daily build retained for only 14 builds. Refresh these pins before upstream retention expires, using the release asset's published SHA-256 digest. Never bypass a checksum mismatch; the download error reports both expected and actual digests.

To reproduce a platform package locally, first download its locked dependencies and verify/run them, then package and smoke test:

```sh
python scripts/bundle_tools.py --platform linux-x64
python scripts/smoke_bundle_tools.py --platform linux-x64
python scripts/build_release.py --platform linux-x64
python scripts/smoke_agent.py --zip dist/ResearchTube-Linux-x64.zip
python -m unittest discover -s scripts/tests -p 'test_*.py'
```

Use `windows-x64`, `macos-arm64` or `macos-x64` as appropriate. The Windows build additionally needs `python -m pip install -r agent/requirements-build.txt`; it runs on a Windows x64 host and includes `agent/ResearchTubeAgent.exe`. Only the archived config's Workspace value is reset to `workspace`; the developer's config is unchanged. Existing output archives are rejected. Each `agent/tools/tools-manifest.json` records binary versions, SHA-256 digests, source URLs and platform; `THIRD-PARTY-NOTICES.txt` and FFmpeg's license files are shipped alongside them.

The **Build and publish ResearchTube release** GitHub Actions workflow builds all four archives on matching GitHub-hosted runners and uploads those tested artifacts to the publishing job. The publisher attaches each archive and its SHA-256 sidecar to one Extension/Agent version pair. It uses the built-in `GITHUB_TOKEN` with `contents: write` only in the publishing job; no personal token is needed. The tag targets the source commit recorded inside each `release-info.json`. Prereleases are not marked Latest; stable releases become Latest. An already published pair is skipped, so documentation edits and repeated runs never replace an old download. A failed upload retains a draft; rerunning the workflow resumes missing identical assets and rejects any conflicting draft asset. To publish the next build, increment the changed component's implementation version and push to main. Keep the prerelease flag true until the stable release is intended. Version numbers remain developer decisions.

Setting `prerelease: false` also promotes an already published preliminary release for the current version pair to stable and Latest. Its original tag, source commit and download assets remain unchanged; only the release flags and generated preliminary heading are updated. Repeated runs leave the stable release unchanged, and a preliminary configuration never demotes it.

Native Windows verification is separate from Linux/macOS source smoke checks. Custom Tools remain external Python modules; additional third-party imports must be included when rebuilding the EXE, or installed for Python source mode. Runtime pip installation does not extend a frozen interpreter.

The Windows EXE embeds `icons/researchtube.ico`, selected in `agent/ResearchTubeAgent.spec`. This multi-size icon contains the existing Extension PNG artwork at 16, 24, 32, 48, 64 and 128 pixels. When changing the logo, update the ICO alongside the PNGs and rebuild the Windows release.

Do not commit, push or publish unless the user explicitly requests it.

## Workspace configuration

`workspacePath` in the single `agent-config.json` uses the same `value`/`comment` layout as other settings. The shipped value is `workspace`; missing/blank legacy values select the same installation-relative directory. Startup never prompts or rewrites the config. `startup_workspace_path()` resolves and creates the directory with `exist_ok=True`, preserving files. Native absolute paths select another drive; invalid non-text/NUL paths fail startup with `CONFIG_INVALID`. `serve()` freezes the root before health/server initialization; edits require restart and never migrate files. Source and EXE use their external installation root, never the working directory or PyInstaller extraction folder. Test noninteractive default/custom creation, preservation, stable run roots and logical path isolation.

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

Keep page JS fixed and Extension-owned; never add a public eval/source-string parameter. Preserve AX hierarchy and deferred text access. Expose explicit participant tab IDs and safe page addresses, keep CDP handles/authenticated resource URLs private, validate live group membership and tab/document references, and refuse alternate-tab fallbacks. Popup sessions and resource continuations do not use media widgets to identify their destination. Run `extension/tests/browser-agent.test.mjs`, `extension/tests/browser-resource-groups.test.mjs`, `extension/tests/tab-automation.test.mjs` and `agent/tests/test_browser_resources.py` with the normal suite; then verify actual Chrome/ChatGPT behavior separately. See [Browser Agent](features/BROWSER_AGENT.md).

Run `extension/tests/browser-visible-images.test.mjs` for fixed DOM discovery of empty-alt images and CSS backgrounds, visibility/clipping, ignored or absent AX backing, stable IDs, resource replacement, bounded pagination and navigation during discovery. Preserve semantic roles and avoid duplicate images when AX already includes the element.

Run `extension/tests/browser-page-updates.test.mjs` for full first reads, actual serialized payload ceilings, automatic action differences, selected-target guards, resource replacement and navigation races. Preserve unchanged IDs outside a navigating iframe, but reject its old IDs even if Chrome reuses AX/backend identifiers. Never reinstall an invalidated frame from an in-flight read. Main-document replacement still invalidates all references. `site_interact` must distinguish dispatched input from a later failed observation, so the model does not repeat an already executed click. Keep new Agent observation settings optional for compatibility; explicit MCP limits may lower configured ceilings only.

## Browser Agent timing diagnostics

Keep optional timing instrumentation behind `extension/browser-diagnostics.js` and `browserStudyDetailedLogging` in the single Agent config. Use `trace.span`/`begin` around waits/work and `trace.command` for CDP aggregates; emit only allowlisted counts, group/tab/task IDs, stage names and durations. Never log tool arguments, page contents, request URLs, exception messages or CDP bodies. Logger failures must not alter automation. Timing spans can overlap; gaps between tool calls are not pure model inference time. Tests exercise disabled/enabled logging, unchanged public results and target tabs, aggregation, failure transparency and private-data exclusion.

## Shared Composer media retry policy

`extension/composer-media-retry.js` centralizes bounded readiness/acknowledgement polling. `composerMediaRetryCount` and `composerMediaRetryIntervalSeconds` are top-level commented Agent settings exposed through the optional private `composerMediaRetry` field of `/internal/tool-limits`; absence uses 15/2 defaults, while invalid values remain explicit configuration errors. Count denotes repeats **after** an initial immediate probe. Use the helper for shared file acceptance, enabled-Send readiness and post-click UI acknowledgement; Never repeat file insertion in its probe. The Send controller may dispatch again only with enabled Send, expected attachment count, guarded text and unchanged target and no acknowledgement. Keep exact-target/cancellation guards before every pre-Send probe and at the existing synchronous Send commitment boundary. Preserve the separate active-generation wait and uploaded drafts on failure.

All service-worker action logs pass through `consoleAction`: one string starting with an ISO UTC timestamp and serialized details. The optional Browser Agent timing field allowlist/privacy policy remains in `browser-diagnostics.js`. Rebuild the worker after source changes. Unit and shipped-worker tests cover late background readiness/acknowledgement, immediate success, one upload, bounded repeated Send, response waits, cancellation and exact-tab/user-edit guards.

Shared Composer submission alternates owning-form `requestSubmit` and trusted pointer input for unacknowledged enabled Send attempts; no-form layouts use pointer input. A successful dispatch is not acknowledgement. Check acknowledgement before guards, after the readiness await and after dispatch; a late acknowledgement must end retries even if clearing the sent Composer makes its old payload guard fail. Disabled/missing Send is never dispatched. Before the first attempt, active generation retains the existing bounded response wait; afterwards the normal retry budget bounds acknowledgement and repeated dispatches. Keep the synchronous cancellation commitment before the first dispatch. Test ignored initial sends, delayed acknowledgement with disabled Send, timeout, text edits included in task Send, target closure and no duplicate uploads.

Browser resource batches resolve all IDs before creating a task, enforce the existing current-chat count limit, save bounded bytes under `study-this-site/`, then attach once. Pass the shared public task ID and observed resource ID through the private Agent ingestion protocol. Validate these naming fields independently in the Agent; keep filenames Windows-safe, deterministic and non-overwriting. Expose ordered per-resource file receipts, never private URLs/host paths. On partial save failure or cancellation, retain already published receipts and avoid uploading an incomplete batch. Startup clear is restricted to the explicit new-tab target and happens before monitoring later user edits.

## Optional task chat context

See [Task chat context and automatic Send](features/TASK_CHAT.md). Startup prompts provide ChatGPT tabId once. Asynchronous launches accept it optionally; public workflow completion notifies only idle ChatGPT. The independent Composer watchdog shares the existing Send controller and configurable stability timeout. Task IDs remain unchanged.

## Public connection state

`cloud-connection.js` owns the public server connection. Popup and toolbar readiness derive from its durable status. Startup clears obsolete connection settings and alarms while preserving Agent configuration, Workspace and tool preferences. Status responses never include installation credentials. Run the connection-state and cloud-connection tests and verify Chrome behavior after reloading the Extension.

## Popup Help and user documentation

`docs/HELP.md` is the user/assisting-chat entry guide. Keep setup and recovery there aligned with Installation, Tools, Troubleshooting and feature guides; exact schemas remain in code. Check current official OpenAI instructions when changing external setup. `AGENTS.md`, Architecture and this document remain the coding-agent entry path.

Popup Help sends only `open-help` to the worker, which validates the popup sender, creates an active new ChatGPT tab and inserts/sends the fixed `RESEARCHTUBE_HELP_PROMPT` linking to the live `main` guide. No MCP connection, browser session, current-site data or Local Agent readiness is required. Reuse existing bounded Composer/CDP preparation, prompt verification and Send acknowledgement. Guard the exact new chat and draft before Send, release the debugger on success/failure, and never fall back to another chat. Help owns only startup, not an ongoing Composer watchdog. Run `extension/tests/popup-help.test.mjs` for source/shipped-worker startup, edit/navigation guards, sender validation and failure cleanup, plus popup UI and documentation tests.

## Popup startup prompts

`extension/startup-prompts.js` owns browser-only defaults, strict normalization and single-pass square-bracket substitution for **Study this site** and **Describe this video**. The optional private `GET /internal/prompt-templates` route returns only configured `studyThisSitePrompt`/`describeThisVideoPrompt` text from the external Agent config, validating type, length and the per-action placeholder allowlist. It returns the in-memory `STARTUP_PROMPTS` snapshot loaded by `serve()` before binding, with no per-request file reads or task pruning and no other config fields. Only the exact unsuffixed keys select templates; numbered `studyThisSitePrompt1`/`describeThisVideoPrompt1` (and other positive integer suffixes) are ordinary commented config entries retained for manual renaming, never returned by this route or selected as a fallback. Shipped active/offline defaults request answers in the user’s language (`in my language`); variant 1 preserves the original shorter wording. Restart the Agent to apply edits. Missing entries or an unavailable optional Agent use Extension defaults for both shortcuts; invalid config fails Agent startup, and malformed responses must fail visibly before creating tabs. `browser-agent.js` gets templates through its host, while the video shortcut fetches them before opening its chat. Tab and group values come from exact newly created Chrome objects; there is no session token. Changes to the shipped defaults must also update the offline defaults and their parity test. Keep this route private and do not place config text in MCP or diagnostics.

## Composer delivery and startup reset

Async chat delivery has one behavior: append new files/text to the live Composer and Send everything together. `composerPolicy` is removed from public inputs/results and internal task options; stale callers must refresh the MCP catalog. Text edits, preexisting drafts/cards and extra attachments do not block task Send. Capture the visible attachment count before upload and require at least that count plus the batch size, including after a Send delay. Keep target/conversation, cancellation, prepared-document and acknowledgement checks; never upload twice during Send retries. Browser continuations use a trusted editor insertion at the end of the current text and confirm their insertion. Explicit task/group messages bypass the standalone watchdog's draft-stability test, while file reservations still own their delay and cancellation boundary. The independent watchdog keeps its stability rules. Only Help, Study this site and Describe this video call `clearCurrentChatComposer(target, checkCancelled)` before their new-chat prompt; there are no behavior flags. Test occupied Composer and mid-upload/delay edits alongside navigation, cancellation, missing files and acknowledged Send.

## Storyboard HTTP diagnostics

`agent/storyboards.py` retains safe transfer context across parser errors and the outer timeout. Header projection strips MIME parameters, limits strings, allowlists encodings and request hosts, and excludes raw bodies/headers/URLs. For rejected HTTP status or watch-page MIME, sample at most 4096 HTTP-body bytes/0.5 seconds, decoding chunk framing; classify the prefix and return only its category and counts. Sampling failures retain the primary HTTP failure. `extension/storyboards.js` validates every optional response diagnostic before projecting it and includes the context in the error message so the sanitized system journal sees it. Keep diagnostics compatible with older responses; never infer a network block just from the prefix. Storyboard discovery returns null format; successful publishedSheets carry detected format/MIME. Image acceptance uses actual supported raster container bytes, independent of MIME and URL suffix; container checks are not a full decoder. Preserve original bytes without labels and actual format with labels. WebP/PNG use lossless encoding; AVIF uses lossless AV1; JPEG uses maximum quality with unavoidable re-encoding and GIF is palette-limited. Do not silently convert formats or resize. The nullable discovery format changes the compatibility contract, so update both components together. Test mislabeled image bytes, missing/malformed MIME, HTML/JSON, gzip, chunked replies, bounded/slow bodies, redirects, partial-body timeouts and private-data exclusion. Run real FFmpeg coverage for all supported formats, unchanged dimensions and unchanged WebP/PNG pixels outside labels.


## Single-chat site groups

`browser-groups.js` owns one `ownerTabId` per group, a dynamic site roster and one last-reported site snapshot. `browser-owner.js` reads/writes a tiny identity/state marker through fixed Extension-owned isolated-world code on grouped ChatGPT pages. Extra chats are ignored by the public roster and never become controllers, including after worker suspension or owner closure. Manual claiming requires an explicit widget connection and exactly one ChatGPT when no owner exists. Closing/moving the owner stops all tasks; site departure cancels only its tasks. Do not introduce arbitrary owner election, active-tab fallback or group membership storage. Public `chatTabId` is routing; MCP has no authenticated browser-origin field. Test all Site tools' ownership checks, mirrored-marker recovery, ambiguous manual groups, Stop/resume, closure/navigation before Send and dynamic site changes. Run actual Chrome separately.

## Windows tray and live log

`desktop.py` owns only the Windows desktop host. Import pystray/Pillow/Tk lazily for tray mode; console use on Linux/macOS remains dependency-free. Windows source default launches pythonw and returns without hiding the parent terminal; `.pyw` is the direct double-click launcher. `--console` runs in the terminal. The EXE uses PyInstaller `console=True, hide_console="hide-early"` so speech helper pipes remain supported; explicit console mode restores its console. Bundle GUI hooks and install `requirements-windows.txt` for Python tray/Chrome checks. The tray image loads `extension/icons/researchtube-128.png` from the extracted package.

Tk runs on the main thread, pystray's Windows loop on its own thread, and the asyncio server on a worker. Menu callbacks only enqueue UI actions. Closing the log withdraws it; Exit schedules task cancellation on the worker loop and awaits server cleanup before removing the icon. Startup failures remain visible in the log window. A per-port Windows mutex prevents duplicate source/EXE instances. Copy log copies the current Text selection when present, otherwise the full retained live history. Live history and UTF-8 disk logs are bounded; no host paths or log contents are added to MCP. Hide owned CLI subprocess consoles. Windows Chrome checks use psutil in a worker thread, preserve startup-only caching, ignore renderer processes and report unreadable arguments as unknown. Smoke tests launch source and EXE with `--console` and closed stdin. Live Windows validation must cover tray clicks, hidden startup, close/reopen log, Exit, duplicate launch, speech pipes and Chrome flags in both modes.

# ResearchTube troubleshooting

## Instructions for an assisting chat

You are helping a ResearchTube user diagnose a local installation. Follow this document in order. Do not guess, do not ask for secrets, and do not recommend reinstalling everything before collecting the bounded status relevant to the symptom. Distinguish actions you can perform through ResearchTube tools from actions the user must perform in Chrome, Settings or the local Agent console.

Never ask the user to paste an OpenAI API key, Tunnel ID, cookie, PO Token, complete Chrome profile, signed media URL or unredacted process command line.

## First classification

Ask which of these best describes the failure:

1. ResearchTube is absent from ChatGPT or no tools are visible.
2. ResearchTube is visible, but Agent-backed tools fail.
3. One YouTube research operation fails.
4. A download, frame, storyboard, map or clip task fails.
5. The local media card is blank or its buttons fail.
6. TTS, clipboard, screen or camera behavior fails.
7. The Extension Settings connection test fails.

If tools are callable, begin with `system_agent_status`. Report the Extension version, Agent availability, Agent version, both interface versions, Workspace status and relevant component statuses. Do not request physical paths through MCP.

## ResearchTube is missing from ChatGPT

Check in this order:

1. The unpacked Chrome extension is enabled and has no error in `chrome://extensions`.
2. ResearchTube Settings reports a successful tunnel connection.
3. ChatGPT Developer Mode/private MCP apps are available for the account/workspace.
4. The ChatGPT ResearchTube connection uses the same Tunnel ID configured in the Extension.
5. Use the ResearchTube app management **Refresh** action after an Extension update.
6. Start a new conversation and explicitly select or mention `@ResearchTube`.

If the Extension popup reports a tunnel error, use the tunnel section below. Do not troubleshoot FFmpeg or the Agent until the MCP connection itself is present.

## Tools are missing or an old schema is visible

Symptoms include a newly added tool being unavailable or ChatGPT calling a removed name.

1. Confirm the Extension was reloaded from the intended `extension/` directory.
2. Open ResearchTube Settings and confirm the tool is enabled. `system_agent_status` is always enabled.
3. In ChatGPT app management, refresh ResearchTube's MCP schema.
4. Use a new chat to avoid a conversation retaining an older tool snapshot.

`TOOL_DISABLED` means the Extension knows the public tool but the user disabled it in Settings. It is not an Agent failure.

## Agent unavailable or incompatible

### `AGENT_UNAVAILABLE`

The Extension could not reach the configured loopback port.

User checks:

- start `python agent/researchtube_agent.py`;
- keep its console open;
- confirm the startup summary completed;
- confirm Extension Settings uses the same port as `agent-config.json`;
- use **Test connection**.

Do not suggest opening the Agent port in a firewall or binding it publicly. It must remain on `127.0.0.1`.

### `AGENT_INTERFACE_INCOMPATIBLE`

The Extension and Agent come from different incompatible releases. Record both implementation versions and interface versions from `system_agent_status`. Replace the older component with the matching release, reload the Extension if it changed, restart the Agent if it changed, then refresh the ChatGPT schema.

### Workspace unavailable

Check that the user can create files in the extracted `agent/` directory and that `agent/workspace/` is not redirected through a symlink or unsupported reparse point. Do not delete the Workspace. Preserve and back up existing user media.

## Tunnel connection failures

| Result | Meaning | User action |
| --- | --- | --- |
| `API_KEY_MISSING` | No key was supplied | Enter a dedicated restricted key in Settings |
| `API_KEY_INVALID` | OpenAI rejected the key | Create/check the key; never paste it into chat |
| `TUNNEL_ID_MISSING` | No tunnel ID was supplied | Enter the `tunnel_...` identifier |
| `TUNNEL_NOT_FOUND` | The key cannot find that tunnel or the ID is wrong | Verify the tunnel and organisation |
| `TUNNEL_PERMISSION_DENIED` | The key lacks required tunnel access | Grant only the required Tunnels Read + Use permissions |
| `NETWORK_ERROR` | The Extension could not reach OpenAI | Check connectivity, proxy/VPN and retry |

The API key belongs only in ResearchTube Settings. Diagnostic exports intentionally omit it and the Tunnel ID.

## Local component failures

Call `system_agent_status` and inspect the named component. These diagnostics, including Workspace free space, are saved at Agent startup. A `checking` state means the one-time background check has not finished; poll status again later. The low-priority Chrome switch check starts only after all tool/path/version checks and their startup log lines finish, followed by `Startup checks completed. Waiting for Extension requests.` It never runs alongside that startup diagnostic batch or as part of a health request. After replacing executables or relaunching Chrome with a different silent-automation flag, restart the Agent to obtain a new snapshot. Settings connection tests do not rerun diagnostics.

- `missing`: put the executable in its documented `agent/tools/` location or install it on `PATH`.
- `error`: discovery is ambiguous or the executable cannot report a usable version. Remove duplicate candidates and test it locally.
- PO-token provider not ready: repair/install the provider and Deno runtime according to the release's tool instructions, restart the Agent and verify readiness.

FFmpeg/ffprobe affect local media. yt-dlp/Deno/provider affect local YouTube downloads and fallbacks. cloudflared affects only explicit online shares.

## YouTube search or research failures

### Verification, 403 or 429

`YOUTUBE_SEARCH_RATE_LIMITED` or `YOUTUBE_SEARCH_VERIFICATION` means YouTube requested verification or rate-limited the page context. Respect the returned retry time. Do not loop calls, rotate identities or attempt to bypass the check. The user may open YouTube normally and complete any visible verification before retrying.

### Transcript unavailable

Use `youtube_get_video` first and inspect public caption tracks. Select a returned `trackIndex`. A video may genuinely have no public captions or may be restricted.

### Comments unavailable

Comments may be disabled, restricted or absent. Confirm the video ID and try video metadata first. Do not infer that an empty public comment result is an Extension installation failure.

### Page-context unavailable

Keep a normal YouTube tab available and retry once. ResearchTube already performs bounded stale-tab recovery; repeated failure should be reported with the safe diagnostic code, not raw page data.

## Download, frame, storyboard, visual-map or clip failure

1. Poll the task's normal status tool until it is terminal.
2. Record the public error code, phase, percentage and completed-output counts.
3. Preserve completed files.
4. For YouTube download/frame failures, call the matching bounded diagnostics tool once.
5. Check component availability and Workspace free space.
6. Check for `DESTINATION_EXISTS` or a more specific destination conflict.
7. Use `media_probe` on a local source before assuming it contains video/audio streams.

Do not delete output directories as a generic fix. ResearchTube intentionally refuses silent overwrite. Choose a new output name/directory or move the existing file deliberately.

## Blank media card, Refresh failure or Copy failure

First distinguish two layers:

- the MCP widget is the conversation anchor;
- the visible media is rendered by the ResearchTube extension-owned overlay.

User checks:

1. Confirm the current Extension is enabled and has permission on `chatgpt.com` and the ChatGPT sandbox origin declared in the manifest.
2. Confirm `system_agent_status` reports a reachable Agent.
3. Confirm the logical file still exists with `workspace_stat`.
4. Call `media_show` again for that exact logical path in a new message.
5. Open Chrome DevTools only if needed and copy ResearchTube-prefixed bridge messages, not unrelated page data.

Filter the ChatGPT browser console by `ResearchTube` and keep messages from all frame contexts visible. Media diagnostics identify the widget build, its view/request IDs, notifications, each child-to-parent relay, viewer attachment, private worker resolution, local HTTP status, byte count, decode and loaded/error acknowledgment. The Extension worker logs its own version and resolution result in its service-worker console. Logs never include image bytes, Blob contents or the private media URL. There is no in-memory diagnostic history in the bridge; DOM scans only reprocess changed markers to avoid feedback loops and repetitive records. ResearchTube's active source logging uses console.info instead of console.error/console.warn. Browser-generated network/CSP errors and unexpected uncaught failures remain browser diagnostics.

Copy in the media anchor uses the same nested-frame route as media display, with one notification per second until acknowledgment, bounded by the configured handshake timeout. A single action ID suppresses duplicate clipboard writes. If Copy reports that the media widget is not connected, inspect media-handshake logs first. Retrying Copy does not fetch the image or submit any files to the chat.

If images work but audio/video never reach `viewer attached`, compare the widget and Extension versions in the console. A cached `ResearchTube image widget 2.2.58` uses a different notification for audio/video. The current Extension accepts both its local event and its JSON-RPC parent notification, and logs `cached audio/video widget adapted via=…`. If the notifications were lost, `cached media card found; verifying Workspace metadata` reports recovery from the known ResearchTube card DOM; the Agent confirms the logical file, kind and MIME before mounting a player. Repeated unchanged DOM does not poll the Agent. Replace the complete Extension folder, reload the Extension and reload the existing ChatGPT page to install the new content script; the compatibility path can use the existing conversation. Refresh MCP metadata to publish the new canonical resource URI for subsequent cards. If the compatibility log is absent, check sandbox-frame injection permissions. For new resource reads, the worker console prints `[ResearchTube media resource] extension=… widget=… requested=… current=…`; this distinguishes the packaged HTML being served from the template running in ChatGPT. A missing resource-read log means no new HTML was requested, not that media loading succeeded. Current templates and cached-DOM recovery use the configured handshake deadline; direct cached audio/video notifications use ten seconds.

For images, video and audio, `[ResearchTube media]` console messages show the Extension version, origin/top-level state, view ID and transitions (`viewer attached`, `loaded`, `error`). Repeated `origin=null` lines alone do not prove failure. `viewer attached` confirms receipt only; `loaded` confirms an actual image or native audio/video metadata load. The widget retries notification every second, with a default ten-second connection/loading deadline. If it times out, click its Retry/Refresh control; a failed or blank viewer does not hide that control. Increase `mediaWidgetHandshakeTimeoutSeconds.value` in `agent/agent-config.json` if needed (integer 1–300). The next media_show call receives the changed value through tool-result metadata, even with a cached template; an existing loading attempt retains its original deadline. Existing Settings controls are unchanged.

`Extension context invalidated` at `chrome.runtime.getURL()` means the page's old content script can no longer use the Extension runtime. This can occur after reloading, updating or disabling the Extension while ChatGPT stays open. Reload the affected ChatGPT tab after the Extension is available, then retry the image. This failure occurs before local image fetching; restarting the Agent does not replace the page script. The image bridge catches runtime failures, logs once with console.info, disconnects its observers/listeners and removes its own overlays. It does not reload the user's tab or modify ChatGPT content automatically.

If no image viewer attaches, check Extension permissions on the sandbox subdomain/opaque descendant as well as `chatgpt.com`. If it attaches but never loads, inspect the top ChatGPT console for `viewer stage=` records. The exact bound viewer relays only allowlisted stages and small numeric/boolean details; at most 30 diagnostic records are accepted per attempt. A timeout logs the last received stage. `viewer document loaded` alone does not prove the script ran; `viewer script ready`, local HTTP status, byte count and decode stages distinguish these failures. Image readiness must not wait for a paint callback while the parent keeps the viewer hidden. The viewer's own console still contains its original diagnostics. `media-viewer.html` must load the packaged `media-viewer.js`; inline Extension scripts cannot run. A `NameError` for `headers` in the Agent media GET route is an Agent request-parser defect: the handler must receive parsed headers along with the method/path/body. It is not evidence that the request was blocked before reaching the Agent. The image viewer uses Extension fetch plus a Blob URL to avoid an HTTP URL in the image element. Test the known small image, then an MP4 containing H.264/AAC and a supported small audio file. Audio/video elements must use `chrome-extension://…/_researchtube/workspace-media`, not an HTTP loopback URL. In the Extension worker, `media response` with status 206 confirms a streamed byte range; status 416 is an unsatisfiable range. A 403 response means the request did not identify the packaged viewer. An unsupported codec produces a short native-media error and leaves Retry available. Refresh stops prior playback; no autoplay is requested.

`Copy workspace path` must copy only a logical path such as `captures/frame.png`. If it copies a physical path, stop and report a privacy-contract defect.

## Google Translate TTS

For `GOOGLE_TRANSLATE_UNAVAILABLE`, verify normal network access to Google Translate and that Chrome permits the Extension's debugger permission. ResearchTube should retain an inactive Translate tab, clear previous source text, insert and verify new text, wait for the enabled source listen control, and click `aria-label="Listen to source text"` through CDP browser input.

For `GOOGLE_TRANSLATE_PLAYBACK_FAILED`, successful mouse dispatch alone is insufficient: the source control must switch to `Stop listening`. The Extension observes before clicking and follows replacements of the source control. Disabled or briefly missing controls remain pending during asynchronous startup. It waits a full 60-second startup window before one guarded direct-control retry, then another window for confirmation, keeping focus emulation throughout. The retry is never triggered after only two seconds, and only Stop listening confirms a successful start; prefetched audio is insufficient. Unconfirmed idle never reports success. The observer catches very short Stop/Listen transitions between polls. Check the console for confirmed playback or the direct-control retry.

For file output, the MP3 response is collected through CDP network events; ResearchTube does not use `chrome.tabCapture`. File-only mode temporarily mutes the tab and restores its previous state only after playback/audio collection completes.

Do not close the Translate tab as a standard troubleshooting step; reuse is intentional.

## Clipboard, screen and camera

- Clipboard operations are Windows-only and must be explicit. `CLIPBOARD_CHANGED` means the clipboard changed between status and read; request status again.
- Screen capture requires FFmpeg and OS permission. Linux Wayland is unsupported by the current implementation.
- Camera availability depends on FFmpeg's native device backend and user-granted OS permissions. Use `camera_list` before capture/recording.
- A busy camera or active recording must be stopped/finalized before starting an incompatible operation.

## Files sent to the current chat

- `media_to_chat` identifies the originating tab through its compact service widget, independent of the active tab/window. It requires an existing conversation URL and creates no new tab. `MEDIA_TO_CHAT_TARGET_NOT_FOUND` means the tab closed or the widget handshake did not arrive within 30 seconds; no alternate tab is used. Check that the current ResearchTube Extension is installed and its content script can run in ChatGPT widget frames. The widget should show “ResearchTube · Adding files to chat…” in one compact row. It reports a 32px height through the documented sizing APIs, but ChatGPT controls the final container size. Binding success alone does not mean the files were sent; use `media_to_chat_status`. ResearchTube no longer injects hiding CSS or changes host container styles. After upgrading from a version with hiding CSS, reload the Extension and then the ChatGPT tab to remove styles already injected into the old document. Refresh MCP tools/resources if an older widget template still appears.
- `MEDIA_TO_CHAT_TARGET_AMBIGUOUS` means that the same conversation is open in multiple tabs. Keep one tab for that conversation before retrying; different conversations may remain open in any windows.
- A host-reused service widget must start a fresh handshake for every task, even after a preceding `addToChat: false` result or timeout. Older widget code could remain stopped and cause `MEDIA_TO_CHAT_TARGET_NOT_FOUND` only on later calls. Refresh MCP tool/resource descriptors after installing the corrected Extension. Failed tasks remain failed; test with a new task rather than attempting to revive or retarget the old one.
- Binding refusal logs include `taskId`, `status`, `phase` and `reason`. `missing-task` indicates unavailable/evicted history, `inactive` indicates a task without a live binding capability (for example expired or cancelled before binding), and `token-mismatch` indicates metadata that does not match the task. `target-check` means authenticated-sender or exact-tab/conversation validation failed; consult the error code/message. Use `media_task_status` for creation-and-delivery tasks, or `media_to_chat_status` for standalone delivery. A duplicate handshake for an already-bound task only acknowledges its original destination; it neither revives a failed task nor repeats Send. Untouched unbound delivery tasks survive background-worker suspension with the original 30-second deadline.
- File acceptance waits for Composer attachment cards even if the native file input already lists the files. A delayed preview uses the configured retry window; timeout preserves the selected files and does not press Send or repeat upload.
- The default `composerPolicy: "requireEmpty"` refuses both text and existing attachments. Choose `"clear"` explicitly to discard them once before uploading; a failed or unavailable removal control stops preparation.
- New text after preparation stops Send under either policy. Attachment identity is not verified: replacing a file while preserving the expected count is allowed. Uploaded files remain attached; inspect the Composer before retrying. Editing and then deleting text also stops the task.
- Finish the assistant response after starting the task. `submitting` may wait for Send while ChatGPT is responding; request status in a later turn.
- Do not navigate the destination tab to another conversation during a task. Switching away to another tab does not change the captured destination.
- A count-limit rejection names the configured maximum. Check `mediaToChatMaxFiles` in `agent/agent-config.json`; Library uses a separate setting.
- `skippedFiles` reports oversized files and the applicable size threshold. If every file is skipped, no chooser opens. Check `mediaToChatMaxFileSizeMiB` and ChatGPT's own upload restrictions.
- A completed file-delivery task confirms both the Send click and a subsequent UI acknowledgement (new user turn or cleared Composer). For failures or an Extension restart, inspect the chat before retrying to avoid duplicate uploads; do not delete Workspace source files.

## Current-chat task fails at attachment verification (80%)

Inspect the Composer before retrying; remaining uploads and user text are preserved. The browser console reports the initial Composer scope/editor and text length. Delivery verification logs `found`, `attachmentCount` and `expectedCount`; filenames are not compared. Hidden legacy textareas must not be selected; a wrapper and its preview must count as one file. Native file inputs can be reset after upload, so ResearchTube verifies the visible cards instead of requiring their FileList to survive. Temporary unavailability or a count mismatch is retried up to `composerMediaRetryCount` times (default 15) at `composerMediaRetryIntervalSeconds` intervals (default 2). Exhausting this budget fails with `MEDIA_TO_CHAT_TIMEOUT` and preserves the Composer.

If `requireEmpty` adds a file over an existing draft, or `clear` adds files without removing the initial draft, collect these ResearchTube-prefixed console lines and the Extension version. Both policies must complete preparation and verify the live Composer before supplying files to the chooser.

## What to collect for a bug report

Collect only:

- Extension and Agent implementation versions;
- both interface versions;
- public component statuses;
- tool name and safe input summary;
- task ID, phase, progress and stable error code;
- the bounded Settings diagnostic export;
- relevant ResearchTube-prefixed browser console lines;
- operating-system family and Chrome version.

Do not collect API keys, Tunnel IDs, cookies, signed URLs, physical user paths or complete unredacted browser logs.

Use [Error reference](ERRORS.md) for code-specific guidance.

## Timer or old task no longer found

Timers are only in Agent memory. Restarting the Agent/computer loses their records. All task managers also evict the oldest completed/failed/cancelled records when they exceed `limits.completedTaskHistoryLimit` (default 2000 per manager). Increase this value in `agent-config.json` if longer status history is needed. Eviction does not remove any Workspace files. Create a new timer when required; do not report that the missing timer completed.

For an internet-clock failure, check the Agent machine's HTTPS access to `timeapi.io`; use `clockSource: system` explicitly if external synchronization is unnecessary. Confirmed system suspend fails the timer. `EXECUTION_GAP_DETECTED` alone does not establish that the computer slept. A completed timer does not initiate a new assistant response; continue polling within the initiating turn.

The new-tool default is a developer parameter in `agent-config.json`, `newToolsEnabledByDefault`. It is no longer a Settings checkbox. Saved individual tool choices remain unchanged; automatically discovered custom tools use this default when first registered. New built-in tools default to enabled independently of this setting. Config explanations live in each setting's `comment`; edit its adjacent `value`. `limits` remains a group containing these setting objects. The shipped config replaces the older flat format.

## Timer tools missing from the MCP catalogue

The public tool names are `timer_start`, `timer_status`, and `timer_cancel`. Check their individual switches in Extension Settings, in the Timers group. Saved individual tool choices remain authoritative. The developer default applies only to automatically discovered custom tools; newly introduced built-in timers default to enabled. A timer disabled individually remains disabled until its switch is changed.

When the client refreshes the MCP schema, the Extension console prints `[ResearchTube MCP] tools/list` with its serving release version, public tool count, enabled timer names and disabled timer names. If this line reports the three timer names, the serving Extension included them in its actual MCP response; verify that ChatGPT refreshed the intended ResearchTube connection. If the release is unexpected, check which Extension directory is loaded. Updating only the Agent does not change the MCP catalogue, because the Extension serves it.

Schema discovery remains available when the Agent or its developer configuration cannot be read. The cached custom-tool default (initially true) is used and the console reports the configuration issue. Actual Agent-backed operations still validate health, compatibility and configuration.

## Text clears but Composer attachments remain

Use `composerPolicy: clear` only when explicitly discarding the initial draft and attached files. Current ChatGPT preview controls use `aria-label="Remove <filename>"`; image and document controls may have `pointer-events: none` and zero opacity until the attachment card is hovered. ResearchTube invokes labelled removal controls through JavaScript, with a CDP hover/click path for unlabelled controls, then verifies the disappearance of each card. Opening the thumbnail or clicking the filename is not removal.

If removal cannot be confirmed, the task fails before new files are uploaded or Send is pressed. Inspect the Extension console for the removal-control diagnostic. No later cleanup clears text or attachments added during upload. A stale native file-input selection is reset only after removal of all initial UI cards has been confirmed.

### Composer image remains after explicit clear

If `media_to_chat` with `composerPolicy: "clear"` clears text but leaves an image, inspect task status and the Extension console. Labelled `Remove <filename>` buttons are invoked within the live Composer even while opacity/pointer CSS hides them. ResearchTube confirms that the attachment count decreased before uploading; disabled buttons, unknown removal markup, or an unconfirmed removal stop the task before new files or Send. The current-chat service widget declares only `inline` through resource metadata; refresh MCP resources if ChatGPT still offers fullscreen/PiP for an older template.

## Files are attached but delayed Send has not happened

Check `media_to_chat_status`: `waitingToSend` reports `sendNotBefore` in UTC and `remainingSeconds`. The requested delay begins after attachment acceptance. At zero remaining time, Chrome still needs to run the wake callback, verify the original Composer, and find an enabled Send. Keep the same conversation/tab open; the assistant response may need to finish. If you want to stop, call `media_to_chat_cancel` before Send starts: existing files and text remain in Composer. A later edit, missing guard after page reload, navigation or closure stops sending rather than switching tabs. A second submission to a Composer reserved by another working task is refused; cancel or finish that task first.

If a task fails at attachment verification after its pause, the Extension console includes `expectedNames`, `cardNames`, `selectedNames` and `previewCount`. The host may insert a `(YYYYMMDD-HHMMSS)` suffix when upload finishes; ResearchTube recognizes that specific insertion while preserving the original stem, extension, count and user-edit protection. Other mismatches still refuse Send.

## Automatic delivery after creating artifacts

Use the creation tool's taskId with media_task_status. If creation completed and chat failed, inspect chat.error/skippedFiles and the overall error; created files remain in files. Do not start a duplicate creation merely to retry delivery: select those existing logical paths explicitly with media_to_chat after diagnosing the cause. Missing/duplicate/closed originating tabs are never replaced with the active tab. Count overflow refuses the complete upload; oversized files are skipped according to mediaToChat limits. During waitingToSend, cancellation preserves the attached files. Send can remain disabled while ChatGPT responds; finish the assistant response after any necessary pre-Send checks. Refresh MCP descriptors when moving from the old path/result contracts; current creation fields are under creation.data, not at the task root.

## Study this site / Browser Agent

- Start from an ordinary HTTP/HTTPS page. Chrome internal pages and protected debugger targets cannot be studied. The popup creates a copy and a separate ChatGPT conversation; it does not use whichever chat later becomes active.
- Refresh the ResearchTube MCP schema if `browser_observe` or other Browser Agent tools are absent, and check their Browser Agent group in Settings.
- `PAGE_CHANGED`: observe the current page again and use its new node/resource IDs. `STALE_NODE`: the element changed; expand/observe again rather than retrying a blind click.
- Startup remains at conversation confirmation while ChatGPT saves its temporary `local-chatgpt:` conversation. The worker console reports `waiting for saved conversation` once, then `conversation confirmed` with the saved path. `BROWSER_CHAT_NOT_FOUND` after the bounded wait means saving was not confirmed; the prompt and tabs remain. Start a fresh Study this site session after resolving the connection issue.
- If `BROWSER_CHAT_CHANGED` appears immediately after the study prompt was sent, inspect the `[ResearchTube Browser] conversation mismatch` console entry: it records the expected and live chat paths and whether a tool or URL event initiated the check. Old URL-event snapshots are ignored only when the actual bound tab still shows the expected conversation.
- `TAB_CLOSED` means normal session completion, with stopped state and no error. `BROWSER_CHAT_CHANGED` or unexpected `DEBUGGER_DETACHED` fails the session. Start Study this site again when ready; no alternative tab will be selected.
- `BROWSER_SESSION_PAUSED`: Ask ChatGPT to call browser_session_resume. Reading the page while paused is permitted; mutations are blocked.
- Resource tasks preserve a saved Workspace path after delivery failure. A user draft or an unresolved attachment-count mismatch blocks Send; no draft is cleared automatically. Cancel leaves the current Composer unchanged.
- Oversized browser resources use the existing `limits.mediaToChatMaxFileSizeMiB` threshold. Authentication/CORS/cache limitations can produce an explicitly labeled image screenshot fallback. Original audio/video/document bytes must be obtainable; images alone have screenshot fallbacks.
- If both tabs open but no prompt arrives, inspect the Extension service-worker console for the startup stage/error. The icon shows AUTO while controlled and ERR after failure; the source page is not covered by controls. Heavy pages do not need all resources to finish downloading. A missing document/Composer times out after two minutes per wait. Stop works while starting.
- Console entries use `[ResearchTube Browser]` and contain startup stages, the failed stage and specific error, plus short resource progress/session reasons. They do not dump page HTML, credentials or response bytes.

For tab grouping, edit `browserStudyGroupTabs.value` in `agent-config.json` (`true` by default). The next study launch reads it. The two new tabs share a short blue RT group; the source tab is unaffected. Collapse/expand the group by clicking its title. Closing either study tab is normal completion and leaves the other tab and group intact.

### Slow Study this site

Enable `browserStudyDetailedLogging.value` in `agent-config.json` (currently shipped as `true`) and start a new study session. In the Extension service-worker console collect `[ResearchTube Browser] timing` records through the slow operation. All service-worker action lines start with a visible ISO UTC timestamp; timing records and ordinary details are serialized text and survive DevTools Save as without expansion. An older export containing only `timing Object` lacks all measurements and cannot be used to calculate durations; repeat the short study after updating the Extension. AX refresh, DOM enrichment, resource extraction/save, automation queue and enabled-Send waits are measured separately; `tool.gap` is outside page-tool execution and includes client/model/tunnel/user waiting. Set the value to `false` and start a new session to disable these extra records. Existing compact console diagnostics remain. See [Browser Agent timing diagnostics](features/BROWSER_AGENT.md#optional-timing-diagnostics) for fields and interpretation.

## Background Composer upload or Send confirmation times out

`composerMediaRetryCount.value` (default 15) and `composerMediaRetryIntervalSeconds.value` (default 2) in the single Agent configuration control shared media/file acceptance, enabled-Send readiness and post-click acknowledgement. Each stage checks immediately and then repeats up to the configured count: normally about 30 seconds plus request latency. Increasing these values can accommodate slow background tabs. Active ChatGPT generation still has its separate bounded response wait. The Extension emulates focus/lifecycle during the exact bound-tab operation without activating a different tab.

Collect timestamped `[ResearchTube CDP] Composer media condition pending/confirmed` lines and task status. Success stops checks immediately. Cancellation or user edits before Send stop the operation and preserve the Composer. An enabled Send is retried while the same guarded payload remains unacknowledged, up to the configured budget. Files are never reattached; disabled Send is not clicked. A late UI acknowledgement ends attempts immediately. Inspect the chat before manually restarting an unconfirmed timed-out task.

## Startup logs a Send click but stays at confirmingChat

A successful `Input.dispatchMouseEvent` response proves only that Chrome accepted the input command, not that the background page submitted its Composer. Startup prompts and file delivery now prefer the Composer's own `form.requestSubmit()` path, already used for Describe this video. Only an enabled button belonging to the same form is submitted. For an unacknowledged enabled Send, retries alternate the form and trusted pointer paths; no-form layouts use pointer input. Both are bounded by the same Agent retry settings.

Collect the timestamped `ChatGPT Composer form submission dispatched`, `ChatGPT Send pointer target`, `ChatGPT Send not yet confirmed` and subsequent startup/task lines. The form log means a dispatch, not completion. Startup must still reach the saved conversation URL; media must show a new user turn or cleared Composer. Missing Send during a changing response UI retains the prior bounded response wait without requiring a particular Stop label. Existing drafts/files are preserved on timeout.


## Study requests several images

Pass `resourceIds` from the latest observation instead of making separate tasks. Actual image bytes are saved under `study-this-site/`, then attached as one batch to the bound study conversation. Inspect the ordered task `files` and `submittedFiles`. A partial extraction/save failure does not upload a partial batch; earlier saved files remain. End the assistant response so ChatGPT can enable Send: the worker continues independently. Saving files locally does not override an OpenAI safety rejection or unsupported-upload restriction.

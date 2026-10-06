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

Call `system_agent_status` and inspect the named component.

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

Expected bridge startup logs show the Extension version, origin, whether the frame is top-level, and whether a capture root was found. Repeated `origin=null` iframe lines alone do not prove failure. The useful failure is the first ResearchTube message after the widget announces itself or Refresh is pressed.

`Copy workspace path` must copy only a logical path such as `captures/frame.png`. If it copies a physical path, stop and report a privacy-contract defect.

## Google Translate TTS

For `GOOGLE_TRANSLATE_UNAVAILABLE`, verify normal network access to Google Translate and that Chrome permits the Extension's debugger permission. ResearchTube should retain an inactive Translate tab, clear previous source text, insert and verify new text, wait for the enabled source listen control, and click `aria-label="Listen to source text"` through CDP browser input.

For file output, the MP3 response is collected through CDP network events; ResearchTube does not use `chrome.tabCapture`. File-only mode temporarily mutes the tab and restores its previous state only after playback/audio collection completes.

Do not close the Translate tab as a standard troubleshooting step; reuse is intentional.

## Clipboard, screen and camera

- Clipboard operations are Windows-only and must be explicit. `CLIPBOARD_CHANGED` means the clipboard changed between status and read; request status again.
- Screen capture requires FFmpeg and OS permission. Linux Wayland is unsupported by the current implementation.
- Camera availability depends on FFmpeg's native device backend and user-granted OS permissions. Use `camera_list` before capture/recording.
- A busy camera or active recording must be stopped/finalized before starting an incompatible operation.

## Files sent to the current chat

- Invoke `media_to_chat` with the intended ChatGPT conversation active in the last focused Chrome window. It requires an existing conversation URL and creates no new tab.
- The default `composerPolicy: "requireEmpty"` refuses both text and existing attachments. Choose `"clear"` explicitly to discard them once before uploading; a failed or unavailable removal control stops preparation.
- New text or user attachment changes after preparation stop Send under either policy. Uploaded files remain attached; inspect the Composer before retrying. Editing and then deleting text also stops the task.
- Finish the assistant response after starting the task. `submitting` may wait for Send while ChatGPT is responding; request status in a later turn.
- Do not navigate the destination tab to another conversation during a task. Switching away to another tab does not change the captured destination.
- A count-limit rejection names the configured maximum. Check `mediaToChatMaxFiles` in `agent/agent-config.json`; Library uses a separate setting.
- `skippedFiles` reports oversized files and the applicable size threshold. If every file is skipped, no chooser opens. Check `mediaToChatMaxFileSizeMiB` and ChatGPT's own upload restrictions.
- A completed task confirms the Send click. For failures or an Extension restart, inspect the chat before retrying to avoid duplicate uploads; do not delete Workspace source files.

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

The new-tool default is a developer parameter in `agent-config.json`, `newToolsEnabledByDefault`. It is no longer a Settings checkbox. Saved individual tool choices remain unchanged; new tools use this default when first registered. Config explanations live in each setting's `comment`; edit its adjacent `value`. `limits` remains a group containing these setting objects. The shipped config replaces the older flat format.

## Timer tools missing from the MCP catalogue

The public tool names are `timer_start`, `timer_status`, and `timer_cancel`. Check their individual switches in Extension Settings, in the Timers group. A developer default of false can leave newly registered tools disabled; later changing the default does not overwrite saved individual choices.

When the client refreshes the MCP schema, the Extension console prints `[ResearchTube MCP] tools/list` with its serving release version, public tool count, enabled timer names and disabled timer names. If this line reports the three timer names, the serving Extension included them in its actual MCP response; verify that ChatGPT refreshed the intended ResearchTube connection. If the release is unexpected, check which Extension directory is loaded. Updating only the Agent does not change the MCP catalogue, because the Extension serves it.

Schema discovery remains available when the Agent or its developer configuration cannot be read. The cached new-tool default (initially true) is used and the console reports the configuration issue. Actual Agent-backed operations still validate health, compatibility and configuration.

# MCP tool reference

This is a behavioral index, not a duplicate of the JSON Schemas. Exact schemas and defaults are authoritative in `extension/background.js` and `extension/storyboards.js`.

## Artifact tasks and paths

Every artifact producer accepts `addToChat` (false by default), `composerPolicy` (`requireEmpty` by default) and `sendDelaySeconds` (zero by default). Captures, cropping and clipboard reads are asynchronous as well. One task covers creation plus optional upload/Send in the originating chat. Use `media_task_status` and `media_task_cancel`; specialized status/cancel commands return the same complete workflow. `files[].workspacePath` selects created outputs uniformly; native results and counters are in `creation.data`, upload and delay information in `chat`. See [Artifact tasks](features/ARTIFACT_TASKS.md) for limits, cancellation and restart behavior.

| Tool | Behavior |
| --- | --- |
| `media_task_status` | Checks any artifact task: creation, produced paths, optional chat upload/Send, delay, errors and progress. |
| `media_task_cancel` | Cancels creation or pending delivery, preserving published files and Composer contents; cannot undo committed Send. |

Public source/selection arguments use `workspacePath`. Destination files use `outputWorkspacePath`, output folders `outputWorkspaceDirectory`; move uses `destinationWorkspacePath`. Sharing distinguishes `workspacePath`, `workspaceDirectory` and `probeWorkspacePath`. Older public argument names are rejected; Agent-only names and private viewer actions are unchanged.

## Timers

LLMs have no precise internal running clock. These tools provide real elapsed-time checks for pauses, test preparation and calendar deadlines. See [timer behavior](features/TIMERS.md).

| Tool | Purpose |
| --- | --- |
| `timer_start` | Start an independent duration or absolute-deadline task using system or internet time; returns immediately. |
| `timer_status` | Read real remaining time, UTC/local timestamps, progress, synchronization details and warnings. |
| `timer_cancel` | Stop active countdown and retain its terminal status. |

Timers live only in Agent memory. They do not wake a finished chat. Old terminal records may be evicted under `limits.completedTaskHistoryLimit`.

## Common behavior

- Public tool availability is configurable by exact name in ResearchTube Settings.
- `system_agent_status` is always enabled so compatibility can be diagnosed.
- Agent-backed tools require a running compatible Agent.
- Workspace paths are logical `/`-separated paths, never physical paths.
- Creation tools do not overwrite existing files silently.
- Long operations return a task ID. Poll the matching status tool no faster than `pollIntervalMs`.
- Local media is shown only through an explicit `media_show` call unless a tool description states otherwise.

## System

| Tool | Behavior |
| --- | --- |
| `system_agent_status` | Reports Extension and Agent versions and interface compatibility, plus the saved startup OS, Workspace/free-space, component and Chrome automation diagnostics. Pending background checks report `checking`; status calls never rerun them. Restart the Agent to refresh the snapshot. |

## Text to Speech

| Tool | Behavior |
| --- | --- |
| `system_speech_list_voices` | Lists opaque Windows speech voice IDs and public names. Windows only. |
| `system_speech_speak` | Starts Google Translate or Windows speech with exactly one output mode: speakers, file or both. Google Translate is the default engine. |
| `system_speech_status` | Returns speech phase, percentage, selected engine/voice and saved file metadata when applicable. |
| `system_speech_cancel` | Stops a working speech task and releases playback/network resources. The retained Google Translate tab is not closed. |

## Workspace

| Tool | Behavior |
| --- | --- |
| `workspace_list` | Lists one Workspace directory with optional extension filtering and a bounded result count. |
| `workspace_stat` | Returns type, size and modification time for one existing logical path. |
| `workspace_mkdir` | Creates a logical directory and missing parents. |
| `workspace_move` | Moves or renames a Workspace object without overwriting the destination. |
| `workspace_delete` | Deletes one regular file or one empty directory; no recursive mode exists. |

## Media and images

| Tool | Behavior |
| --- | --- |
| `media_probe` | Returns selected ffprobe format, stream, chapter and program metadata without the physical filename. |
| `media_clip` | Starts one task that creates separate video or audio files for up to `limits.mediaClipMaxSegments` ordered intervals, or processes the whole source when intervals are omitted. |
| `media_clip_get_task` | Returns the complete workflow with native FFmpeg progress and clips in creation.data. |
| `media_clip_cancel_task` | Cancels clipping and preserves clips already published. |
| `media_capture_frame` | Starts extraction of frames from a Workspace video or selected YouTube format/ranges, up to `limits.mediaCaptureFrameMaxFrames`. |
| `media_capture_frame_get_task` | Returns the complete workflow with extraction progress/frames in creation.data and created paths in files. |
| `media_capture_frame_task_diagnostics` | Returns bounded sanitized diagnostics for failed YouTube frame extraction. |
| `media_capture_frame_cancel_task` | Cancels frame extraction and preserves completed frames. |
| `media_capture_screen` | Captures the complete virtual desktop or an explicit global `x`, `y`, `width`, `height` region. |
| `media_image_crop` | Writes a rectangular crop from an existing PNG, JPEG or WebP source. |
| `media_show` | Displays image, video or audio through the Extension-owned viewer; native audio/video playback and seeking stream through byte ranges. It does not upload attachments or autoplay. |
| `media_to_chat` | Queues selected Workspace files of any type for upload and Send in the ChatGPT conversation that invoked the tool. Uses independent configured count and per-file size limits. |
| `media_to_chat_status` | Reports phase, approximate percentage, submitted files and oversized skipped files. Polling is allowed in the initiating turn; actual Send may require finishing the response. |
| `media_to_chat_cancel` | Cancels queued or working delivery before Send commits, including waitingToSend; leaves Composer contents untouched. |
| `media_image_inspect` | Verifies image format, dimensions and byte size without returning image bytes. |

`media_load_workspace_image` and `media_copy_workspace_path` are private widget actions. They are not normal public tools and do not appear in Settings.

## Visual Maps

| Tool | Behavior |
| --- | --- |
| `visual_map_create` | Starts PNG contact-sheet creation using uniform, scene-detect or hybrid frame selection and optional corner timestamps. Omit sceneDetectThreshold for uniform; sceneDetect/hybrid default to 10. |
| `visual_map_get_task` | Returns the complete workflow with frame/map counts and native result.maps in creation.data. |
| `visual_map_cancel_task` | Cancels a working visual-map task. |

## Camera

| Tool | Behavior |
| --- | --- |
| `camera_list` | Lists opaque camera handles and supported public capture modes without native device paths. |
| `camera_capture_frame` | Captures one image from a selected camera. |
| `camera_record_video` | Starts video recording with optional camera audio; duration is limited by `limits.cameraRecordVideoMaxMinutes`. |
| `camera_record_audio` | Starts audio-only recording from a camera microphone; duration is limited by `limits.cameraRecordAudioMaxMinutes`. |
| `camera_record_status` | Returns the complete artifact workflow; native recording/stopping state and metadata are in creation.data. |
| `camera_record_stop` | Requests graceful stop and finalization of a working recording. |

## YouTube Storyboards

| Tool | Behavior |
| --- | --- |
| `youtube_storyboard_get_info` | Discovers ready-made storyboard variants, geometry, interval and sheet count without downloading sheets. |
| `youtube_storyboard_download` | Starts download of all sheets, an inclusive time range or explicit indexes; optional timestamps are drawn into a selected corner. |
| `youtube_storyboard_get_task` | Returns the complete workflow with native progress/tile timestamps and publishedSheets in creation.data; created paths are in files. |
| `youtube_storyboard_cancel_task` | Stops queued/current transfers while retaining complete sheets. |

## YouTube research

| Tool | Behavior |
| --- | --- |
| `youtube_search` | Searches public YouTube with local pacing, caching and verification backoff. |
| `youtube_get_video` | Returns public video metadata, engagement counts, tags, description and caption-track choices. |
| `youtube_get_channel_videos` | Lists public channel videos with optional Shorts/stream filtering and continuation. |
| `youtube_get_channel_playlists` | Lists public playlists displayed by a channel. |
| `youtube_get_playlist_videos` | Lists the ordered public catalogue of one playlist. |
| `youtube_get_transcript` | Returns timestamped text from a selected public caption track. |
| `youtube_get_comments` | Returns bounded public top-level comment threads sorted by top or newest. |
| `youtube_get_comment_replies` | Returns a selected parent comment and bounded replies. |

## Downloads

| Tool | Behavior |
| --- | --- |
| `youtube_download_get_formats` | Takes a current yt-dlp format snapshot with numeric selectable IDs. |
| `youtube_download` | Starts complete or partial public YouTube download using explicit combined/video/audio selection. |
| `youtube_download_get_task` | Returns task phase, percentage, output files and public download metadata. |
| `youtube_download_task_diagnostics` | Returns bounded sanitized diagnostics for a failed download. |
| `youtube_download_cancel_task` | Cancels an active or queued download task. |

## Clipboard

| Tool | Behavior |
| --- | --- |
| `clipboard_status` | Reports Windows clipboard revision/type availability without reading content. |
| `clipboard_get` | Reads Unicode text or saves a validated clipboard image as a Workspace PNG. |
| `clipboard_set` | Places explicit text or a decoded Workspace image on the Windows clipboard. |

## Library and sharing

| Tool | Behavior |
| --- | --- |
| `library_store_start` | Queues any Workspace files, up to `limits.libraryStoreMaxFiles`, for attachment and submission in a dedicated background ChatGPT service tab. |
| `library_store_status` | Reports submitted files and size-rejected files (with actual size and configured maximum). It does not claim later Library availability. |
| `library_store_cancel` | Cancels a Library task only while it is still queued. |
| `online_share_start` | Explicitly starts one temporary cloudflared folder or exact-file share with optional independent image reachability verification. |
| `online_share_status` | Reports current share state and can repeat the configured external probe. |
| `online_share_stop` | Stops the active public share without deleting Workspace files. |

## Files in the current chat

`media_to_chat` accepts `files: [{"workspacePath": "reports/notes.txt"}]`. New tasks use the standard `tsk_` plus ten URL-safe-character identifier. Its compact service widget binds the task to the originating Chrome tab before any Composer changes. The tab ID and conversation stay fixed across tab/window switches; focus is never used to select a destination and no service tab is opened. If the widget cannot identify the tab within 30 seconds, the task fails with `MEDIA_TO_CHAT_TARGET_NOT_FOUND`. Closed tabs produce the same code; a changed conversation produces `MEDIA_TO_CHAT_TARGET_CHANGED`. If the originating conversation is open in multiple tabs, `MEDIA_TO_CHAT_TARGET_AMBIGUOUS` refuses to guess. Errors are reported in task status; no alternate tab is selected. The widget shows “ResearchTube · Adding files to chat…” in a 32px row, requests no border and declares only the inline display mode. Its final height is controlled by ChatGPT. It displays no media or controls and does not replace file attachment or visual input; use task status to confirm Send. `composerPolicy` defaults to `"requireEmpty"`: text or existing attachments stop the task without changing them. `"clear"` explicitly clears the text and removes the initial attached files through their Composer removal controls, verifies emptiness, then uploads the selected files. Removal recognizes `Remove <filename>` controls in the Composer attachment area for images and other files, invokes labelled React removal controls even when hover-only CSS hides them, and confirms that each card disappeared before continuing. Inspection, text clearing, file acceptance and Send share the same visible draft editor; hidden legacy textareas are ignored. Attachment wrappers and their nested previews count as one card, and exact filenames are checked even after ChatGPT resets the native file input. It never clears again once upload starts. If removal cannot be verified, no new files are uploaded or sent.

Before Send and while waiting for it, ResearchTube checks for text, attachment changes, user editing and a changed conversation. If the user types text (even if it is subsequently deleted), adds/removes files, or changes the destination, Send is not clicked. The uploaded task files and any user text remain in the Composer. Removal from the Composer does not delete source Workspace files. Task status includes the chosen `composerPolicy`.

`sendDelaySeconds` is optional and defaults to `0`. A positive value starts a pause after all eligible attachments are confirmed in Composer; it does not replace upload/readiness checks. `600` waits ten minutes. During `waitingToSend`, task status returns the configured delay, `sendNotBefore` in UTC, and dynamically calculated `remainingSeconds`; the countdown is null outside that phase. The Extension detaches CDP during the pause so other tabs and Library automation remain available. Another file-submission task cannot clear or replace the reserved Composer while Send is pending. At the deadline, the task rechecks the exact tab/conversation, original page-side edit guard, empty text and matching attachment names before waiting for an enabled Send. User edits, missing attachments, a changed conversation or a closed tab stop Send and preserve the current Composer. An alarm wakes a suspended worker; normal Chrome scheduling can make Send later than the requested deadline, never deliberately earlier.

Attachment verification accepts exact filenames and the observed host insertion of `(YYYYMMDD-HHMMSS)` immediately before a file extension. The original stem/extension and number of files must still match, and the user-edit guard remains active. This handles cards renamed after upload during `waitingToSend`, without accepting arbitrary renames or different attachments. Native file selections require exact names.

`media_to_chat_cancel` accepts queued and working tasks before the Send click starts, including the pause and the wait for Send readiness. It stops subsequent automation without clearing text, removing attached files, deleting Workspace files or undoing an earlier explicit preparation. Cancellation takes effect before awaited cleanup. Once the trusted Send sequence begins, or the task is terminal, it returns `cancelled: false`.

Status polling and cancellation are allowed in the initiating assistant turn; respect `pollIntervalMs`. A positive delay permits inspecting `waitingToSend` and cancelling before `sendNotBefore`. ChatGPT may keep Send disabled while the assistant is responding: for actual submission, finish the response after any pre-Send checks rather than indefinitely waiting for completion. The automatically sent attachment message can trigger a following turn to check `media_to_chat_status`; a timer does not resume an ended response. Approximate percentages represent processing phases and are also logged by the Agent. `completed` confirms that Send was clicked, not that ChatGPT finished processing every upload.

`limits.mediaToChatMaxFiles` defaults to 5 and `limits.mediaToChatMaxFileSizeMiB` to 20 in `agent/agent-config.json`. Library has its own independent keys. Count limits accept 1–100 and file size 1–512 MiB. Exceeding the count rejects the whole request as an ordinary structured result (`isError: false`) with the configured maximum. Oversized files appear in `skippedFiles`, including actual and maximum byte sizes; eligible files are sent together. If all files are oversized, the task fails without opening a chooser. ChatGPT's own file-type and upload limits still apply.

The original Workspace files are unchanged. A restarted Extension worker marks queued and interrupted submissions as failed and does not automatically resend it. Check the chat before retrying to avoid duplicate attachments.

## Platform limits

- Clipboard tools are Windows-only.
- Screen capture uses gdigrab on Windows, X11 on Linux and AVFoundation on macOS; Linux Wayland is not supported.
- Camera support depends on FFmpeg device availability and OS permissions.
- Windows speech voices are Windows-only; Google Translate speech uses a browser tab and network availability.
- YouTube can remove captions/comments/storyboards, restrict a video, require verification or change public page formats.

## Browser Agent

Start **Study this site** from the Extension popup. The two new tabs are grouped by default (`browserStudyGroupTabs` in Agent configuration); the source tab remains outside the new group. Closing either new tab ends the session normally, with `state: stopped`, `error: null` and `stopReason: TAB_CLOSED`. The popup has no session controls. The new dedicated chat receives its `sessionId` (`bas_` plus ten random URL-safe characters); every browser call requires it. Startup binds the saved conversation address, after ChatGPT replaces its temporary local address. AX/DOM data describes the page; only real attachments provide model visual input. See [Browser Agent](features/BROWSER_AGENT.md) for sessions, frame handling, limits and resource fallbacks.

| Tool | Purpose |
| --- | --- |
| `browser_observe` | Live, bounded AX outline/subtree/full observation with node IDs and preserved hierarchy. |
| `browser_get_children` | Expand a selected node's current children with depth and pagination. |
| `browser_get_node` | Inspect AX details, safe DOM attributes/geometry and resource references. |
| `browser_get_text` | Read deferred AX subtree text with offset/limit. |
| `browser_act` | Click, hover, replace editable text, key, scroll or select in the exact agent tab. |
| `browser_get_resource` | Asynchronously extract one `resourceId` or an ordered `resourceIds` batch, save files in `study-this-site/` and by default attach/send the entire batch in the dedicated chat. `addToChat:false` saves only. |
| `browser_resource_status` | Read extraction, save and delivery progress plus confirmed outputs. |
| `browser_resource_cancel` | Cancel before Send commits without deleting files or Composer attachments. |
| `browser_session_status` | Read session state and safe current page metadata. |
| `browser_session_pause` | Block new mutations/delivery, retaining live observation. |
| `browser_session_resume` | Refresh and resume a paused session. |
| `browser_session_stop` | Stop work, release debugger and clear the automation indicator; tabs remain open. |

Browser resource tasks use their own status/cancel pair rather than `media_task_status`. They are created from a browser resource reference, not a Workspace source path. Source URLs and browser handles are private. Browser tasks/session state are Extension-memory records; they are not resumed after a restart.

Shared Composer file delivery uses `composerMediaRetryCount.value` (15) and `composerMediaRetryIntervalSeconds.value` (2) in Agent configuration: one immediate check plus up to 15 repeats at two-second intervals. These apply to `media_to_chat`, artifact `addToChat`, Browser Agent resources, startup prompts and Library transfers. Active ChatGPT generation retains its separate bounded wait. After files are accepted, an enabled Send may be dispatched repeatedly while the original guarded payload remains and submission has not been acknowledged. Attempts alternate the owning form's `requestSubmit` and trusted CDP pointer input; without a usable form they use pointer input. A new user turn, started response, saved startup conversation or empty Composer confirms submission and ends attempts immediately. Disabled Send is never clicked. Files are supplied once, never reattached during Send retries. An unconfirmed timeout preserves the Composer and saved files. See [Composer delivery retries](features/BROWSER_AGENT.md#composer-delivery-retries).

The Extension continues scheduled extraction and delivery after the tool returns and the assistant response ends. Ending the response lets ChatGPT enable Send; it does not stop the background task. Browser resource tasks expose ordered `resourceIds` and `files` in status; singular `workspacePath`, `mimeType` and `extraction` remain available for one resource and are null for multiple resources. The batch count uses `limits.mediaToChatMaxFiles` (5 by default). If extraction/save fails partway, already saved paths remain in `files`; no partial batch is automatically sent.

Study this site and Describe this video explicitly clear restored text and attachments in their own newly created ChatGPT tab before inserting the initial prompt. Existing user conversations are not cleared by these shortcuts. Later user edits still stop further submission.

# Artifact creation and automatic chat delivery

All twelve artifact-producing tools return an asynchronous task immediately:

| Tool | Created artifacts |
| --- | --- |
| `youtube_download` | Downloaded video or audio |
| `youtube_storyboard_download` | Published JPEG sheets |
| `media_capture_frame` | Extracted frames |
| `visual_map_create` | PNG visual maps |
| `media_clip` | Separate video/audio clips, in requested order |
| `camera_record_video` | Finalized MP4 recording |
| `camera_record_audio` | Finalized M4A recording |
| `system_speech_speak` | MP3 or WAV when outputMode is file or both |
| `media_capture_screen` | Desktop/region image |
| `media_image_crop` | Cropped image |
| `camera_capture_frame` | Camera image |
| `clipboard_get` | Saved PNG when the clipboard contains an image |

The last four tools now use the same public task lifecycle as the others, even with default options. Text read by `clipboard_get` is returned in `creation.data`; it does not become a file. Speech with speakers-only output also creates no file.

## Common options

- `addToChat` defaults to false: create Workspace outputs only. True requests uploading and sending every completed output in the originating conversation after successful creation.
- `composerPolicy` defaults to `requireEmpty`. With delivery enabled, `clear` explicitly discards initial text and attachments once, before uploading. Later edits stop Send and leave attachments in place.
- `sendDelaySeconds` defaults to zero. Positive values pause after the files are accepted in Composer. Readiness is still checked separately. The current-chat task reports `sendNotBefore` in UTC and `remainingSeconds` during `waitingToSend`.

`addToChat` supplies actual file attachments to ChatGPT. `media_show` displays a local viewer and does not supply visual input. Do not call `media_to_chat` again for outputs whose creation task already requested delivery.

For speech, `addToChat` requires `outputMode: file` or `both`; speakers-only is rejected before starting work. Clipboard text may complete locally with the default flag; with `addToChat: true`, creation completes but delivery fails with `MEDIA_ARTIFACT_NO_FILES`. Text is never submitted implicitly.

## One task, two stages

Use the unchanged `taskId` with `media_task_status` and `media_task_cancel`. Existing download, storyboard, capture-frame, clip, visual-map, speech and camera status tools are aliases for the same complete workflow, restricted to their producer type. Existing cancellation tools cancel that entire workflow, not just its creation stage. Native diagnostic tools translate the public ID to their internal creation ID.

Task documents expose:

- `status`, `phase` and monotonic `progressPercent` for the entire requested workflow;
- `statusTool`, `cancelTool` and `pollIntervalMs` for predictable follow-up;
- `files`, containing only safely published output paths, in producer order;
- `creation.status`, `creation.progressPercent` and `creation.data`, preserving the normalized native task/results (stream choices, timestamps, dimensions, voice, counts and error context);
- `chat`, null when delivery was not requested, otherwise the current-chat stage including submitted/skipped files and delay metadata;
- `error`, the overall failure, without discarding successful creation results.

Native fields such as `clips`, `frames`, `result.maps` or `result.filePath` now live inside `creation.data`. Prefer `files[].workspacePath` to select outputs uniformly. Storyboards expose `creation.data.publishedSheets` with verified sheet indexes and logical paths, including reused and partially completed batches. Directory scans never select files for delivery.

With delivery disabled, completed creation completes the overall task. With delivery enabled, `creation.status: completed` is not sufficient: upload, delay and Send may still be running or may fail. Overall `completed` confirms a Send click, not downstream ChatGPT processing. Failed/cancelled creation never automatically uploads its partial outputs; reported published outputs remain in `files` for explicit later use; producer results determine whether partial paths can be enumerated.

## Originating tab and automation

Creation tools use the same compact inline service widget as `media_to_chat`, not the media viewer. With delivery enabled its private handshake binds an exact Chrome tab and conversation at launch, before potentially long processing. No focused/active-tab fallback exists. A missing handshake, duplicated conversation, closed tab or changed conversation prevents delivery. The widget does not hold a Composer lock or change the draft during creation. The bound chat reservation holds no placeholder file.

The host may reuse a service-widget iframe for successive tool results. Each distinct task starts a fresh binding window, including after a creation-only task, a completed handshake or a timeout. Older result metadata and acknowledgments cannot replace the current task. Canonical tool-result notifications take precedence over compatibility globals; completed handshakes stop their retry timer.

For `visual_map_create`, `sceneDetectThreshold` is optional for scene-detect/hybrid selection and is omitted for uniform selection. Uniform result metadata reports it as null; that result-only null is not copied into the subsequently validated task input.

The Extension advances creation and delivery independently of LLM polling through short timers and Chrome alarms. Native creation polling respects its returned interval. Public status is bounded by at least one second. Progress is approximate for the overall workflow; the native percentage remains in `creation.data`. Compact percentage-only updates are also reported to the Agent log.

ChatGPT can keep Send disabled during the current assistant response. After any required pre-Send checks, finish that response; the Extension will continue. Neither polling nor a timer independently wakes an ended LLM turn.

## Limits and cancellation

Automatic delivery uses the existing `limits.mediaToChatMaxFiles` and `limits.mediaToChatMaxFileSizeMiB`. Too many produced files refuses the entire upload and reports the configured maximum; it never silently sends a subset. Oversized files are recorded in `chat.skippedFiles`, eligible files are sent together, and an all-oversized batch fails without uploading. Files are never deleted or overwritten to satisfy limits.

Cancellation prevents later upload/Send, stops native asynchronous work where supported, and preserves published files plus all Composer text/attachments. A running single capture, crop or clipboard request cannot be interrupted through its existing Agent endpoint: it settles, its result is retained, and delivery is suppressed. Status can remain `working / cancelling` until creation settles. Once Send commits, cancellation returns false and cannot undo it.

`camera_record_stop` remains a graceful early stop: finalization can still be followed by requested chat delivery. Use `media_task_cancel` to stop recording and suppress delivery.

The Extension persists bounded supervisor metadata. Suspension resumes known native creation/status and guarded pre-Send delay stages without replaying work. An interrupted unacknowledged start or single Agent operation fails meaningfully; it is never rerun automatically. Interrupted uploads remain governed by `media_to_chat`'s no-resend contract. Agent restart or task-history eviction can lose native handles; completed files remain in Workspace. Terminal histories use `limits.completedTaskHistoryLimit`.

## Workspace arguments

Public tools use `workspacePath` for the existing source/selected file (also a selected directory in Workspace operations). Optional destinations use `outputWorkspacePath`; batch output folders use `outputWorkspaceDirectory`. Move uses `workspacePath` and `destinationWorkspacePath`. Sharing distinguishes `workspacePath` (one file), `workspaceDirectory` (folder) and `probeWorkspacePath` (probe image).

Old public names such as `path`, `targetPath`, `outputPath`, `outputDir`, `source`, `destination`, `file` and `folder` are rejected with the canonical replacement. Private Agent requests retain their independently validated native names; this is an MCP-boundary translation, not permission to use host paths. Private viewer actions retain their existing contract so the working media viewer is unaffected.

Sources: `extension/artifact-tasks.js`, `extension/artifact-tools.js`, `extension/background.js`, and the native producer modules.

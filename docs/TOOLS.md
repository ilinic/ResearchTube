# MCP tool reference

This is a behavioral index, not a duplicate of the JSON Schemas. Exact schemas and defaults are authoritative in `extension/background.js` and `extension/storyboards.js`.

## Common behavior

- Public tool availability is configurable by exact name in ResearchTube Settings.
- `system_agent_status` is always enabled so compatibility can be diagnosed.
- Agent-backed tools require a running compatible Agent.
- Workspace paths are logical `/`-separated paths, never physical paths.
- Creation tools do not overwrite existing files silently.
- Long operations return a task ID. Poll the matching status tool no faster than `pollIntervalMs`.
- Local media is shown only through an explicit `media_image_show` call unless a tool description states otherwise.

## System

| Tool | Behavior |
| --- | --- |
| `system_agent_status` | Reports Extension and Agent implementation versions, interface compatibility, public OS metadata, Workspace health and local component availability. |

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
| `media_clip` | Starts one task that creates separate video or audio files for up to 20 ordered intervals, or processes the whole source when intervals are omitted. |
| `media_clip_get_task` | Returns real FFmpeg-derived progress and completed clip metadata. |
| `media_clip_cancel_task` | Cancels clipping and preserves clips already published. |
| `media_capture_frame` | Starts extraction of 1–20 frames from a Workspace video or selected YouTube format/ranges. |
| `media_capture_frame_get_task` | Returns extraction/download progress and completed frame paths. |
| `media_capture_frame_task_diagnostics` | Returns bounded sanitized diagnostics for failed YouTube frame extraction. |
| `media_capture_frame_cancel_task` | Cancels frame extraction and preserves completed frames. |
| `media_capture_screen` | Captures the complete virtual desktop or an explicit global `x`, `y`, `width`, `height` region. |
| `media_image_crop` | Writes a rectangular crop from an existing PNG, JPEG or WebP source. |
| `media_image_show` | Creates the conversation anchor used by the Extension-owned viewer for image, video or audio. |
| `media_image_inspect` | Verifies image format, dimensions and byte size without returning image bytes. |

`media_load_workspace_image` and `media_copy_workspace_path` are private widget actions. They are not normal public tools and do not appear in Settings.

## Visual Maps

| Tool | Behavior |
| --- | --- |
| `visual_map_create` | Starts PNG contact-sheet creation using uniform, scene-detect or hybrid frame selection and optional corner timestamps. |
| `visual_map_get_task` | Returns phase, percentage, frame/map counts and final Workspace map paths. |
| `visual_map_cancel_task` | Cancels a working visual-map task. |

## Camera

| Tool | Behavior |
| --- | --- |
| `camera_list` | Lists opaque camera handles and supported public capture modes without native device paths. |
| `camera_capture_frame` | Captures one image from a selected camera. |
| `camera_record_video` | Starts bounded video recording with optional camera audio. |
| `camera_record_audio` | Starts bounded audio-only recording from a camera microphone. |
| `camera_record_status` | Returns recording or stopping state, progress and output metadata. |
| `camera_record_stop` | Requests graceful stop and finalization of a working recording. |

## YouTube Storyboards

| Tool | Behavior |
| --- | --- |
| `youtube_storyboard_get_info` | Discovers ready-made storyboard variants, geometry, interval and sheet count without downloading sheets. |
| `youtube_storyboard_download` | Starts download of all sheets, an inclusive time range or explicit indexes; optional timestamps are drawn into a selected corner. |
| `youtube_storyboard_get_task` | Returns monotonic sheet progress, calculated tile timestamps and the flat `storyboards/` directory. |
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
| `library_store_start` | Queues one indivisible batch of 1–5 Workspace images for attachment and submission in a dedicated background ChatGPT service tab. |
| `library_store_status` | Reports local queue/submission state; it does not claim later Library availability. |
| `library_store_cancel` | Cancels a Library task only while it is still queued. |
| `online_share_start` | Explicitly starts one temporary cloudflared folder or exact-file share with optional independent image reachability verification. |
| `online_share_status` | Reports current share state and can repeat the configured external probe. |
| `online_share_stop` | Stops the active public share without deleting Workspace files. |

## Platform limits

- Clipboard tools are Windows-only.
- Screen capture uses gdigrab on Windows, X11 on Linux and AVFoundation on macOS; Linux Wayland is not supported.
- Camera support depends on FFmpeg device availability and OS permissions.
- Windows speech voices are Windows-only; Google Translate speech uses a browser tab and network availability.
- YouTube can remove captions/comments/storyboards, restrict a video, require verification or change public page formats.

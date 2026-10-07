# Error reference

ResearchTube uses stable public error codes so an assisting chat can distinguish input, availability, compatibility and processing failures. Exact messages remain bounded and should not contain physical paths or secrets.

## Connection and compatibility

| Code | Meaning | Corrective action |
| --- | --- | --- |
| `AGENT_UNAVAILABLE` | Extension cannot reach the loopback Agent | Start the Agent, check the configured port and test Settings |
| `AGENT_INTERFACE_INCOMPATIBLE` | Extension and Agent interface versions differ | Install matching components, reload/restart, refresh MCP schema |
| `AGENT_INVALID_RESPONSE` | Agent response violated the Extension's allowlisted contract | Record versions and report a compatibility/implementation defect |
| `AGENT_REQUEST_FAILED` | Loopback request failed after connection | Check Agent console and bounded diagnostics; do not expose paths |
| `CONFIG_INVALID` | A configured limit in `agent-config.json` is invalid | Use an integer within the documented range in `agent/README.md` |
| `API_KEY_MISSING` | Tunnel API key absent | Enter a dedicated restricted key in Settings |
| `API_KEY_INVALID` | OpenAI rejected the key | Replace/check the key locally |
| `TUNNEL_ID_MISSING` | Tunnel ID absent | Enter the `tunnel_...` identifier |
| `TUNNEL_NOT_FOUND` | Tunnel is unavailable to that key/organisation | Verify ID and organisation |
| `TUNNEL_PERMISSION_DENIED` | Restricted key lacks tunnel access | Grant required Tunnels Read + Use permissions |
| `NETWORK_ERROR` | Control-plane network request failed | Check network, VPN/proxy and retry |
| `TOOL_DISABLED` | Tool is disabled in ResearchTube Settings | Enable it and refresh the ChatGPT schema |

## Workspace and files

| Code | Meaning | Corrective action |
| --- | --- | --- |
| `WORKSPACE_UNAVAILABLE` | Workspace cannot be initialized or accessed | Check directory permissions without deleting user data |
| `WORKSPACE_PATH_INVALID` | Logical path syntax is unsafe or unsupported | Use a relative POSIX path without `.`, `..`, drives or backslashes |
| `WORKSPACE_PATH_OUTSIDE_SANDBOX` | Resolved path escapes Workspace | Remove redirects/symlinks and select a Workspace path |
| `WORKSPACE_NOT_FOUND` | Requested Workspace object is absent/unsupported | List or stat the parent and choose an existing regular object |
| `FILE_NOT_FOUND` | Expected regular file is missing | Use `workspace_list`/`workspace_stat` and correct the logical path |
| `DIRECTORY_NOT_FOUND` | Expected directory is missing | Create/select the intended directory |
| `DESTINATION_EXISTS` | An output already exists and will not be replaced | Choose a different destination or move the existing item deliberately |
| `DIRECTORY_NOT_EMPTY` | Safe delete refuses a non-empty directory | Delete selected contents explicitly; recursive delete is unavailable |
| `PERMISSION_DENIED` | OS denied the requested Workspace operation | Check local file permissions and locks |

## Components

| Code | Meaning | Corrective action |
| --- | --- | --- |
| `FFMPEG_NOT_AVAILABLE` | FFmpeg was not found | Install/bundle one unambiguous FFmpeg executable and restart Agent |
| `FFPROBE_NOT_AVAILABLE` | ffprobe was not found | Install/bundle ffprobe beside FFmpeg and restart Agent |
| `YTDLP_NOT_AVAILABLE` | yt-dlp was not found | Install/bundle yt-dlp and restart Agent |
| `YOUTUBE_POT_PROVIDER_NOT_AVAILABLE` | Required local provider is not ready | Repair Deno/provider installation, restart and check status |
| `CLOUDFLARED_NOT_AVAILABLE` | Online share executable missing | Install cloudflared only if public sharing is required |
| `*_DISCOVERY_ERROR` | More than one candidate or unusable discovery result | Remove duplicate candidates and verify executable version locally |

## YouTube

| Code | Meaning | Corrective action |
| --- | --- | --- |
| `INVALID_VIDEO_ID` | ID is malformed | Pass the exact 11-character YouTube ID |
| `YOUTUBE_SEARCH_RATE_LIMITED` | Search is in persisted backoff | Wait the returned delay and avoid repeated polling |
| `YOUTUBE_SEARCH_VERIFICATION` | YouTube requested verification | User completes normal page verification, then retries later |
| `RESEARCHTUBE_PAGE_CONTEXT_UNAVAILABLE` | Normal YouTube page bridge is unavailable | Keep/open a normal YouTube tab and retry once |
| `FORMAT_NOT_AVAILABLE` | Requested format is not in the current snapshot | Call `youtube_download_get_formats` again and select returned IDs |
| `DOWNLOAD_RANGE_INVALID` | Partial interval is outside video duration/order | Correct start/end using current metadata |
| `DOWNLOAD_FAILED` | yt-dlp task failed | Poll terminal status and request bounded download diagnostics |

## Storyboards

| Code | Meaning | Corrective action |
| --- | --- | --- |
| `STORYBOARD_INVALID` | Input or selection is invalid | Rediscover variants and validate selection fields |
| `STORYBOARD_NOT_AVAILABLE` | Video has no usable public storyboards | Use frame extraction/download instead |
| `STORYBOARD_VIDEO_LIVE` | Source is live/upcoming rather than finite archived video | Retry only after a finite archive is available |
| `STORYBOARD_CONTEXT_UNAVAILABLE` | Browser/yt-dlp metadata fallback could not resolve sheets | Open the matching video or repair yt-dlp/provider status |
| `STORYBOARD_VARIANT_NOT_FOUND` | Opaque variant no longer exists | Call `youtube_storyboard_get_info` again |
| `STORYBOARD_SHEET_NOT_FOUND` | Requested index is outside the variant | Use indexes below `sheetCount` |
| `STORYBOARD_DOWNLOAD_FAILED` | A sheet could not be fetched/published safely | Check availability, free space and filename conflicts |

## Media

| Code | Meaning | Corrective action |
| --- | --- | --- |
| `MEDIA_PROBE_FAILED` | ffprobe could not inspect the source | Verify file completeness/format and ffprobe availability |
| `CAPTURE_FRAME_INVALID` | Frame options conflict or are out of range | Correct source, timestamps, crop/resize and format options |
| `YOUTUBE_CAPTURE_FRAME_FAILED` | Partial YouTube range/frame extraction failed | Preserve completed frames and request frame diagnostics |
| `VISUAL_MAP_INVALID` | Grid, range, selection or timestamp options invalid | Correct options using source duration |
| `VISUAL_MAP_NO_SCENES` | Selected scene mode found no usable frames | Use uniform/hybrid selection or adjust range/threshold |
| `MEDIA_CLIP_INVALID` | Clip fields or interval list invalid | Correct output kind, streams, intervals and output directory |
| `MEDIA_CLIP_RANGE_INVALID` | Interval exceeds source duration | Probe the source and keep every end within duration |
| `MEDIA_CLIP_STREAM_NOT_FOUND` | Requested video/audio stream is absent | Inspect streams and choose a returned index |
| `MEDIA_CLIP_DURATION_UNAVAILABLE` | Whole-source operation needs unavailable duration | Supply explicit valid segments or repair the media |
| `MEDIA_CLIP_FAILED` | FFmpeg failed to create/publish a clip | Inspect source/streams, free space and destination conflicts |
| `IMAGE_CROP_INVALID` | Crop or output format invalid | Keep rectangle inside stored image bounds and match extension |
| `SCREEN_CAPTURE_UNAVAILABLE` | Current display backend is unsupported/unavailable | Check OS permission/backend; Wayland is unsupported |

## Chat file submission

| Code | Meaning | Corrective action |
| --- | --- | --- |
| `MEDIA_TO_CHAT_INVALID` | Invalid batch, configured count exceeded, wrong active tab, changed conversation, invalid Composer policy, existing draft/attachments, or user editing during upload | Inspect the Composer before retrying. Use an empty Composer or explicitly choose composerPolicy clear for initial text/attachments; neither policy clears edits made during upload. Count rejections include the maximum. |
| `MEDIA_TO_CHAT_TASK_NOT_FOUND` | Unknown current-chat submission task ID | Use the task ID returned by `media_to_chat`. |
| `LIBRARY_STORE_INVALID` | Invalid Library file batch or configured count exceeded | Correct logical file paths and the batch count. |

These are ordinary structured rejections with `isError: false`. Oversized individual files are reported in task `skippedFiles`, rather than rejecting eligible files. Browser upload failures are reported in the task's terminal state.

## Speech, clipboard, camera and sharing

| Code | Meaning | Corrective action |
| --- | --- | --- |
| `GOOGLE_TRANSLATE_UNAVAILABLE` | Translate page/listen control could not be prepared | Check network and debugger permission; retain the background tab |
| `GOOGLE_TRANSLATE_AUDIO_UNAVAILABLE` | No usable TTS audio response was collected | Retry a supported phrase and preserve bounded diagnostics |
| `VOICE_NOT_FOUND` | Windows voice ID is no longer available | Call `system_speech_list_voices` again |
| `CLIPBOARD_CHANGED` | Clipboard changed after status snapshot | Call `clipboard_status` again before reading |
| `CLIPBOARD_EMPTY` | Requested supported content is absent | Put text/image on clipboard and retry explicitly |
| `CLIPBOARD_TOO_LARGE` | Content exceeds safety limits | Use a smaller text/image payload |
| `CLIPBOARD_UNSUPPORTED` | Platform/content type is unsupported | Use Windows and a supported text/image type |
| `CAMERA_NOT_FOUND` | Opaque camera handle is stale/absent | Call `camera_list` again |
| `CAMERA_BUSY` | Camera is in an incompatible active operation | Stop/finalize the current recording and retry |
| `CAMERA_MODE_NOT_AVAILABLE` | Requested native mode is unavailable | Select a mode returned by `camera_list` |
| `PUBLIC_SHARE_NOT_ACTIVE` | Status/stop requested without a share | Start a share explicitly first |
| `PUBLIC_SHARE_START_FAILED` | cloudflared did not produce a usable share | Check component/network and retry without exposing Agent API |

## Task errors

`TASK_NOT_FOUND` and feature-specific `*_TASK_NOT_FOUND` codes mean task IDs are Agent-session-local or Extension-session-local. Restarting the owning component loses in-memory task status but does not delete fully published Workspace files.

For an unlisted code, preserve its exact code and bounded message, collect component/interface versions, and consult [Troubleshooting](TROUBLESHOOTING.md). Do not replace a stable code with an inferred explanation.

## Timers and retained task history

- `TIMER_INVALID`: mutually exclusive inputs, invalid duration/units/ISO timestamp/zone, ambiguous or missing local time, offset conflict or past deadline. Expected rejection, `isError: false`.
- `TIMER_NOT_FOUND`: no retained timer record; possible invalid ID, history eviction or Agent/computer restart. Expected rejection, `isError: false`; the cause is not asserted.
- `TIMER_INTERNET_UNAVAILABLE`: task preparation failed or the internet-clock sample exceeded the permitted age. Returned inside a failed task, without silently falling back to system time.
- `TIMER_SYSTEM_SUSPENDED`: confirmed system suspend interrupted a working timer; it was not restored.
- `TIMER_FAILED`: unexpected timer execution failure, represented in the failed task without provider/host details.

Clock-change and execution-gap warnings are task metadata rather than MCP tool errors. Other asynchronous not-found codes can also result from terminal-history eviction. Output files remain available in Workspace after their task record is removed.

## Artifact workflows

`MEDIA_ARTIFACT_TASK_NOT_FOUND` means the Extension history no longer has that workflow, or its ID belongs to a different producer. Files may still exist. `MEDIA_ARTIFACT_INTERRUPTED` means an unacknowledged start or single capture/crop/read was interrupted by a worker restart; check Workspace before retrying because work is never replayed automatically. `MEDIA_ARTIFACT_NO_FILES` means successful creation produced no attachment (for example clipboard text). `MEDIA_ARTIFACT_CHAT_FAILED` retains the current-chat error text and successful creation metadata. Other native creation errors retain their existing codes under creation.error. Old path parameter names are rejected with their canonical replacement.

## Browser Agent

`BROWSER_INVALID` rejects invalid parameters. `BROWSER_SESSION_NOT_FOUND` / `BROWSER_TASK_NOT_FOUND` indicate unknown, expired or restart-lost records. `PAGE_CHANGED` invalidates earlier node/resource IDs; `STALE_NODE` requires fresh observation. `BROWSER_SESSION_PAUSED` / `BROWSER_SESSION_STOPPED` block mutation. `TAB_CLOSED` ends the bound session normally (`state: stopped`, `error: null`, `stopReason.code: TAB_CLOSED`); subsequent page operations return a rejected TAB_CLOSED result. `BROWSER_CHAT_CHANGED` and unexpected `DEBUGGER_DETACHED` fail the session. `BROWSER_RESOURCE_TOO_LARGE` reports the upload threshold; `BROWSER_RESOURCE_UNAVAILABLE` / `BROWSER_RESOURCE_INVALID` indicate extraction or format failure. `BROWSER_DESTINATION_EXISTS` refuses overwrite. These expected conditions return ordinary rejected tool results, not MCP transport errors.

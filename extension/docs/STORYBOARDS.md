# YouTube Storyboards — ResearchTube 2.2.0

Extension 2.2.0, Agent 1.102.0, interface 63. Install both components together.
The Agent now includes `storyboards.py`; keep it beside `researchtube_agent.py`.
No additional Python packages or media executables are needed for sheet transfers.

The **YouTube Storyboards** settings group publishes:

| Tool | Input | Result |
| --- | --- | --- |
| `youtube_storyboard_get_info` | `videoId` | Availability and variants; no files or sheets downloaded |
| `youtube_storyboard_download` | `videoId`, `variantId`, `selection` | One asynchronous `tsk_XXXXXXXXXX` task |
| `youtube_storyboard_get_task` | `taskId` | Compact progress, counts, status, directory and sanitized error |
| `youtube_storyboard_cancel_task` | `taskId` | Terminal status after stopping active/queued work |

Source order: matching open YouTube tab via the existing page bridge, public
watch-page player metadata in the Agent, then metadata-only yt-dlp. No tabs are
created or navigated. No video/audio is downloaded. Current SPA player state
wins over stale initial globals. Live/upcoming/post-live DVR streams are rejected;
ordinary finite archived videos remain supported when they have storyboards.

`variantId` is opaque. The implementation preserves YouTube's level identity
across the browser and yt-dlp paths, rather than using yt-dlp's reversed `sbN`
format order. Public geometry includes cell width/height, rows/columns, cells per
sheet, frame interval, sheet count and JPEG format. `frameIntervalEstimated` is
false for an explicit nonzero YouTube interval and true for a zero-interval
overview or yt-dlp's average `frame_count / duration` fallback. Range selection
uses that estimate when the source does not expose the original interval.

## Flat filenames

All sheets are directly inside lowercase `storyboards/`. No subdirectories for
videos, variants, tasks, or sheet numbers are created inside it.

```text
storyboards/Название [yt_aqz-KE-bpKQ] [sz_160x90] [tstp_5] [mesh_5x5] [sheet_0000].jpeg
```

- `sz`: one cell's width × height, in pixels (not the whole sheet).
- `tstp`: the effective frame interval, in seconds; up to nine decimal places,
  with trailing zeroes removed.
- `mesh`: columns × rows.
- `sheet`: zero-based sheet index, at least four digits.
- Each tag has its own square brackets. The opaque variant ID is not a filename tag.
- Preserve Unicode and Windows-allowed punctuation; remove forbidden characters.
  Limit the entire filename component to 240 UTF-16 code units, preserving tags.

Distinct variants with identical geometry/timing may map to the same name.
Byte-identical sheets can be reused. Different existing content is never
silently replaced; the task fails and retains previously completed files.

## Selections

```json
{"mode":"all"}
{"mode":"range","startSeconds":60,"endSeconds":120}
{"mode":"sheets","sheetIndexes":[0,3,4]}
```

A range must satisfy `0 <= startSeconds <= endSeconds <= durationSeconds`.
Requested endpoints are inclusive. Sheet coverage is `[start, nextStart)`;
the last sheet includes the video's final instant. An exact point at a sheet
boundary selects the next sheet, while a range ending at that boundary includes
both intersecting sheets. Index selections discard duplicates and reject
out-of-range values. Last sheets may contain unused cells.

## Tasks and privacy

The start result has `status: working`, `phase: resolving`, counts and a 1000 ms
poll interval. Phases are resolving, downloading, publishing, completed,
cancelled and failed. Percentage is monotonic, based on completed sheets and
usable current-transfer content length. Polling returns downloaded/reused
counts and `workspaceDirectory: storyboards`, without a file-path array.

Cancellation closes the active HTTP transfer, skips remaining sheets and retains
complete sheets. Partial HTTP bytes remain in bounded memory; publishing uses a
short-lived temporary file outside Workspace and an exclusive atomic hard link.
Existing Workspace redirects and conflicting files are rejected. Three tasks
may transfer concurrently; each task downloads its selected sheets sequentially.

Completed files can be reused after hash verification. After an Agent restart,
existing files are compared with newly fetched bytes before reuse. Task IDs and
metadata caches are Agent-session-local. Restart does not delete saved sheets.

Expected input/unavailability outcomes return normal structured results, without
MCP `isError: true`. Stable codes: `STORYBOARD_INVALID`,
`STORYBOARD_NOT_AVAILABLE`, `STORYBOARD_VIDEO_LIVE`,
`STORYBOARD_CONTEXT_UNAVAILABLE`, `STORYBOARD_VARIANT_NOT_FOUND`,
`STORYBOARD_SHEET_NOT_FOUND`, `STORYBOARD_DOWNLOAD_FAILED`, `TASK_NOT_FOUND`.

Raw specs, signed URLs, cookies, tokens, physical paths and image bytes never
enter MCP results or diagnostics. HTTPS sheet requests and redirects are limited
to YouTube's `ytimg.com` storyboard paths. There is no automatic widget display;
use `workspace_list` and the ordinary image-show tool when requested.

## Verification

```sh
python -m unittest discover -s agent/tests -p 'test_*.py'
npm ci --prefix extension
npm test --prefix extension
```

Behavioral coverage includes geometry and level parsing, selection boundaries,
flat Unicode names, progress, reuse, cancellation before/mid-transfer, partial
failure, conflicting files, symlink protection, HTTP framing/redirects, public
field projection, Agent HTTP routing, and the Extension's matching-tab/SPA bridge.
Live Windows/Chrome/YouTube installation verification must be performed with the
updated Agent and Extension; mocked service tests do not substitute for it.

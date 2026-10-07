# YouTube Storyboards


All start/status/cancel calls use the common [artifact workflow](ARTIFACT_TASKS.md). Public results expose native task metadata under `creation.data` and created paths under `files`; `addToChat` optionally extends the same task through upload and Send. `media_task_status` and `media_task_cancel` are shared follow-up tools. Specialized status/cancel names are aliases.

ResearchTube can discover and download YouTube's ready-made timeline preview sheets without downloading video or audio.

## Public tools

| Tool | Purpose |
| --- | --- |
| `youtube_storyboard_get_info` | Discover variants and geometry |
| `youtube_storyboard_download` | Start selection/download task |
| `youtube_storyboard_get_task` | Poll progress and timestamps |
| `youtube_storyboard_cancel_task` | Stop queued/current transfers |

Discovery first uses matching current YouTube page context, then Agent watch-page metadata and finally metadata-only yt-dlp fallback. No tab is navigated. Live, upcoming and post-live DVR streams are rejected; finite archived videos are supported when storyboards exist.

When discovery returns `available:false`, its `comment` recommends `visual_map_create` using a Workspace video (download it first if needed). Unavailable download rejections include the same fixed comment; `STORYBOARD_NOT_AVAILABLE` also includes the advice in its error message so artifact-task failures retain it. This is guidance only: no video download or Visual Map starts automatically. Agent reasons and privacy projection are preserved.

## Variants

`variantId` is opaque and must be passed unchanged from discovery. Public metadata includes:

- cell width and height;
- columns and rows;
- frames per sheet;
- effective frame interval;
- whether interval timing was estimated;
- sheet count;
- JPEG format.

ResearchTube preserves YouTube level identity rather than exposing yt-dlp's reversed `sbN` ordering.

## Selection

```json
{"mode":"all"}
{"mode":"range","startSeconds":60,"endSeconds":120}
{"mode":"sheets","sheetIndexes":[0,3,4]}
```

Ranges are inclusive and must remain within video duration. Sheet indexes are zero-based; duplicates are discarded and out-of-range indexes are rejected.

## Files

All sheets are stored directly in lowercase `storyboards/`; no per-video, variant or task subdirectory is created.

```text
storyboards/Title [yt_aqz-KE-bpKQ] [sz_160x90] [tstp_5] [mesh_5x5] [sheet_0000].jpeg
```

- `sz` is one cell's width × height.
- `tstp` is effective frame interval seconds with unnecessary trailing zeroes removed.
- `mesh` is columns × rows.
- `sheet` is a zero-based index padded to at least four digits.
- Each tag has its own square brackets.

The Agent preserves Unicode and Windows-safe punctuation, removes forbidden characters and keeps a filename component within the portable limit.

## Timestamp overlay

`frameTimestampPosition` accepts `none`, `topLeft`, `topRight`, `bottomLeft` or `bottomRight` and defaults to `bottomRight`.

The Agent computes every real tile's absolute video timestamp:

```text
(sheetIndex × framesPerSheet + cellIndex) × frameIntervalSeconds
```

With `none`, the original JPEG bytes are retained. Otherwise a portable bundled font draws `M:SS` or `H:MM:SS` inside each real cell. Unused cells in the last partial sheet remain untouched.

`sheetTimestamps` always returns the calculated timestamp arrays, independent of visual overlay.

## Tasks and publishing

Phases are resolving, downloading, publishing, completed, cancelled and failed. Progress is monotonic and combines completed sheets with bounded current-transfer byte progress when content length is usable.

Cancellation closes the active transfer, skips remaining work and retains complete published sheets. Temporary transfer bytes remain outside public results. Publishing refuses redirects and conflicting files.

Existing files are reused only after byte verification. A conflicting file is never replaced. Task state and metadata caches are session-local; restarting the Agent does not delete saved sheets.

## Privacy

Raw storyboard specs, signed URLs, cookies, tokens, physical paths and image bytes never enter MCP results or diagnostics. HTTPS transfers and redirects are restricted to expected YouTube storyboard paths. Sheets are not displayed automatically; use the task files or creation.data.publishedSheets with media_show deliberately. Exact published paths are available without scanning storyboards/.

The authoritative implementation is `extension/storyboards.js` and `agent/storyboards.py`.

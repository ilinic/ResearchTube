# Media clips


All start/status/cancel calls use the common [artifact workflow](ARTIFACT_TASKS.md). Public results expose native task metadata under `creation.data` and created paths under `files`; `addToChat` optionally extends the same task through upload and Send. `media_task_status` and `media_task_cancel` are shared follow-up tools. Specialized status/cancel names are aliases.

`media_clip` is the unified asynchronous local cutter for video and audio.

## Supported transformations

| Source | Output |
| --- | --- |
| Video | Video clip(s) |
| Video | Extracted audio clip(s) or complete audio |
| Audio | Audio clip(s) or complete audio |

The source is an existing logical Workspace path. It is never modified.

## Intervals

`segments` accepts objects with `startSeconds` and `endSeconds`, up to `limits.mediaClipMaxSegments` in `agent/agent-config.json` (default 20). Input order is preserved and every interval creates a separate file. Intervals are not concatenated.

When `segments` is omitted, the complete source duration is processed. This is useful for extracting the full audio stream from video.

Every interval must be finite, non-negative, non-empty and within source duration. Duplicate intervals are rejected.

## Modes

- `copy` is the default. Encoded streams are copied without transcoding. It is fast and preserves quality, but video boundaries can align to source keyframes.
- `accurate` re-encodes H.264/AAC output to honor precise requested boundaries.

For video output, `includeAudio` defaults to true. Specific ffprobe stream indexes can be selected when a source contains multiple tracks.

## Outputs

The default directory is lowercase `clips/`. Filenames contain the source title, interval tag and opaque task ID. Common native containers/codecs are retained in copy mode; accurate output uses MP4/M4A.

ResearchTube checks the destination before processing and publishes the completed temporary file exclusively. It never silently replaces an existing file.

## Progress and failure

FFmpeg runs with `-progress pipe:1`. Microsecond output time is converted into per-interval progress and then into an overall batch percentage. A working task remains below 100%; successful completion is exactly 100%.

After each output is safely published it is added to `clips` and `completedClips`. If a later interval fails, earlier files remain available and the task identifies the failed segment. Cancellation terminates FFmpeg, removes the active temporary file and retains complete outputs.

Poll with `media_clip_get_task` no faster than `pollIntervalMs`; cancel with `media_clip_cancel_task`.

The authoritative implementation is in `extension/background.js` and `agent/researchtube_agent.py`.

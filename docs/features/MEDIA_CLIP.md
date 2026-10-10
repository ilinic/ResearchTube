# Media cutting and conversion

`media_clip` (**Cut and Convert Media**) cuts video/audio into separate files or converts a whole file. It uses the common [artifact workflow](ARTIFACT_TASKS.md): one public task covers creation and optional upload/Send, with `media_task_status` and `media_task_cancel` for follow-up.

## Source, intervals and format

The source argument is `workspacePath`, an existing logical Workspace file. It is never modified. Output files go to `clips/` unless `outputWorkspaceDirectory` is supplied.

- With `segments` and no `outputFormat`, retain the source container and copy its encoded video/audio streams without transcoding. Video boundaries can align to keyframes.
- With both `segments` and `outputFormat`, cut and convert each interval, using re-encoding for precise requested boundaries.
- Without `segments`, `outputFormat` is required; convert the complete source file.
- Supplying neither is invalid. The obsolete input fields `outputKind` and `cutMode` are rejected.

Intervals have `startSeconds` and `endSeconds`, must be finite, non-negative, non-empty and within the source duration. Preserve caller order, including a later interval before an earlier one. Each interval creates a separate file; no concatenation occurs. Duplicate intervals are rejected. The configured maximum is `limits.mediaClipMaxSegments` (default 20).

## Output formats and streams

`outputFormat` names a format supported by installed FFmpeg, not a closed enum. Common names include `mp4`, `mkv`, `webm`, `mp3`, `m4a`, `wav`, `flac`, `ogg` and `opus`. Extension-like aliases resolve to the corresponding muxer. The Agent queries FFmpeg's muxer capabilities privately and rejects unsupported formats.

Audio formats select only sound from video/audio sources. Video containers select supported source video and audio; an audio-only source remains audio-only in MP4/MKV/WebM. `includeAudio: false` creates silent video. Optional `videoStreamIndex` and `audioStreamIndex` select ffprobe stream indexes. Impossible stream selections or incompatible video settings for audio-only formats are rejected.

When converting, FFmpeg selects default encoders for the output format. Optional `videoCodec`, `audioCodec`, `videoBitrate` and `audioBitrate` customize encoding; they require an explicit `outputFormat` and the corresponding selected stream. Example bitrates: `192k`, `2M`. Raw shell commands and arbitrary filesystem targets are never accepted.

## Results, progress and cancellation

Portable generated filenames contain the source title, interval tag and task ID. They use the requested format extension (or detected source format for copying). Existing files are never overwritten. `creation.data.outputFormat` is null only while a source-preserving task is still preparing or has failed before format discovery; completed clips expose their actual `format`, derived `outputKind`, selected source indexes and `reencoded` flag. The internal result `cutMode` describes what happened; callers do not specify it.

FFmpeg runs with `-progress pipe:1`. Native output time drives monotonic per-interval and overall progress. Working tasks remain below 100%; successful completion is exactly 100%.

Completed outputs are probed before exclusive publication and added to `clips` without an intervening await. Later failure/cancellation preserves already published clips. Cancellation stops FFmpeg/ffprobe/format discovery and removes the active temporary file. Errors contain bounded guidance, never raw process output or physical paths.

Poll the common status tool no faster than `pollIntervalMs`. Specialized `media_clip_get_task` and `media_clip_cancel_task` remain aliases of the complete public workflow. `addToChat` optionally extends creation through attachment/Send.

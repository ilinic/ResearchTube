# Media cutting and conversion

`media_clip` (**Cut and Convert Media**) cuts video/audio into separate files or converts a whole file. It uses the common [artifact workflow](ARTIFACT_TASKS.md): one public task covers creation and optional upload/Send, with `media_task_status` and `media_task_cancel` for follow-up.

## Source, intervals and format

The source argument is `workspacePath`, an existing logical Workspace file. It is never modified. Output files go to `clips/` unless `outputWorkspaceDirectory` is supplied.

- With `segments` and no `outputFormat`, retain the source container and copy its encoded video/audio streams without transcoding. Video boundaries can align to keyframes.
- With both `segments` and `outputFormat`, process each interval, copying compatible streams and re-encoding only incompatible ones. Copied video can align to keyframes even when outputFormat is supplied.
- Without `segments`, `outputFormat` is required; convert, remux or extract audio from the complete source file. Whole-source processing keeps all input packets, including audio priming/tail packets.
- Supplying neither is invalid. The obsolete input fields `outputKind` and `cutMode` are rejected.

Intervals have `startSeconds` and `endSeconds`, must be finite, non-negative, non-empty and within the source duration. Preserve caller order, including a later interval before an earlier one. Each interval creates a separate file; no concatenation occurs. Duplicate intervals are rejected. The configured maximum is `limits.mediaClipMaxSegments` (default 20).

## Output formats and streams

`outputFormat` names a format supported by installed FFmpeg, not a closed enum. Common names include `mp4`, `mkv`, `webm`, `mp3`, `m4a`, `wav`, `flac`, `ogg` and `opus`. Extension-like aliases resolve to the corresponding muxer. The Agent queries FFmpeg's muxer capabilities privately and rejects unsupported formats.

Audio formats select only sound from video/audio sources. Video containers select supported source video and audio; an audio-only source remains audio-only in MP4/MKV/WebM. `includeAudio: false` creates silent video. Optional `videoStreamIndex` and `audioStreamIndex` select ffprobe stream indexes. Impossible stream selections or incompatible video settings for audio-only formats are rejected.

The normal interface needs only `workspacePath`, optional `segments` and conditional `outputFormat`. For each selected stream the Agent checks the installed muxer's compatibility using a disposable header-only remux. Compatible streams are copied without decoding or quality loss; incompatible streams use an available output-format encoder with automatic codec-specific quality settings. One stream can be copied while another is encoded. WAV/AIFF requests produce decoded PCM rather than unusual compressed audio in a WAVE container.

Examples: AAC video -> M4A and Opus video -> Opus retain every encoded audio packet. Opus -> MP3 needs encoding. A compatible video container can retain the original video/audio codecs; changing the extension does not necessarily change codecs.

Optional `videoCodec`, `audioCodec`, `videoBitrate` and `audioBitrate` are advanced overrides, not required for normal use. An encoder or bitrate forces encoding of that stream only; an explicit bitrate replaces automatic quality rate control. They require `outputFormat` and the corresponding selected stream. Example bitrates: `192k`, `2M`. Raw shell commands and arbitrary filesystem targets are never accepted.

## Automatic quality

Preserving existing packets is preferred over every re-encoding profile. When encoding is necessary, the policy prioritizes signal quality over file size:

| Encoder | Automatic settings without an explicit bitrate |
| --- | --- |
| libx264 / libx264rgb | CRF 0, slow preset (lossless encoding) |
| libx265 | lossless mode, slow preset |
| libvpx-vp9 | lossless mode, unconstrained bitrate, quality-oriented encoding |
| libaom-av1 | CRF 0, unconstrained bitrate |
| libvpx (VP8) | CRF 4, 10 Mb/s quality budget |
| MPEG-1/2/4, MJPEG, libxvid | q:v 1 |
| libtheora | q:v 10 |
| libmp3lame | VBR q:a 0, highest algorithm quality |
| libvorbis | q:a 10 |
| libopus | VBR, maximum algorithm complexity, up to 256 kb/s per channel |
| native AAC | two-loop coder, up to 320 kb/s per channel, bounded by sample rate |
| libfdk_aac | VBR 5 |
| AC-3 / E-AC-3 / MP2 | 640 / up to 6144 (sample-rate bound) / 384 kb/s |
| FLAC / ALAC / PCM | retain supported sample precision; FLAC compression level 12 |

Encoder availability comes from the installed FFmpeg. Codec-specific settings are never applied blindly to another encoder. Unusual encoders without a known quality profile retain their own defaults; the tool does not guarantee a universal maximum across arbitrary FFmpeg codecs. Lossless modes can make files much larger and may have narrower player support. Lossy codecs still introduce loss; re-encoding cannot restore detail already absent in the source. Sample/pixel-format conversions required by the target codec can also affect precision. Float audio converted to integer FLAC uses 24-bit precision unless the source specifies an integer bit depth; PCM WAV/AIFF preserve supported float/integer precision without implicit 16-bit reduction.

## Results, progress and cancellation

Portable generated filenames contain the source title, interval tag and task ID. They use the requested format extension (or detected source format for copying). Existing files are never overwritten. `creation.data.outputFormat` is null only while a source-preserving task is still preparing or has failed before format discovery; completed clips expose their actual `format`, derived `outputKind`, selected source indexes and a `reencoded` flag that is true if any selected stream was encoded. The internal result `cutMode` describes what happened; callers do not specify it.

FFmpeg runs with `-progress pipe:1`. Native output time drives monotonic per-interval and overall progress. Working tasks remain below 100%; successful completion is exactly 100%.

Completed outputs are probed before exclusive publication and added to `clips` without an intervening await. Later failure/cancellation preserves already published clips. Cancellation stops FFmpeg/ffprobe/format discovery/compatibility checks and removes the active temporary file. Errors contain bounded guidance, never raw process output or physical paths.

Poll the common status tool no faster than `pollIntervalMs`. Specialized `media_clip_get_task` and `media_clip_cancel_task` remain aliases of the complete public workflow. `addToChat` optionally extends creation through attachment/Send.

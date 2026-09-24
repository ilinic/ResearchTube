# YouTube partial-frame / PO-token provider test

Use a public, ordinary YouTube video at least 15 minutes long. Do not use a
private, age-restricted, members-only, live, Premiere, or login-required video.

1. Restart the Local Agent after running:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install-youtube-po-token-provider.ps1
   ```

2. Call `system_agent_status`. Confirm that `yt-dlp` and Deno are available.

3. Call `youtube_download_get_formats` with the target `videoId`. Select one
   exact numeric ID from `downloadFormats.video`; do not use the browser-side
   advisory format list.

4. Start exactly one `media_capture_frame` task. The Agent merges frame windows
whose gap is no more than 10 seconds, but caps one partial section at 60 seconds.
It creates one yt-dlp/FFmpeg invocation at a time, with a 2-second pause between
separate sections. A temporary failed section is retried after 3 seconds and then
after 6 seconds; it does not send all sections to one FFmpeg process:

   ```json
   {
     "youtube": { "videoId": "<long-public-video-id>", "formatId": "<exact-video-format-id>" },
     "timestampsSeconds": [30, 130, 230, 330, 430, 530, 630, 730, 830],
     "seekMode": "fast",
     "image": { "format": "jpeg", "quality": 80 }
   }
   ```

5. Poll `media_capture_frame_get_task` no faster than its `pollIntervalMs`.
   Do not start separate capture tasks for the individual timestamps.

Expected successful result:

- one task reaches `completed`, `completedFrames: 9`, and `progressPercent: 100`;
- every image is in `captures/`, with its requested `[t_…]` tag;
- every result has the same `sourcePath: "youtube:<videoId>"` and selected
  `sourceVideoFormatId`;
- every `partialDownload` is a short range around its timestamp, not the full
  video duration;
- no Workspace Image card appears automatically. Optionally call
  `media_image_show` once for one completed frame only.

If the task fails, do **not** repeat it yet. Call
`media_capture_frame_task_diagnostics` once with the task ID.

Expected diagnostic properties:

- `youtube.sectionCount` is greater than one for the separated timestamps;
- `youtube.poTokenProvider.state` is `ready` after a correct installation;
- `youtube.ytDlpExitCode` is present;
- `youtube.output` contains at most 20 bounded diagnostic lines;
- its output contains no signed `googlevideo` URL, PO Token, cookie, or host
  filesystem path.

If a later section fails, the same one task reaches `failed` but keeps all
earlier `frames`; its `failedSection` identifies the one-based section index,
range, number of requested frames, and final `attemptCount`. Diagnostics repeats that `failedSection`
and contains output only from the failed individual yt-dlp invocation. Do not
restart the batch merely to obtain diagnostics.

Interpretation:

- one timestamp succeeds but this multi-section task fails: investigate the
  multi-section invocation/rate behavior;
- both fail with provider `ready`: preserve this diagnostic output and inspect
  the selected format/client rather than silently selecting a lower-quality
  stream;
- provider state is `notInstalled`, `incomplete`, `notReady`, or `runtimeMissing`: correct
  the local installation before treating the 403 as a YouTube rate limit.

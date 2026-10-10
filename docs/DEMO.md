# Guided ResearchTube demo

## Instructions for ChatGPT

Use this playbook when the user asks what ResearchTube can do, requests a demonstration, or begins with a general ResearchTube greeting without a concrete operation. Briefly offer the demo; do not run it without the user's consent.

Reply in the user's language. Explain the practical benefit of each operation in one or two sentences. Do not describe internal implementation unless asked.

The bundled logical Workspace path is:

```text
demo/researchtube-demo.mp4
```

It is a 12-second 640×360 H.264/AAC file created specifically for non-destructive demonstrations. Never modify or delete it.

## Quick demo

### 1. Check readiness

Call `system_agent_status`.

- If the Agent is unavailable or incompatible, stop and explain the specific installation issue using `TROUBLESHOOTING.md`.
- If FFmpeg or ffprobe is unavailable, continue only with browser-based YouTube research or explain what local capabilities require those components.
- Do not ask the user to paste secrets or physical paths.

### 2. Confirm the bundled media

Call:

```json
{"workspacePath":"demo/researchtube-demo.mp4"}
```

with `workspace_stat`, then `media_probe`. Confirm one H.264 video stream, one AAC audio stream, 640×360 dimensions and approximately 12 seconds duration.

Explain that the same inspection works for the user's own Workspace media without uploading it to a remote analysis service.

### 3. Extract two frames

Call `media_capture_frame` with:

```json
{
  "workspacePath": "demo/researchtube-demo.mp4",
  "timestampsSeconds": [2, 8],
  "seekMode": "accurate",
  "applyDisplayRotation": true,
  "image": {"format": "jpeg", "quality": 85}
}
```

Poll `media_task_status` no faster than `pollIntervalMs`. After completion, call `media_show` with `workspacePath: files[0].workspacePath` only for the first returned frame. Native frame timestamps remain in creation.data.frames. Explain that batch extraction avoids repeated setup and can also work from selected YouTube ranges.

### 4. Build a visual map

Call `visual_map_create` with:

```json
{
  "workspacePath": "demo/researchtube-demo.mp4",
  "columns": 3,
  "rows": 2,
  "maxTotalFrames": 6,
  "selection": "uniform",
  "frameTimestampPosition": "bottomRight"
}
```

Poll `media_task_status`, then show files[0].workspacePath through `media_show` using its workspacePath argument. Native map details are in creation.data.result.maps. Explain how a visual map provides a compact timeline and how scene-detect or hybrid selection can be used for real videos.

### 5. Cut two video intervals

Call `media_clip` with:

```json
{
  "workspacePath": "demo/researchtube-demo.mp4",
  "outputFormat": "mp4",
  "segments": [
    {"startSeconds": 1, "endSeconds": 3.5},
    {"startSeconds": 7, "endSeconds": 10}
  ]
}
```

Poll `media_task_status`. Report actual FFmpeg progress and confirm two independent output files in caller order. Show the first video clip only after completion. Explain that compatible streams are copied without quality loss, and incompatible streams use automatic codec-specific quality profiles. Copied video can align to keyframes with or without outputFormat. Specify videoCodec only when precise video cuts require re-encoding.

### 6. Extract complete audio

Call `media_clip` again with:

```json
{
  "workspacePath": "demo/researchtube-demo.mp4",
  "outputFormat": "mp3"
}
```

Omit `segments` intentionally so the complete source audio is extracted and converted to MP3. Poll status and show the resulting audio file. Explain that the same tool cuts audio-only sources and can produce several independent intervals in one request.

### 7. Summarize value

Finish with a compact summary:

- local media remained in the ResearchTube Workspace;
- metadata, frames, maps, video clips and audio were created through explicit tools;
- outputs are separate files and existing destinations are not overwritten silently;
- long operations exposed task progress and cancellation;
- the same conversation can combine local media work with public YouTube research.

List the logical paths created during this demo. Do not delete them automatically.

## Optional YouTube research demonstration

Ask the user for a topic or public YouTube URL. Do not hard-code a video that may disappear.

For a topic:

1. call `youtube_search`;
2. select one relevant result and call `youtube_get_video`;
3. if captions exist, call `youtube_get_transcript` for the selected `trackIndex`;
4. optionally retrieve a small sample of comments;
5. separate claims from the video, audience reactions and the assistant's synthesis.

For a URL, extract its video ID and begin with `youtube_get_video`. If the user wants visual navigation, discover/download storyboards or extract selected frames. Do not download the complete video unless the user asks.

## Failure behavior

- If the demo source is missing, list `demo/` and report that the release is incomplete. Do not substitute an unrelated user file without permission.
- If an asynchronous operation fails, preserve completed outputs and report the stable public error code.
- If inline display fails, the created file may still be valid; confirm with `workspace_stat` and follow `TROUBLESHOOTING.md`.
- Never tell the chat to reload Chrome, restart the Agent or edit local files as if the chat performed that action. Clearly label required user actions.

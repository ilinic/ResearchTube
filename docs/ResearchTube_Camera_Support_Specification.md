# ResearchTube — Camera Support Specification

**Status:** Proposed implementation specification  
**Scope:** Local Agent camera capture through FFmpeg  
**Primary platform goal:** Windows, Linux, macOS  
**Architecture authority:** `docs/ARCHITECTURE.md`

---

## 1. Goal

Add cross-platform webcam/camera support to ResearchTube through the Local Agent.

ResearchTube must be able to:

1. list available video cameras;
2. identify each camera with an opaque ResearchTube `cameraId`;
3. capture one still frame at the highest available camera resolution;
4. record a short video at the highest available camera resolution;
5. expose recording state and progress;
6. gracefully stop an active recording before its requested/end limit;
7. save all generated media inside the ResearchTube workspace;
8. never expose native camera identifiers, device paths, host paths, or raw FFmpeg command details through MCP.

FFmpeg is the capture backend. Do not add OpenCV or another large camera framework solely for this feature.

---

## 2. Tool naming

All camera tools must form one contiguous and predictable MCP namespace:

```text
media_camera_list
media_camera_capture_frame
media_camera_record_video
media_camera_record_status
media_camera_record_stop
```

Every camera tool name starts with:

```text
media_camera_
```

Do not introduce unrelated aliases such as:

```text
camera_list
capture_webcam
webcam_frame
record_camera
```

The uniform prefix is intentional so all camera operations appear together in the tool catalogue.

---

## 3. Platform backends

Use FFmpeg/libavdevice with the native input backend for each platform:

```text
Windows -> DirectShow / dshow
Linux   -> Video4Linux2 / v4l2
macOS   -> AVFoundation / avfoundation
```

ResearchTube may contain small platform-specific discovery/probing adapters because FFmpeg does not expose every device-discovery detail through one identical command on all operating systems.

However:

- FFmpeg remains the authoritative capture/recording process;
- do not add OpenCV as a dependency;
- do not add a second media pipeline;
- platform differences must be hidden behind one ResearchTube camera abstraction.

---

## 4. Camera abstraction

Internally represent a camera with a ResearchTube structure conceptually similar to:

```text
CameraDevice
    cameraId
    displayName
    backend
    internalNativeIdentity
    supportedModes
    selectedMode
```

Only safe public fields cross the MCP boundary.

The native identity is Agent-internal only.

---

## 5. cameraId

`cameraId` is an opaque ResearchTube logical identifier.

Example:

```text
camera_7f2a91c4
```

It must not expose:

- `/dev/video0`;
- DirectShow alternative device names;
- Windows PnP paths;
- AVFoundation UID/serial data;
- a physical host path;
- a raw FFmpeg device argument.

The Agent keeps the mapping:

```text
cameraId -> native camera identity
```

### 5.1 Stability

The minimum required guarantee is:

> A cameraId remains valid and unambiguous for the lifetime of the current Local Agent process.

After Agent restart, callers should call `media_camera_list` again before starting new camera operations.

If a platform supplies a suitably stable native identity, the implementation may derive a deterministic opaque ID from it, for example by hashing the internal identity, but the public API must not depend on cross-restart stability in v1.

### 5.2 Duplicate camera names

Human-readable camera names are not guaranteed unique.

For example, two connected cameras may both be named:

```text
Logitech HD Pro Webcam C920
```

They must still receive distinct `cameraId` values.

Do not use display name alone as the internal key.

---

## 6. media_camera_list

### Purpose

List currently available video cameras.

### Input

No arguments.

```json
{}
```

### Output

Recommended shape:

```json
{
  "cameras": [
    {
      "cameraId": "camera_7f2a91c4",
      "name": "Logitech HD Pro Webcam C920",
      "maxResolution": {
        "width": 1920,
        "height": 1080
      },
      "selectedVideoMode": {
        "width": 1920,
        "height": 1080,
        "fps": 30
      }
    }
  ]
}
```

Do not return:

- native device path;
- backend-specific alternative name;
- PnP identifier;
- AVFoundation UID or serial;
- host filesystem path;
- FFmpeg command line.

Returning the backend name itself is optional and should be omitted unless it is useful for diagnostics.

### Empty result

No connected cameras is a valid successful result:

```json
{
  "cameras": []
}
```

---

## 7. Camera capability probing

ResearchTube must capture at the highest available native camera resolution.

Do not rely silently on the FFmpeg backend default, because many camera backends may otherwise choose a low default mode.

The Agent should discover/probe supported video modes through the relevant FFmpeg backend and choose the maximum native frame size.

Selection rule:

1. choose the supported mode with the greatest pixel area `width * height`;
2. if multiple modes have the same maximum resolution, prefer the highest practical supported frame rate;
3. never upscale a lower-resolution stream to satisfy the maximum-resolution requirement;
4. cache discovered camera capabilities for the current Agent process where useful;
5. refresh/reprobe if opening the cached mode fails because the device changed.

Capture mode selection is internal. The MCP caller does not choose resolution, pixel format, codec, or FPS in this version.

---

## 8. No quality/configuration parameters in v1

Do not expose camera-quality controls in the initial MCP API.

Do not accept:

```text
width
height
resolution
fps
pixelFormat
bitrate
codec
quality
deviceIndex
nativeDeviceName
backend
```

ResearchTube chooses the best capture mode automatically.

These controls may be added later if a real use case requires them.

The only operational duration parameter allowed for recording is described below; it is not a camera-quality setting.

---

## 9. media_camera_capture_frame

### Purpose

Capture one current still image from a selected camera.

### Input

```json
{
  "cameraId": "camera_7f2a91c4"
}
```

No resolution/quality parameters.

### Behaviour

1. resolve `cameraId` to the Agent-internal device identity;
2. open the camera through FFmpeg;
3. use the maximum selected native resolution;
4. capture a current frame;
5. save it as PNG inside the ResearchTube workspace;
6. close the FFmpeg process/device;
7. return only logical workspace metadata.

Preferred workspace directory:

```text
captures/camera/
```

Example result:

```json
{
  "cameraId": "camera_7f2a91c4",
  "filePath": "captures/camera/frame_20260923_174812.png",
  "format": "png",
  "width": 1920,
  "height": 1080
}
```

`filePath` is always a ResearchTube workspace-relative POSIX logical path.

Do not return the image as raw Base64 from this tool.

If the image needs to be displayed in ChatGPT, use the project's existing workspace-image display mechanism as a separate step.

### Capture freshness

Do not assume the first decoded frame after opening a camera is visually valid.

The implementation may allow a short internal warm-up or discard a small number of initial frames if required by real cameras.

This is internal behaviour and must not become a user-visible parameter in v1.

---

## 10. Video recording model

Video recording is a long-running operation and must use the existing ResearchTube task infrastructure.

`media_camera_record_video` starts a task and returns quickly with a `taskId`.

Do not block the MCP tool call for the full recording duration.

Conceptually:

```text
media_camera_record_video
        |
        v
create ResearchTube taskId
        |
        v
start FFmpeg asynchronously
        |
        v
recording continues in Agent
        |
        +--> media_camera_record_status
        |
        +--> media_camera_record_stop
```

Reuse the existing Agent TaskManager/task identifier conventions. Do not create a second independent camera-job system.

---

## 11. Recording duration

Maximum recording duration:

```text
60 seconds
```

The hard limit is enforced by the Agent.

Recommended input:

```json
{
  "cameraId": "camera_7f2a91c4",
  "durationSeconds": 30
}
```

Rules:

- `durationSeconds` is optional;
- default = 60;
- minimum = 1 second;
- maximum = 60 seconds;
- values greater than 60 are rejected;
- if the recording is not manually stopped, it automatically finalizes at the requested duration;
- regardless of caller behaviour, no camera recording task may record beyond 60 seconds.

This is the only initial recording parameter besides `cameraId`.

---

## 12. media_camera_record_video

### Input

```json
{
  "cameraId": "camera_7f2a91c4",
  "durationSeconds": 60
}
```

### Immediate result

```json
{
  "taskId": "..."
}
```

The exact task envelope should match the existing ResearchTube task conventions.

### Recording behaviour

1. validate `cameraId`;
2. determine/use the maximum native resolution;
3. create a temporary workspace output file;
4. start FFmpeg asynchronously;
5. record video-only camera input;
6. update task status/progress while recording;
7. stop automatically at the requested duration or when `media_camera_record_stop` is requested;
8. gracefully finalize the media container;
9. atomically expose/rename the final workspace file when practical;
10. complete the task with one logical workspace-relative result path.

---

## 13. Video output

Preferred final container:

```text
MP4
```

Preferred video codec:

```text
H.264
```

Use an encoder actually available in the project's supported FFmpeg build.

Do not silently change to a completely different final media type without reflecting it in the result.

If the required MP4/H.264 encoding pipeline is unavailable, return a structured error rather than generating a misleading file extension.

Audio/microphone recording is out of scope for this camera iteration.

### Workspace directory

Preferred location:

```text
captures/camera/
```

### Filename

The final filename must include the taskId to avoid collisions.

Conceptual form:

```text
camera_recording_<timestamp> [<cameraId>] [<taskId>].mp4
```

Only the workspace-relative logical path is returned through MCP.

---

## 14. Temporary recording files

Do not expose a partially written recording as if it were complete.

Use a temporary workspace filename while FFmpeg is recording/finalizing.

Only after successful finalization should the final `.mp4` path become the task result.

On failure:

- mark the task failed;
- do not return the temporary file as a successful recording;
- remove incomplete temporary files on a best-effort basis.

---

## 15. Recording task phases

Recommended non-terminal phases:

```text
starting
recording
finalizing
```

Terminal task states reuse existing ResearchTube conventions, for example:

```text
completed
failed
```

A normal user-requested stop is **not an error**.

A successful early stop should finalize the video and end as:

```text
completed
```

with metadata indicating that the recording ended early/by request if useful.

Do not classify a normal graceful stop as a failed recording.

---

## 16. Progress

Camera recording must expose live progress.

At minimum status should contain:

```text
phase
progressPercent
elapsedSeconds
requestedDurationSeconds
maxDurationSeconds
```

Example:

```json
{
  "taskId": "...",
  "status": "working",
  "phase": "recording",
  "progressPercent": 41,
  "elapsedSeconds": 24.6,
  "requestedDurationSeconds": 60,
  "maxDurationSeconds": 60
}
```

Progress may be based on monotonic elapsed recording time rather than parsing every FFmpeg output line.

Requirements:

- progress must visibly advance during recording;
- do not flood the MCP response or Agent console with per-frame updates;
- terminal successful completion reports `progressPercent = 100`;
- the final result should include the actual recorded duration.

---

## 17. media_camera_record_status

### Input

```json
{
  "taskId": "..."
}
```

### Working result

```json
{
  "taskId": "...",
  "status": "working",
  "phase": "recording",
  "progressPercent": 41,
  "elapsedSeconds": 24.6,
  "requestedDurationSeconds": 60,
  "maxDurationSeconds": 60
}
```

### Completed result

```json
{
  "taskId": "...",
  "status": "completed",
  "phase": "completed",
  "progressPercent": 100,
  "result": {
    "filePath": "captures/camera/camera_recording_...mp4",
    "format": "mp4",
    "width": 1920,
    "height": 1080,
    "durationSeconds": 24.8
  }
}
```

No physical host paths.

---

## 18. media_camera_record_stop

### Purpose

Gracefully stop an active camera recording before its automatic end time while preserving a valid playable video.

### Input

```json
{
  "taskId": "..."
}
```

### Behaviour

The Agent should request graceful FFmpeg termination so FFmpeg can finalize the MP4 container.

Use the safest platform-appropriate graceful mechanism supported by the current subprocess implementation.

Do not immediately hard-kill FFmpeg as the normal stop path.

Recommended logic:

1. mark the task as stopping/finalizing;
2. send graceful termination request;
3. wait for FFmpeg to finish container finalization;
4. validate successful process exit/output;
5. publish the final workspace file;
6. mark task `completed`.

If graceful termination fails:

- use a bounded fallback;
- if a usable final file cannot be guaranteed, mark the task failed;
- do not report a corrupt/incomplete MP4 as success.

### Idempotence

If a stop request arrives after the task is already terminal, return the current terminal state rather than starting another operation.

---

## 19. Camera use conflicts

A physical camera may not support multiple simultaneous opens.

ResearchTube should not impose a global camera scheduler across unrelated devices.

However, if the same camera cannot be opened because it is already in use by:

- another ResearchTube task;
- another application;
- the operating system;

return a clear structured error.

Do not hide the failure by silently switching to another camera.

Possible code:

```text
CAMERA_BUSY
```

If a platform/device supports simultaneous access naturally, ResearchTube does not need to prohibit it globally.

---

## 20. Structured errors

Expected camera failures should use explicit structured errors.

Recommended codes:

```text
CAMERA_NOT_FOUND
CAMERA_UNAVAILABLE
CAMERA_BUSY
CAMERA_PERMISSION_DENIED
CAMERA_CAPABILITIES_UNAVAILABLE
CAMERA_OPEN_FAILED
CAMERA_CAPTURE_FAILED
CAMERA_RECORD_FAILED
CAMERA_RECORD_STOP_FAILED
CAMERA_DURATION_INVALID
FFMPEG_NOT_AVAILABLE
TASK_NOT_FOUND
```

Do not leak native identifiers or physical paths in MCP error messages.

The local Agent console may contain more detailed diagnostic information.

---

## 21. FFmpeg availability

Camera tools depend on the existing ResearchTube FFmpeg component discovery.

Use the existing component resolution policy:

```text
ResearchTube-local FFmpeg
        ↓
system PATH
        ↓
missing
```

If FFmpeg is unavailable:

- `media_camera_list` may return a structured dependency error rather than pretending there are no cameras;
- capture/record tools return `FFMPEG_NOT_AVAILABLE`;
- unrelated ResearchTube tools continue to work.

Do not add a separate camera-specific FFmpeg installation.

---

## 22. Privacy and path exposure

Normal MCP responses must never expose:

- ResearchTube installation path;
- workspace physical path;
- FFmpeg executable path;
- native camera device path;
- DirectShow alternative name/PnP identifier;
- AVFoundation UID/serial;
- Linux `/dev/video*` node;
- raw FFmpeg command line.

The LLM receives only safe logical values such as:

```text
cameraId
camera display name
resolution
fps
workspace-relative output path
taskId
progress/status
```

---

## 23. Workspace contract

All camera output is written through the existing ResearchTube workspace rules.

Returned paths always use ResearchTube logical POSIX notation:

```text
captures/camera/frame_20260923_174812.png
captures/camera/camera_recording_...mp4
```

Never return:

```text
C:\ResearchTube\workspace\...
/home/user/ResearchTube/workspace/...
/Users/user/ResearchTube/workspace/...
```

Camera tools must reuse the centralized workspace resolver rather than implementing their own path rules.

---

## 24. Agent process model

All FFmpeg camera operations are launched without shell interpolation.

Use argument arrays, not a concatenated shell command.

Do not use:

```text
shell=True
```

with untrusted values.

Recording must use an asynchronous subprocess so the Agent remains responsive to:

- status polling;
- stop requests;
- Agent health calls;
- unrelated ResearchTube tools;
- other independent tasks.

---

## 25. Console logging

Keep camera logging concise.

Examples:

```text
[17:48:01] media_camera_list -> 2 cameras
[17:48:12] media_camera_capture_frame camera=camera_7f2a91c4 -> completed
[17:49:02] media_camera_record_video task=AbCd... camera=camera_7f2a91c4 started
[17:49:23] media_camera_record_video task=AbCd... stop requested
[17:49:24] media_camera_record_video task=AbCd... completed duration=21.7s
```

Do not print per-frame progress.

Physical/native identifiers should appear in console diagnostics only when genuinely useful for troubleshooting and must never be echoed into MCP responses.

---

## 26. Out of scope

Do not implement in this iteration:

- microphone/audio recording;
- camera settings UI;
- brightness/contrast/exposure controls;
- manual resolution selection;
- manual FPS selection;
- manual codec/bitrate selection;
- zoom/focus/PTZ control;
- continuous live stream to ChatGPT;
- RTSP/IP-camera support;
- virtual camera creation;
- motion detection;
- face recognition;
- OpenCV;
- recordings longer than 60 seconds.

These can be added later if required.

---

## 27. Required tests

### Test A — camera listing

With at least one camera connected:

1. call `media_camera_list`;
2. verify each camera has `cameraId` and human-readable `name`;
3. verify selected/max resolution metadata is present where probing succeeds;
4. verify no native device path/UID/PnP identifier leaks into MCP.

### Test B — duplicate names

If practical, simulate or attach two same-name cameras.

Verify distinct `cameraId` values.

### Test C — frame capture

1. choose a `cameraId`;
2. call `media_camera_capture_frame`;
3. verify one PNG is created;
4. verify returned path is workspace-relative;
5. verify the dimensions equal the selected maximum camera resolution;
6. verify no host path is returned.

### Test D — 60-second recording

1. call `media_camera_record_video` with 60 seconds;
2. verify a taskId is returned quickly;
3. poll `media_camera_record_status`;
4. verify phase transitions;
5. verify `progressPercent` changes during recording;
6. verify automatic finalization by 60 seconds;
7. verify one playable workspace-relative MP4 result;
8. verify actual result dimensions equal the selected maximum camera resolution.

### Test E — short requested recording

Start a 10-second recording.

Verify it finalizes normally at approximately the requested duration.

### Test F — manual stop

1. start a 60-second recording;
2. wait until recording is active;
3. call `media_camera_record_stop`;
4. verify status changes to finalizing;
5. verify task finishes `completed`;
6. verify the MP4 is playable;
7. verify result duration is shorter than 60 seconds.

### Test G — Agent responsiveness

While recording:

- call `media_camera_record_status`;
- call `researchtube_agent_status`;
- call an unrelated short ResearchTube tool.

Verify recording does not block the Agent.

### Test H — unavailable camera

Disconnect a listed camera or use an expired cameraId.

Verify a structured `CAMERA_NOT_FOUND` or `CAMERA_UNAVAILABLE` result.

### Test I — camera busy

Hold the camera open in another application where the platform prevents shared access.

Verify a structured `CAMERA_BUSY`/open error and no silent fallback to another device.

### Test J — permission denied

Where practical, deny camera permission at OS level.

Verify `CAMERA_PERMISSION_DENIED` or the nearest accurate structured error.

### Test K — FFmpeg unavailable

Run without local or PATH FFmpeg.

Verify camera tools fail cleanly with `FFMPEG_NOT_AVAILABLE` and unrelated tools still work.

### Test L — privacy

Inspect every MCP result from all camera tools.

Verify absence of:

- native camera path;
- PnP/alternative name;
- AVFoundation UID/serial;
- `/dev/video*`;
- physical workspace path;
- FFmpeg executable path;
- raw command line.

---

## 28. Acceptance criteria

Camera support is complete when:

- all camera tool names begin with `media_camera_`;
- `media_camera_list` enumerates available cameras;
- each camera has an opaque logical `cameraId`;
- human-readable camera names are returned;
- duplicate names can still be distinguished;
- FFmpeg is the capture backend;
- Windows dshow, Linux v4l2, and macOS avfoundation are supported by the abstraction;
- frame capture saves a PNG at the maximum available native resolution;
- video recording uses the maximum available native resolution;
- no resolution/FPS/codec controls are exposed to the MCP caller;
- recordings are limited to at most 60 seconds;
- recording is a long-running task;
- recording progress/status is observable;
- recording can be stopped gracefully;
- an early stop produces a finalized playable video when successful;
- video result is one workspace-relative MP4;
- camera output never exposes physical host paths or native device identifiers;
- all camera subprocesses are asynchronous/no-shell;
- Agent remains responsive during recording;
- no OpenCV dependency is added.

---

## 29. Implementation guidance

Before coding:

1. read `docs/ARCHITECTURE.md`;
2. inspect the current Agent TaskManager and workspace APIs;
3. reuse the existing FFmpeg component discovery;
4. reuse the existing taskId format rather than inventing a camera-specific ID;
5. reuse the centralized workspace path/output handling;
6. inspect the current media tool naming and response conventions;
7. report any architectural conflict before creating a parallel mechanism.

The implementation should add a camera adapter layer around FFmpeg, not a second independent media architecture.

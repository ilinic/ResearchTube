# Workspace media viewer

`media_show` deliberately displays one supported Workspace image, video or audio file inside the ChatGPT conversation.

## Why an Extension-owned viewer exists

ChatGPT's MCP widget iframe can be isolated by CSP and may be unable to reach `127.0.0.1`. Large video cannot be moved through MCP metadata or encoded as base64.

ResearchTube therefore separates responsibilities:

- MCP widget: establishes the exact place in the conversation;
- content script: identifies that iframe by `event.source`;
- Extension viewer: displays images and native audio/video controls;
- Extension service worker: streams audio/video through an Extension-origin URL with loopback host permissions;
- Agent: serves bytes and one HTTP byte range per request.

The original widget remains the layout anchor. The Extension overlays `media-viewer.html` without moving it elsewhere in the conversation.

## Public flow

1. The caller passes a logical Workspace path to `media_show`.
2. The Extension asks the Agent for bounded media metadata.
3. A widget anchor is returned through MCP.
4. The widget announces a view ID and verified metadata.
5. The ChatGPT content script finds the exact source iframe.
6. Images are fetched by the viewer into a local Blob. Audio/video request an Extension-origin URL; its worker forwards the original readable Agent response without collecting a complete file.
7. Image load or native audio/video metadata readiness is acknowledged immediately, without waiting for a paint callback in the initially hidden iframe.

MCP results contain no image bytes, loopback URL or physical host path.

## Supported behavior

- Images display at their verified dimensions within responsive bounds.
- Video and audio use native controls and Range requests for seeking. Playback is user initiated; display never starts audio automatically.
- The handshake retries once per second and uses the configured ten-second default deadline for all three kinds. Refresh/Retry keeps the exact originating widget slot.
- Audio/video use no whole-file Blob, base64 or transcoding. A native unsupported-codec error is shown rather than claiming playback succeeded.
- `Refresh media` reloads the logical file without changing the conversation anchor.
- `Copy workspace path` copies only the logical Workspace path.
- Strict filename tags can provide a canonical YouTube link or camera provenance without exposing local paths.

## Security

The viewer accepts only normalized metadata from the Extension. The Agent resolves the requested logical path again and serves supported media types from Workspace. Copy and refresh are explicit user actions. Public tunnels are not started by display.

The primary sources are `extension/chatgpt-image-viewer-bridge.js`, `extension/media-stream.js`, `extension/media-viewer.html`, the widget template in `extension/ui/`, and Agent media-serving routes.

The stream route accepts only GET/HEAD from the packaged Extension viewer. It validates Workspace metadata again, forwards one Range header and preserves content type, length, Accept-Ranges and Content-Range with HTTP 200/206/416. It does not expose arbitrary Agent API endpoints or caller-provided URLs. The original stream supplies backpressure and cancellation; the worker keeps no file-byte cache or media URL map. Packaged scripts and other Extension resources fall through unchanged.

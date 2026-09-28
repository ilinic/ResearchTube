# Workspace media viewer

`media_image_show` deliberately displays one supported Workspace image, video or audio file inside the ChatGPT conversation.

## Why an Extension-owned viewer exists

ChatGPT's MCP widget iframe can be isolated by CSP and may be unable to reach `127.0.0.1`. Large video cannot be moved through MCP metadata or encoded as base64.

ResearchTube therefore separates responsibilities:

- MCP widget: establishes the exact place in the conversation;
- content script: identifies that iframe by `event.source`;
- Extension viewer: loads local media with Extension host permissions;
- Agent: serves bytes and one HTTP byte range per request.

The original widget remains the layout anchor. The Extension overlays `media-viewer.html` without moving it elsewhere in the conversation.

## Public flow

1. The caller passes a logical Workspace path to `media_image_show`.
2. The Extension asks the Agent for bounded media metadata.
3. A widget anchor is returned through MCP.
4. The widget announces a view ID and verified metadata.
5. The ChatGPT content script finds the exact source iframe.
6. The Extension-owned viewer loads media from loopback.

MCP results contain no image bytes, loopback URL or physical host path.

## Supported behavior

- Images display at their verified dimensions within responsive bounds.
- Video and audio use native controls and Range requests for seeking.
- `Refresh media` reloads the logical file without changing the conversation anchor.
- `Copy workspace path` copies only the logical Workspace path.
- Strict filename tags can provide a canonical YouTube link or camera provenance without exposing local paths.

## Security

The viewer accepts only normalized metadata from the Extension. The Agent resolves the requested logical path again and serves supported media types from Workspace. Copy and refresh are explicit user actions. Public tunnels are not started by display.

The primary sources are `extension/chatgpt-capture-frame-bridge.js`, `extension/media-viewer.html`, the widget template in `extension/ui/`, and Agent media-serving routes.

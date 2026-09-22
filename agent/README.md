# ResearchTube Local Agent

This Python service owns the local workspace, media tools, and the loopback API used by the ResearchTube extension. Its API binds only to `127.0.0.1`.

Run it with Python 3.10 or later:

```bash
python researchtube_agent.py
```

It reads `agent-config.json` from this directory and defaults to port `17843`. Change the JSON port or use a one-run override:

```bash
python researchtube_agent.py --port 17843
```

The Agent creates `workspace/` beside the script. Health reports the Agent version, workspace state, and status, version, and discovery source for `yt-dlp`, `deno`, `ffmpeg`, `ffprobe`, and `cloudflared`. Discovery always checks `tools/<component>/` first, then system `PATH`; it never depends on the process working directory.

`capture_screen` uses the bundled or PATH `ffmpeg` as its sole pixel-capture implementation: `gdigrab` on Windows, `x11grab` on Linux/X11, and `avfoundation` on macOS. No Python screen-capture package or PowerShell is used. It captures the complete virtual desktop into one workspace image, including all monitors. Linux/X11 also needs `xrandr` to report the virtual-desktop geometry and monitor count. Linux Wayland is intentionally not supported; it requires a separate Portal/PipeWire implementation. On macOS, grant Screen Recording permission to the FFmpeg process.

`media_image_crop` cuts one rectangular pixel area from an existing PNG, JPEG, or WebP file inside the workspace and writes a separate PNG, JPEG, or WebP file. It never modifies the source or overwrites an existing output.

On Windows, `clipboard_status`, `clipboard_get`, and `clipboard_set` provide explicit local clipboard access for text and images. Status does not read text or save images; get returns text or creates one normalized PNG under `workspace/clipboard/`; set writes Unicode text or decoded image pixels, never a file reference. A stale `clipboard_get` revision is reported to the Extension as `CLIPBOARD_CHANGED` without reading clipboard contents; the MCP contract maps this expected race to a structured `clipboard_changed` state result. Clipboard contents are never logged or retained. These tools enforce a 2 MiB text limit, a 20 MiB source-image-file limit, and a 50-megapixel decoded-image limit. `media_inspect_image` independently validates a workspace PNG/JPEG/WebP and returns bounded format, dimensions, and size metadata without returning image bytes. The workspace-image widget serves one requested image directly from the loopback Agent at `/<logical-workspace-path>`; it never starts a public tunnel or exposes a host path.

`cloudflared` is optional and is never started with the Agent or by `capture_frame`. Put it in `tools/cloudflared/` (or install it on `PATH`) only when calling `workspace_share_start`. That tool is for temporary external download access by an ordinary browser or HTTP client. A Cloudflare Quick Tunnel URL may be unavailable to ChatGPT or may not become visual input, so it is not reliable for image inspection or analysis. Use `library_store_start` for a workspace image that ChatGPT needs to receive reliably. The URL path repeats the selected logical folder directly, without an artificial `/files/` segment: `captures/frame.png` is published as `/captures/frame.png`. It serves only allowed file categories and only `GET` or `HEAD`; directory listings, workspace escapes, and filesystem redirects are rejected. `workspace_share_status` reports the active share and `workspace_share_stop` closes it. The Agent API itself is never tunneled.

The console emits compact timestamped startup information and one line for each top-level request, for example `GET /health -> 200`. The extension may be used with the Agent stopped; its YouTube tools remain independent.

`system_check_debug_banner` is a separate, on-demand diagnostic rather than part of the normal Agent status. On Windows it checks the current Chrome browser instances for `--silent-debugger-extension-api`, the switch that suppresses Chrome's debugger banner during ResearchTube's automatic file attachment. It returns only an aggregate configuration (`banner_suppressed`, `banner_enabled`, `mixed`, or `unknown`) and never exposes process IDs, command lines, profiles, or local paths.

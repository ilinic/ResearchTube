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

`cloudflared` is optional and is never started with the Agent or by `capture_frame`. Put it in `tools/cloudflared/` (or install it on `PATH`) only when calling `workspace_share_start`. That explicit tool publishes one selected workspace folder through a Cloudflare Quick Tunnel. The URL path repeats the selected logical folder directly, without an artificial `/files/` segment: `captures/frame.png` is published as `/captures/frame.png`. It serves only allowed file categories and only `GET` or `HEAD`; directory listings, workspace escapes, and filesystem redirects are rejected. `workspace_share_status` reports the active share and `workspace_share_stop` closes it. The Agent API itself is never tunneled.

The console emits compact timestamped startup information and one line for each top-level request, for example `GET /health -> 200`. The extension may be used with the Agent stopped; its YouTube tools remain independent.

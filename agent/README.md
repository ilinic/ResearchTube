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

For public captured-frame URLs, put the `cloudflared` binary in `tools/cloudflared/` (or install it on `PATH`). The Agent starts a separate image-only server on an automatically selected loopback port and exposes only that server through a Cloudflare Quick Tunnel. It never tunnels the Agent API. The hostname is random for each Agent run, and `capture_frame` returns an HTTPS URL whose path is the workspace directory plus an opaque capture ID.

That public server also returns `/robots.txt` permitting `OAI-SearchBot` and other crawlers; apart from that file, it serves only approved captured-image URLs.

The console emits compact timestamped startup information and one line for each top-level request, for example `GET /health -> 200`. The extension may be used with the Agent stopped; its YouTube tools remain independent.

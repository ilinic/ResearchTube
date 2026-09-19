# ResearchTube Local Agent — Iteration 1

This standard-library Python service is optional. It binds only to `127.0.0.1` and exposes only `GET /health`; no downloads, Tasks, media processing, or workspace file tools are implemented in this iteration.

Run it with Python 3.10 or later:

```bash
python researchtube_agent.py
```

It reads `agent-config.json` from this directory and defaults to port `17843`. Change the JSON port or use a one-run override:

```bash
python researchtube_agent.py --port 17843
```

The first health request creates `workspace/` beside the script. Health reports the Agent version, workspace state, and status, version, discovery source, and resolved path for optional `yt-dlp`, `ffmpeg`, and `ffprobe` executables. Discovery always checks this Agent directory first, then system `PATH`; it never depends on the process working directory.

The console emits compact timestamped startup information and one line for each top-level request, for example `GET /health -> 200`. The extension may be used with the Agent stopped; its YouTube tools remain independent.

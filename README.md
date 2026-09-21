<img width="1335" height="2000" alt="2149244088" src="https://github.com/user-attachments/assets/cc471cf1-636c-4bcf-836d-25326292a085" />
# ResearchTube v1.5.1 — Local Agent refinements

This release contains two independent local components:

- `extension/` — load this directory with Chrome's **Load unpacked** command.
- `agent/` — optional Python 3.10+ Local Agent. Run `python researchtube_agent.py` from this directory, then use the **Local Agent** section in the extension Settings to test it.

The Agent is intentionally limited to `GET /health` on `127.0.0.1` and a local `workspace/` check. It reports the source and real path selected for optional `yt-dlp`, `ffmpeg`, and `ffprobe`, with local binaries taking priority over system `PATH`. It does not download media, create background Tasks, process files, or change how the existing YouTube tools work.

For the detailed MCP and health contracts, see `extension/docs/ARCHITECTURE.md`.

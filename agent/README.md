# ResearchTube Local Agent

The Local Agent is an asyncio service bound only to `127.0.0.1`. Each platform release ZIP includes matching FFmpeg/ffprobe, yt-dlp, Deno and cloudflared binaries with Python Agent sources for Python 3.10+. The Windows archive also includes `ResearchTubeAgent.exe`, which does not need a separate Python installation. It owns the path-safe Workspace, executable discovery, media processing, local downloads, speech callbacks and byte-range media serving used by the Chrome Extension.

On Windows, open `ResearchTubeAgent.exe` from the fully extracted release. It runs in the system tray using the Extension's ResearchTube icon. Click the icon to open the live log; closing the log keeps the Agent running. **Copy log** copies selected text when present, otherwise the full retained log. The tray menu also offers **Open Workspace** and **Exit**. Logs are retained in `agent/logs/agent.log` with bounded rotation. A second launch on the same port does not start another Agent.

For source mode on Windows, install the dependencies once from this directory:

```sh
python -m pip install -r requirements-windows.txt
```

Then open `researchtube_agent.pyw` without a terminal, or run `python researchtube_agent.py` to launch the background process. Python must include Tcl/Tk. For the traditional terminal mode, use:

```sh
python researchtube_agent.py --console
```

On Linux/macOS, use `python3 researchtube_agent.py` and keep the terminal open. Tray mode currently targets Windows. Both modes use the same external `agent-config.json`, `tools/` and `custom-tools/` beside the script or EXE. The default port is `17843`.

`workspacePath.value` defaults to `workspace` beside the Agent. Startup never asks for a folder; it creates a missing directory and preserves existing files. Missing/blank legacy values also use the default. To select another drive, edit the config (for example `D:/ResearchTubeWorkspace`) and restart. Relative paths resolve beside the Agent, regardless of the terminal directory. Changing the path does not move files. Preserve your Workspace and config during upgrades.

The Windows EXE includes tray, Chrome-process inspection and speech dependencies. Chrome flags are checked once at startup; restart after changing Chrome's launch command. Unreadable process arguments report **Unknown**, not **Disabled**. Build the Windows ZIP on Windows using [Development](../docs/DEVELOPMENT.md#packaging).

The optional `limits` object in `agent-config.json` controls `mediaCaptureFrameMaxFrames` (default 20), `mediaClipMaxSegments` (20), `cameraRecordAudioMaxMinutes` (10), `cameraRecordVideoMaxMinutes` (1), `libraryStoreMaxFiles` (5), `libraryStoreMaxFileSizeMiB` (20), `mediaToChatMaxFiles` (20), and `mediaToChatMaxFileSizeMiB` (20). Limits are read for each new request, so a restart is not needed. Count limits accept 1–100; recording minutes accept 1–1440; file size accepts 1–512 MiB. Exceeding a count or duration rejects the entire tool call with the configured maximum. Library and current-chat attachment limits are independent. Files above the applicable per-file size limit are reported in `skippedFiles`; eligible files are submitted together. If none qualify, the task fails without opening a file chooser. ChatGPT may apply its own upload restrictions to individual file types and sizes.

Canonical documentation:

- [`docs/INSTALLATION.md`](../docs/INSTALLATION.md)
- [`docs/TROUBLESHOOTING.md`](../docs/TROUBLESHOOTING.md)
- [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)
- [`docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md)
- [`docs/TOOLS.md`](../docs/TOOLS.md)

The Agent has no OpenAI credential and never binds publicly. Normal MCP responses use logical Workspace paths and do not expose executable or physical Workspace paths.

Run tests from the repository root:

```sh
python -m unittest discover -s agent/tests -p 'test_*.py'
```

`limits.completedTaskHistoryLimit` defaults to 2000 (range 1–100000), applied separately to every terminal task history, including Extension Library/current-chat records. Oldest finished records are removed; active tasks and files are preserved. Status for an evicted ID is no longer available. Agent tasks remain in memory only and disappear on restart.

`newToolsEnabledByDefault` (boolean, default true) is a developer setting used when the Extension automatically discovers a custom tool without an individual saved choice. It is not exposed in the Settings UI. Changing it does not alter existing tool choices. Each parameter is a JSON object with `value` and `comment` beside it. Edit only `value`; the Agent unwraps these objects through one configuration loader. The `limits` group contains one such object per limit. Comments are explanatory text and do not alter runtime behavior. The shipped config uses this format throughout; older flat config files must be converted or replaced.

Real timers: [`docs/features/TIMERS.md`](../docs/features/TIMERS.md). No additional Python dependencies are needed for local time zones; the IANA database is bundled in `tools/timezones/`.

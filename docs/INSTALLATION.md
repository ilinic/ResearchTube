# Installing ResearchTube

Start by connecting the public MCP server in ChatGPT, then install the Chrome Extension and optional Local Agent. Keep the extracted release directory: Chrome loads the Extension from it, and the Agent reads configuration beside its script or executable.

## Requirements

- Windows 10/11, macOS or Linux with Chrome/Chromium. The broad architecture is cross-platform, but some tools have platform limits.
- Python 3.10 or later on Linux/macOS, or when launching the Agent from source on Windows. The release's Windows EXE includes Python and needs no separate interpreter.
- Node.js is required only for development, not for a prebuilt release.
- Custom MCP access in ChatGPT, subject to your account and workspace permissions.
- ChatGPT Plus or a higher supported plan with access to private MCP connections. This installation path assumes those controls are available; account/workspace policy also applies.

The platform archive includes all runtime tools:

- FFmpeg and ffprobe: media probe, frames, maps, clips, screen and camera operations.
- yt-dlp and Deno plus the ready YouTube PO-token provider: local YouTube formats, downloads and metadata fallback.
- cloudflared: explicit temporary online sharing only.

## Connect in ChatGPT first

1. Open **ChatGPT Plugins → + → Add custom MCP server**.
2. Enter **https://rtube.win**, choose **OAuth**, sign in through Google (or the configured Microsoft provider), authorize ResearchTube and install the personal plugin.
3. Ask ResearchTube to check its connection. Account setup works before Extension or Agent installation; follow the returned setup link.
4. Download/extract the release and load its Extension as described below.
5. Return to a saved ChatGPT conversation in desktop Chrome and ask ResearchTube to connect this chat. The extension pairs automatically using the browser's existing ResearchTube sign-in, then reconnects automatically. Each chat still needs its own verified binding.

Follow the setup instructions at [rtube.win](https://rtube.win). For connection recovery, see [troubleshooting](TROUBLESHOOTING.md#public-server-connection).

## 1. Extract the complete release

Open [GitHub Releases](https://github.com/ilinic/ResearchTube/releases) and download the archive for your operating system and processor from **Assets**: Windows x64, Linux x64, macOS Apple silicon (ARM64) or macOS Intel (x64). Titles identify both the Extension and Agent versions. **Pre-release** identifies a preliminary build. Each ZIP contains the matching platform tools, Python Agent sources, Chrome Extension, documentation and demo. The Windows archive also includes the Windows Agent EXE. GitHub's automatic source archives contain repository source, not these ready-to-run platform packages.

Extract ResearchTube into a permanent directory. Do not load the Extension from inside the ZIP. Keep `extension/`, `agent/`, `docs/` and the bundled Workspace demo together. `release-info.json` records the packaged component versions and source commit.

## 2. Load the Chrome Extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Select the release's `extension/` directory, not the repository root.
5. Pin ResearchTube to the toolbar if desired.

Open the Extension popup to check the ResearchTube server and Local Agent status.

## 3. Start the Local Agent

On Windows, open `agent/ResearchTubeAgent.exe` from the extracted Windows archive. It runs in the tray with the same ResearchTube icon as the Extension. Click for the live log; closing the log keeps the server running. Right-click → **Exit** stops it. On Linux/macOS, use the Python source in the matching platform archive.

On Linux/macOS, from a terminal in the release root:

```sh
python3 agent/researchtube_agent.py
```

For Python mode on Windows, first install `python -m pip install -r agent/requirements-windows.txt`. Then open `agent/researchtube_agent.pyw` without a terminal, or run from the `agent/` directory:

```sh
python researchtube_agent.py
```

Both launch modes read the same external `agent/agent-config.json`, `tools/` and `custom-tools/` beside the script or EXE, independently of the terminal directory. The Agent binds to `127.0.0.1` and normally uses port `17843`. Before listening, it reads `workspacePath` and creates the directory if missing; startup never prompts. Add `--console` for the traditional Windows terminal mode. A second Windows launch on the same port does not start another instance.

The Agent starts listening and prints its version/interface and Workspace summary before its background diagnostics finish. Component results appear in the console as each one-time startup check completes; health initially reports `checking` for unfinished checks. Repeated status requests read the saved startup snapshot. Restart the Agent after changing tools or Chrome launch flags to refresh it. Physical paths appear only in the local log. Windows tray logs are retained with rotation in `agent/logs/agent.log`.

In Extension Settings, select **Test connection** under **Local Agent (optional)**. A successful result should show compatible Extension/Agent interface versions and component statuses.

### Choose the Workspace directory

The shipped `workspacePath.value` is `workspace`, relative to the Agent installation. Startup creates a missing folder, preserves existing files and never asks for input. Missing or blank settings in older configurations use the same default without rewriting the config. The Workspace can grow large; choose a drive with enough free space.

To change the folder, edit `workspacePath.value`. Relative paths resolve beside `researchtube_agent.py` or `ResearchTubeAgent.exe`; an absolute path selects another drive, for example `"value": "D:/ResearchTubeWorkspace"`. Forward slashes avoid JSON backslash escaping.

Restart the Agent after changing it. A missing directory is created when accessible. Existing files remain in the old location; copy/move them yourself while the Agent is stopped if you want them in the new Workspace. Tools continue using logical paths such as `downloads/video.mp4`.

## 4. Verify the included media tools

Each platform archive includes matching FFmpeg/ffprobe, yt-dlp, Deno and cloudflared executables. The Agent checks its `agent/tools/` directory first, then system `PATH`. Keep the complete extracted directory together so FFmpeg support libraries remain beside the executable. Python-mode Windows tray, Chrome checks and speech require `python -m pip install -r agent/requirements-windows.txt`; the Windows EXE includes these dependencies.

Typical bundled layouts are:

```text
agent/tools/ffmpeg/**/ffmpeg[.exe]
agent/tools/ffmpeg/**/ffprobe[.exe]
agent/tools/yt-dlp/yt-dlp[.exe]
agent/tools/deno/deno[.exe]
agent/tools/cloudflared/cloudflared[.exe]
```

The included third-party notices and FFmpeg license files are under `agent/tools/`. Do not place additional copies in these component folders; ambiguous discovery is reported instead of choosing unpredictably.

Restart the Agent after adding or replacing a component, then test the Agent again. Use `system_agent_status` in ChatGPT to verify public status without exposing installation paths.

Current yt-dlp YouTube operations also require the bundled/local BgUtils PO-token provider to report `ready`. Its tokens are generated locally per video and are not stored in configuration or exposed through MCP.

## Optional Chrome launch flag

`--silent-debugger-extension-api` hides Chrome's debugger banner during browser automation. See [where to put the Chrome flag](HELP.md#where-to-put-the-chrome-flag) for Windows shortcut Target instructions, full Chrome restart and Agent status refresh.

## 5. Verify the installation

For the public connection, verify **ResearchTube server: Connected** in the popup,
call `system_connection_status` and bind this chat with `system_connect_browser`.
Start the optional Agent for local operations and check its readiness/interface
compatibility.

To check Agent components, ask:

```text
@ResearchTube Check the ResearchTube Local Agent status and explain any unavailable components.
```

Then run the [guided demo](DEMO.md). The bundled logical Workspace path is:

```text
demo/researchtube-demo.mp4
```

## Updating

Install Extension and Agent files from the same release. Their implementation version numbers may differ, but their interface versions must match.

After replacing Extension files:

1. reload the unpacked extension in `chrome://extensions`;
2. restart the Local Agent when Agent files changed;
3. use ChatGPT's ResearchTube app management **Refresh** action so the current MCP tool schema is loaded;
4. verify with `system_agent_status`.

Never replace an existing Workspace with an empty release directory. Preserve the configured Workspace and `agent-config.json`, and back them up before moving installations. Relative paths follow the Agent directory; absolute paths keep pointing to their chosen location.

## Next steps

- [Guided demo](DEMO.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Tool reference](TOOLS.md)

Browser Agent requires Chrome 125 or later for nested iframe debugger sessions. Start it with **Study this site** in the popup; no additional host permissions or separate browser profile are needed.

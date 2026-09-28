# Installing ResearchTube

This guide installs the Chrome Extension, Local Agent and private ChatGPT MCP connection. Keep the extracted release directory: Chrome loads the Extension from it and the Agent stores the Workspace beside its script.

## Requirements

- Windows 10/11, macOS or Linux with Chrome/Chromium. The broad architecture is cross-platform, but some tools have platform limits.
- Python 3.10 or later for the Local Agent.
- Node.js is required only for development, not for a prebuilt release.
- An OpenAI Platform organisation with Secure MCP Tunnel access.
- ChatGPT access to Developer Mode and private MCP apps/connectors.

Optional local components enable additional tools:

- FFmpeg and ffprobe: media probe, frames, maps, clips, screen and camera operations.
- yt-dlp: YouTube formats, downloads and Agent-side metadata fallback.
- Deno plus a ready YouTube PO-token provider: required by current local YouTube yt-dlp operations.
- cloudflared: explicit temporary online sharing only.

## 1. Extract the complete release

Extract ResearchTube into a permanent directory. Do not load the Extension from inside the ZIP. Keep `extension/`, `agent/`, `docs/` and the bundled Workspace demo together.

## 2. Load the Chrome Extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Select the release's `extension/` directory, not the repository root.
5. Pin ResearchTube to the toolbar if desired.

Open ResearchTube **Settings** from the toolbar popup or Chrome's extension details page.

## 3. Start the Local Agent

From a terminal in the release root:

```sh
python agent/researchtube_agent.py
```

Or run it from the `agent/` directory:

```sh
python researchtube_agent.py
```

The Agent reads `agent/agent-config.json`, binds to `127.0.0.1` and normally uses port `17843`. It creates or opens `agent/workspace/`.

The startup summary reports Workspace health, interface version and every discovered component. Physical paths appear only in this local console.

In Extension Settings, select **Test connection** in the Local Agent section. A successful result should show compatible Extension/Agent interface versions and component statuses.

## 4. Install optional media components

The Agent searches its dedicated folder first, then system `PATH`.

Typical bundled layouts are:

```text
agent/tools/ffmpeg/.../bin/ffmpeg.exe
agent/tools/ffmpeg/.../bin/ffprobe.exe
agent/tools/yt-dlp/yt-dlp.exe
agent/tools/deno/deno.exe
agent/tools/cloudflared/cloudflared.exe
```

Do not leave an unextracted archive in a tool directory. Do not place multiple candidate executables in one dedicated component tree; ambiguous discovery is reported as an error rather than choosing unpredictably.

Restart the Agent after adding or replacing a component, then test the Agent again. Use `system_agent_status` in ChatGPT to verify public status without exposing installation paths.

Current yt-dlp YouTube operations also require the bundled/local BgUtils PO-token provider to report `ready`. Its tokens are generated locally per video and are not stored in configuration or exposed through MCP.

## 5. Create the Secure MCP Tunnel connection

Use the official OpenAI Platform tunnel page opened by ResearchTube Settings.

1. Create or choose a Secure MCP Tunnel.
2. Copy its identifier beginning with `tunnel_`.
3. Create a separate restricted OpenAI API key.
4. Grant only the tunnel permissions ResearchTube Settings requests, normally **Tunnels: Read + Use**.
5. Paste the Tunnel ID and key into ResearchTube Settings.
6. Select **Save and test connection**.

Do not use an organisation-owner, administrator or unrestricted key. The key is stored in local Chrome extension storage and is sent only to OpenAI's tunnel control plane.

## 6. Add ResearchTube to ChatGPT

1. Enable ChatGPT Developer Mode if it is not already enabled.
2. Open the area used to add private apps/connectors/plugins.
3. Add the Secure MCP Tunnel using the same Tunnel ID.
4. Name the app **ResearchTube**.
5. Open a new conversation and select or mention ResearchTube.

ChatGPT's interface labels can change. The essential operation is adding the private MCP connection backed by the configured Tunnel ID.

## 7. Verify the installation

Ask:

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

Never replace `agent/workspace/` with an empty release directory when it already contains user data. Back it up before moving installations.

## Next steps

- [Guided demo](DEMO.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Tool reference](TOOLS.md)

# ResearchTube user help

This is the starting guide for installation, everyday use and troubleshooting. Click **Help** between **Settings** and **Support** in the Extension popup to open a new ChatGPT conversation with this guide. Ask your questions there in your own language. Help does not require a configured ResearchTube tunnel or a running Local Agent; Chrome and a signed-in ChatGPT session are enough to start it.

## For the assisting ChatGPT

Read this guide first, then open only the linked reference relevant to the user's question. Give short, concrete steps in the user's language. Ask what they need help with instead of immediately reciting the installation procedure. If the source cannot be read, say so and ask for the relevant section; do not claim to have studied it. GitHub's **Raw** button provides the Markdown text if the normal page cannot be read.

When diagnosing a failure, establish which layer failed: Chrome Extension, OpenAI tunnel/ChatGPT connection, Local Agent, component, or one task. If ResearchTube tools are available and the user wants diagnosis, `system_agent_status` supplies public readiness information. If tools are absent, use the user's Settings/popup result instead. Do not call media-creation tools merely to answer a setup question. Label actions the user must do locally. Never ask for API keys, Tunnel IDs, cookies, signed URLs, complete browser profiles or unredacted logs.

## What ResearchTube does

ResearchTube connects ChatGPT to public YouTube research, local media tools and controlled website study. You make ordinary requests; ChatGPT chooses tools and explains results.

| Part | What it does | When needed |
| --- | --- | --- |
| Chrome Extension | Publishes the MCP tools, runs the private OpenAI tunnel connection, reads YouTube and controls browser tasks | Keep Chrome open and the Extension enabled when using tools |
| OpenAI Secure MCP Tunnel | Connects ChatGPT to the Extension without opening an inbound port | Required for ChatGPT to call ResearchTube tools |
| Local Agent | Windows EXE or Python process serving local media tools and Workspace on `127.0.0.1`, normally port `17843` | Required for downloads, local files/media and other Agent-backed operations |
| Workspace | Local files in the configured directory, default `agent/workspace/` | Use logical paths such as `downloads/example.mp4` in chat |

Browser-based YouTube research works with the Agent stopped. Local media requires it. Reading this Help guide needs neither. OpenAI Secure MCP Tunnel and optional cloudflared online sharing are different features; cloudflared is not needed to connect ResearchTube to ChatGPT.

## First installation

### 1. Check requirements

- Chrome/Chromium on Windows, macOS or Linux; **Study this site** needs Chrome 125 or newer for nested iframe support.
- This private-connection setup assumes **ChatGPT Plus or higher**, with access to private MCP connections. Account/workspace permissions also matter; a subscription alone does not guarantee that the controls are available.
- An OpenAI Platform account/organization allowed to create/use Secure MCP Tunnels. ChatGPT subscription settings and Platform tunnel permissions are separate.
- Python 3.10 or newer for source-mode Agent on Linux/macOS or Windows. The Windows archive includes an EXE with Python inside; every platform archive includes matching runtime tools. Node.js is needed for development, not a prebuilt release.

Windows-only operations include the built-in clipboard, desktop capture and Windows speech engine. Some camera/media capabilities depend on the platform and installed components; inspect status before assuming support.

### 2. Extract and load the Extension

Download the matching platform archive under **Assets** on [GitHub Releases](https://github.com/ilinic/ResearchTube/releases): Windows x64, Linux x64, macOS Apple silicon (ARM64) or macOS Intel (x64). Each archive includes its matching FFmpeg/ffprobe, yt-dlp, Deno and cloudflared binaries; the Windows archive also includes the Agent EXE. Release titles list the Extension and Agent versions. Preliminary builds are marked **Pre-release**.

1. Download the [ResearchTube release](https://github.com/ilinic/ResearchTube/releases) for your platform and extract it to a permanent folder. Keep the `extension/`, `agent/` and `docs/` directories. Do not run from inside the ZIP or delete/move that folder afterwards.
2. Open `chrome://extensions` in Chrome's address bar.
3. Turn on Chrome's **Developer mode** at the top of that page.
4. Click **Load unpacked** and select the `extension/` folder, not the release root.
5. Pin ResearchTube using Chrome's Extensions menu. Open its popup, then **Settings**.

### 3. Set up the OpenAI connection

1. Use Settings' **OpenAI Tunnels** link to [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels). Create/select a tunnel in the intended organization. Creation requires **Tunnels Read + Manage**; runtime use needs **Read + Use**. Associate it with the ChatGPT workspace that should use it.
2. In [OpenAI API Keys](https://platform.openai.com/settings/organization/api-keys), create a dedicated **Restricted** runtime key with **Tunnels Read + Use**. Keep management permissions on your account, not the Extension runtime key.
3. Paste the key and the `tunnel_...` identifier into ResearchTube **Settings**. Click **Save and test connection**. Enter them only in the Settings fields, never in a chat or bug report.

ResearchTube's Extension performs the tunnel connection itself. You do not need to install/run a separate `tunnel-client`, expose the Agent on the internet, forward router ports or set up cloudflared for this connection. See [installation](INSTALLATION.md) and OpenAI's [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

**Save and test connection** first saves both fields exactly as entered, trimming surrounding whitespace, then tests those saved values. An unsuccessful test does not undo the save. The saved key appears masked in the password field; clearing the field and saving removes the key. Clearing the Tunnel ID and saving removes the ID.

To test first-time setup or Help, clear **both** fields and click **Save and test connection**. A missing-settings result is expected: the values are already cleared, and the popup shows **Not configured**. Help still works. This resets the tunnel connection without removing the Local Agent, Workspace or tool preferences. Restore your ID and key in Settings when finished.

The popup's tunnel row updates when saved settings or connection results change. **API key missing** and **Tunnel ID missing** identify incomplete settings; **Not tested** means both values are present but no connection has been confirmed. Green means the latest tunnel request succeeded. A rejected key, unavailable tunnel or network failure appears as an error instead of retaining a green ID. Editing fields takes effect when you save.

### 4. Create the ResearchTube connection in ChatGPT

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins). Choose **+ → Add custom MCP server** (older interfaces may say **Create app/connector**).
2. Name it **ResearchTube** and upload `icons/researchtube-64.png` from the extracted ResearchTube folder as the plugin icon. Choose **Tunnel** under **Connection**. Select/paste the same tunnel identifier used in Extension Settings.
3. ResearchTube's tunnel runtime key belongs in the Extension, not this form. Where server authentication is requested, use **No authentication**: ResearchTube does not provide a separate OAuth login. Review the connection notice and create/install the private connection.
4. Start a new chat, type `@`, and select **ResearchTube**, or enable it in the chat's tools menu. Try a simple request such as `@ResearchTube Search YouTube for recent videos about quantum computing and summarize their main ideas.`

If **Add custom MCP server** is missing, check your plan, signed-in account and workspace permissions. Some interfaces still require enabling **Developer Mode** in ChatGPT Settings before showing this control. If a tunnel is missing from the selector, check its workspace association and your **Read + Use** permissions. Do not substitute a public URL or paste the runtime key into chat. Interface labels change; consult OpenAI's [connection guide](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt/) when labels differ.

### 5. Start the Local Agent when needed

Open a terminal in the extracted release root and run:

```sh
python agent/researchtube_agent.py
```

On Windows, simply open `agent/ResearchTubeAgent.exe` from the fully extracted Windows archive; no separate Python is needed. `py agent/researchtube_agent.py` is an alternative with Python installed; on Linux/macOS use `python3`. Keep the console open. In Extension **Settings → Local Agent**, select **Test connection**. The default port is `17843`; the Agent configuration and Extension must use the same port. Implementation versions may differ; **interface versions must match**.

The Agent checks components once at startup. `Checking…` means a startup check is still running. Restart it after changing components or Chrome launch flags; pressing Test connection reads the saved status and does not repeat the checks.

The Agent first reads `workspacePath.value` in `agent/agent-config.json`. If empty, it asks for a folder and shows the absolute default beside the Agent in square brackets. Press **Enter** to accept `workspace`, or type another path. It saves the choice, creates a missing folder and preserves existing files. Later launches do not ask again. Relative paths resolve beside the script or EXE; an absolute path such as `D:/ResearchTubeWorkspace` selects another location. You can edit the config directly and restart; use forward slashes in JSON or escape backslashes. Changing location does not move files. Chat tools use logical paths, and do not need your computer's physical path. See [Workspace directory setup](INSTALLATION.md#choose-the-workspace-directory).

| Component | Enables |
| --- | --- |
| FFmpeg + ffprobe | Media information, frames, maps, clips and supported capture/recording tools |
| yt-dlp + Deno + ready PO-token provider | Local YouTube downloads/formats and Agent-side fallbacks |
| cloudflared | Explicit temporary online file/folder sharing only |

Use bundled component locations under `agent/tools/` or system `PATH`. Extract archives before use. Missing optional components do not mean all ResearchTube features are broken. See [component installation](INSTALLATION.md#4-install-optional-media-components).

## Where to put the Chrome flag

`--silent-debugger-extension-api` is **optional**: it hides Chrome's debugging banner during Extension automation. A popup status of **Disabled** here does not mean the tunnel or Agent is broken.

On Windows:

1. Right-click the shortcut you use to launch Chrome. For a taskbar icon, right-click it, then right-click **Google Chrome** in the menu and choose **Properties**.
2. Open **Shortcut → Target**. Keep the existing executable path and its quotes unchanged. Append one space followed by `--silent-debugger-extension-api` **after** the closing quote.
3. Example shape: `"<existing path to chrome.exe>" --silent-debugger-extension-api`. The placeholder means your existing path; do not replace your actual Target with it.
4. Click **Apply**, exit Chrome completely, and reopen it using that shortcut. Chrome background processes must also exit; an already running instance can retain its original switches.
5. Restart the Local Agent to refresh its Chrome check. **Enabled** confirms its saved diagnostic; **Mixed** can mean Chrome instances were launched differently.

This flag is not a `chrome://flags` option, not an Extension setting and not a remote-debugging port. On other platforms, append the same switch to your normal Chrome launch command; use your platform's launcher instructions rather than Windows shortcut steps.

## Everyday use and tool families

The [tool reference](TOOLS.md) contains the full current inventory. Tool schemas in the connected catalog define exact parameters. You normally describe the result you want instead of naming tools.

| Goal | Tool families / example |
| --- | --- |
| Search/read YouTube | `youtube_search`, video metadata, transcripts, comments, channels and playlists. Ask for sources, relevant transcripts and a summary. |
| Download videos/audio | `youtube_download_get_formats`, `youtube_download` and task status/cancel. Specify whole video or intervals and desired audio/video. |
| Preview a video's timeline | `youtube_storyboard_*` downloads ready-made image sheets; `visual_map_*` creates maps from video. |
| Inspect/edit local media | `media_probe`, frame capture, `media_image_crop`, `media_clip`, `media_show`. Request desired frames or ordered intervals using a Workspace file. |
| Capture or record | Screen/region capture, `camera_*`, and Windows clipboard tools. Request these explicitly. |
| Read text aloud | `system_speech_*`: Google Translate by default or Windows voices; speakers, saved file, or both. |
| Manage/share files | `workspace_*`, `media_to_chat`, `library_store_*`, `online_share_*`. Sending/sharing is deliberate, not automatic for every saved file. |
| Timers | `timer_start/status/cancel` for real durations or deadlines. |
| Study a website | **Study this site** in the popup; `site_*` tools operate its dedicated session. |
| Custom Tools | Trusted Python packages; bundled **Count Words Example** and **Wait Asynchronous Task Example** demonstrate sync/task execution. |

Use logical Workspace paths such as `downloads/example.mp4`, never your physical disk path. Long operations return a task ID and progress; ChatGPT should check the matching status tool no faster than its `pollIntervalMs`. Cancellation preserves completed files and cannot undo a message already sent. Creation normally saves files; `media_show` displays them and supported `addToChat:true` requests attachment/Send. See [artifact tasks](features/ARTIFACT_TASKS.md).

On a YouTube video or Short, the popup offers **Describe this video**. On other pages it offers **Study this site**, opening a controlled copy and a dedicated chat. Keep both session tabs open. Closing either stops the session; closing the original source tab does not. Text/tree data alone is not visual input: selected images must be downloaded and attached using `site_get_images`; other observed downloadable items use `site_get_files`. Empty-alt images and CSS backgrounds can be discovered when visible in the controlled page's viewport. Scroll and read again when needed. See [Browser Agent](features/BROWSER_AGENT.md).

## Common problems: start here

| Symptom | First checks / action |
| --- | --- |
| Extension missing | `chrome://extensions`: enabled, correct `extension/` folder, no load errors. Keep the extracted installation folder. |
| ResearchTube absent from ChatGPT | Test tunnel in Settings; verify permission to add custom MCP servers, correct workspace and same tunnel; create/install the private connection and select it in a new chat. |
| Tunnel test fails | `API_KEY_INVALID`: check/create the restricted key in Settings. `TUNNEL_PERMISSION_DENIED`: check runtime Read + Use. `TUNNEL_NOT_FOUND`: verify ID and organization. `NETWORK_ERROR`: check connectivity/proxy. |
| Agent unavailable | Start its Windows EXE or Python script, answer the Workspace prompt if shown, keep the console open, match the port, then Test connection. Do not open its port publicly. |
| Version mismatch | Use compatible components from the release; reload Extension, restart changed Agent, refresh ChatGPT catalog. Version numbers need not be equal; interfaces must match. |
| Tool missing or `TOOL_DISABLED` | Enable that tool in Extension Settings; in ChatGPT open ResearchTube's management and **Refresh**, then use a new chat. |
| Component missing or stale | Check `system_agent_status`; install/extract only the relevant component, remove ambiguous duplicate executables, restart Agent. |
| Chrome flag still Disabled/Mixed | Fully exit Chrome; relaunch with the edited shortcut; restart Agent for a fresh snapshot. Flag is optional. |
| YouTube verification/403/429 | Respect the returned retry time. Open YouTube normally and complete visible verification if requested. Missing captions/comments can be a property of the video. |
| Task fails or remains working | Check its status, phase, percentage, error code and completed files. Do not start a duplicate operation solely because a result is delayed. |
| Media card blank | Keep Extension and Agent running; check Extension permissions on ChatGPT and the declared sandbox origin; try the card's Refresh and a small known file. See the detailed viewer troubleshooting. |
| File attachment/Send fails | Keep the originating conversation open and leave its draft unchanged. A wrong chat, user edit, active generation or attachment limits can prevent delivery. Saved files remain; don't repeatedly upload them. |
| Study misses an image | Bring it into the controlled page's viewport, read again and request the observed image. Hidden images/pseudo-element backgrounds are outside current supplemental discovery. |
| OpenAI blocks a tool call | This can happen before ResearchTube executes it. Without a returned task ID, there is no ResearchTube task to poll. Record the original refusal; don't assume files were retrieved or claim renaming fixes approval. |
| Help chat has no initial message | Sign in to ChatGPT in Chrome, wait until a normal chat input is available, then click Help again. If Chrome debugger access is denied, resolve that first. As a fallback, paste this guide's public link into a new chat and ask for ResearchTube help. |

For precise steps and error meanings use [Troubleshooting](TROUBLESHOOTING.md) and [Errors](ERRORS.md). A useful report contains the operation, exact public error code, relevant versions/component statuses, OS/Chrome version and a short redacted ResearchTube log excerpt. Never include the API key or Tunnel ID.

## Update without losing files

Preserve/back up your configured Workspace (default `agent/workspace/`) and `agent-config.json` when replacing or moving installations. Reload the unpacked Extension in `chrome://extensions`, restart the Agent if its files changed, then **Refresh** ResearchTube in ChatGPT's plugin/app management and start a new chat. Reloading Chrome's Extension alone does not refresh ChatGPT's catalog.

Developer-owned [Custom Tools](features/CUSTOM_TOOLS.md) are loaded at Agent startup. After package changes, restart the Agent and refresh the ChatGPT catalog. They are trusted local programs with your OS permissions; the bundled examples create no Workspace files.

## More detail

- [Installation](INSTALLATION.md): release layout, components and connection steps.
- [Guided demo](DEMO.md): examples using bundled `demo/researchtube-demo.mp4`.
- [Tools](TOOLS.md), [Troubleshooting](TROUBLESHOOTING.md), [Errors](ERRORS.md): exact behavior and diagnosis.
- [Documentation index](README.md): all feature guides and the development path.

Maintainers: keep this entry guide consistent with implementation and the linked references. Do not copy complete schemas or release version numbers here. Verify current official OpenAI guidance when changing external setup steps; label account/workspace availability conditions.

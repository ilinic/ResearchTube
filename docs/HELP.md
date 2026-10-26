# ResearchTube user help

This is the starting guide for installation, everyday use and troubleshooting. Click **Help** between **Settings** and **Support** in the Extension popup to open a new ChatGPT conversation with this guide. Ask your questions there in your own language. Chrome and a signed-in ChatGPT session are enough to open Help.

## For the assisting ChatGPT

Read this guide first, then open only the linked reference relevant to the user's question. Give short, concrete steps in the user's language. Ask what they need help with instead of immediately reciting the installation procedure. If the source cannot be read, say so and ask for the relevant section; do not claim to have studied it. GitHub's **Raw** button provides the Markdown text if the normal page cannot be read.

When diagnosing a failure, establish which layer failed: public MCP/OAuth, Chrome Extension, Local Agent, component, or one task. For an actual task, call the requested productive tool immediately. Connection routing and exact-tab authorization are checked inside that request. Use `system_connection_status` only for requested diagnostics or after a connection error; it works before local installation. Once the extension is connected, `system_agent_status` supplies readiness information and `system_get_diagnostics` returns recent sanitized errors. If tools are absent, use the user's Settings/popup result. Never call media tools merely for setup diagnosis or ask for credentials, cookies, signed URLs, browser profiles or unredacted logs.

## What ResearchTube does

ResearchTube connects ChatGPT to public YouTube research, local media tools and controlled website study. You make ordinary requests; ChatGPT chooses tools and explains results.

| Part | What it does | When needed |
| --- | --- | --- |
| Public ResearchTube server | OAuth, setup and bounded request routing at `https://rtube.win` | Add it in ChatGPT first; a catalog listing is not required |
| Chrome Extension | Implements tools, connects outbound, reads YouTube and controls browser tasks | Install after OAuth; connects automatically; keep Chrome open during browser work |
| Local Agent | Windows EXE or Python process serving local media tools and Workspace on `127.0.0.1`, normally port `17843` | Required for downloads, local files/media and other Agent-backed operations |
| Workspace | Local files in the configured directory, default `agent/workspace/` | Use logical paths such as `downloads/example.mp4` in chat |

Browser-based YouTube research works with the Agent stopped. Local media requires it. Reading this Help guide needs neither.

## First installation

The [ResearchTube website](https://rtube.win) links to [GitHub Releases](https://github.com/ilinic/ResearchTube/releases): download the latest release and extract the archive to a location of your choice. It also lists the details to enter in ChatGPT: Server URL, Name, Description and Authentication. Use the copy buttons for text. For the plugin icon, select `icons/researchtube-64.png` inside your installed ResearchTube folder.

1. Open **ChatGPT Plugins → Add custom MCP server**, enter **https://rtube.win**, select **OAuth**, sign in through Google (or the configured Microsoft provider), authorize ResearchTube and install the personal plugin. Custom MCP access depends on account/workspace permissions.
2. Follow the installation instructions at [rtube.win](https://rtube.win).
3. Download the platform ZIP from [GitHub Releases](https://github.com/ilinic/ResearchTube/releases), extract it permanently, then load its `extension/` folder in `chrome://extensions` with Developer mode → Load unpacked. Do not use a Source code archive.
4. Keep Chrome open and check **ResearchTube server: Connected** in the popup. The extension connects automatically using the ResearchTube website sign-in in this Chrome profile. If sign-in is missing, open `https://rtube.win/account` and sign in.
5. Ask ResearchTube to perform your task in ChatGPT. It calls the useful tool immediately. Chat delivery and Site tools use the exact tab ID included by the Extension's startup prompt.
6. Start the optional Local Agent for downloads, Workspace, local media and Custom Tools. In Extension Settings use **Local Agent (optional) → Test connection**. See [Agent installation](INSTALLATION.md#3-start-the-local-agent).

Each account has one active extension. Connecting a new installation disconnects the old one, which shows Disconnected in its popup and a red toolbar badge. Network failures reconnect automatically; replaced installations stay stopped. No per-chat connection widget is needed. Tools execute through the active desktop extension even when called from another client; chat actions require its explicit target tab. The desktop must stay open.

See [public connection](features/PUBLIC_CONNECTION.md) and
[public-server troubleshooting](TROUBLESHOOTING.md#public-server-connection).

## Local Agent

Open a terminal in the extracted release root and run:

```sh
python agent/researchtube_agent.py
```

On Windows, open `agent/ResearchTubeAgent.exe` from the fully extracted Windows archive; no separate Python is needed. It runs in the system tray with the ResearchTube icon. Click for the live log; closing the log keeps it running. Right-click → **Exit** stops it. With Python, first install `python -m pip install -r agent/requirements-windows.txt`, then open `agent/researchtube_agent.pyw`, or run `python agent/researchtube_agent.py`. Add `--console` for terminal mode. Linux/macOS use `python3` and keep the terminal open. In Extension **Settings → Local Agent (optional)**, select **Test connection**. The default port is `17843`; the Agent configuration and Extension must use the same port. Implementation versions may differ; **interface versions must match**.

The Agent checks components once at startup. `Checking…` means a startup check is still running. Restart it after changing components or Chrome launch flags; pressing Test connection reads the saved status and does not repeat the checks.

The Agent uses `workspacePath.value` in `agent/agent-config.json`, default `workspace` beside the script or EXE. It creates the folder automatically and never asks at startup. Missing/blank legacy values also use the default. The Workspace can grow large; to choose another drive, edit the config (for example `D:/ResearchTubeWorkspace`) and restart. Relative paths resolve beside the Agent; use forward slashes in JSON or escape backslashes. Existing files are preserved and are not moved when the setting changes. Chat tools use logical paths. The live log is also saved with rotation in `agent/logs/agent.log`. See [Workspace directory setup](INSTALLATION.md#choose-the-workspace-directory).

| Component | Enables |
| --- | --- |
| FFmpeg + ffprobe | Media information, frames, maps, clips and supported capture/recording tools |
| yt-dlp + Deno + ready PO-token provider | Local YouTube downloads/formats and Agent-side fallbacks |
| cloudflared | Explicit temporary online file/folder sharing only |

Use bundled component locations under `agent/tools/` or system `PATH`. Extract archives before use. Missing optional components do not mean all ResearchTube features are broken. See [component installation](INSTALLATION.md#4-install-optional-media-components).

## Where to put the Chrome flag

`--silent-debugger-extension-api` is **optional**: it hides Chrome's debugging banner during Extension automation. The popup reports this optional flag separately from connection readiness.

On Windows:

1. Right-click the shortcut you use to launch Chrome. For a taskbar icon, right-click it, then right-click **Google Chrome** in the menu and choose **Properties**.
2. Open **Shortcut → Target**. Keep the existing executable path and its quotes unchanged. Append one space followed by `--silent-debugger-extension-api` **after** the closing quote.
3. Example shape: `"<existing path to chrome.exe>" --silent-debugger-extension-api`. The placeholder means your existing path; do not replace your actual Target with it.
4. Click **Apply**, exit Chrome completely, and reopen it using that shortcut. Chrome background processes must also exit; an already running instance can retain its original switches.
5. Restart the Local Agent to refresh its Chrome check. **Enabled** confirms its saved diagnostic; **Mixed** can mean Chrome instances were launched differently.

This flag is not a `chrome://flags` option, not an Extension setting and not a remote-debugging port. On other platforms, append the same switch to your normal Chrome launch command; use your platform's launcher instructions rather than Windows shortcut steps.

## Everyday use and tool families

Browse [MCP Tools](MCP_TOOLS.md) for plain-language descriptions of every tool, grouped like Settings. The [tool reference](TOOLS.md) explains detailed behavior; the connected catalog defines exact parameters. You normally describe the result you want instead of naming tools.

| Goal | Tool families / example |
| --- | --- |
| Search/read YouTube | `youtube_search`, video metadata, transcripts, comments, channels and playlists. Ask for sources, relevant transcripts and a summary. |
| Download videos/audio | `youtube_download_get_formats`, `youtube_download` and task status/cancel. Specify whole video or intervals and desired audio/video. |
| Preview a video's timeline | `youtube_storyboard_*` downloads ready-made image sheets in their received format; `visual_map_*` creates maps from video. |
| Inspect/edit local media | `media_probe`, frame capture, `media_image_crop`, `media_clip`, `media_show`. Request frames, ordered clips or format conversion from a Workspace file. `media_clip` uses optional outputFormat with intervals; whole-file conversion/audio extraction requires it. Compatible streams retain original quality; necessary encoding uses automatic quality profiles. Lossless output can be much larger. |
| Capture or record | Screen/region capture, `camera_*`, and Windows clipboard tools. Request these explicitly. |
| Read text aloud | `system_speech_*`: Google Translate by default or Windows voices; speakers, saved file, or both. |
| Manage/share files | `workspace_*`, `media_view`, `library_store_*`, `online_share_*`. Sending/sharing is deliberate, not automatic for every saved file. |
| Timers | `timer_start/status/cancel` for real durations or deadlines. |
| Study a website | **Study this site** in the popup; `site_*` tools operate the sites and ChatGPT participants in its tab group. |
| Custom Tools | Trusted Python packages; bundled **Count Words Example** and **Wait Asynchronous Task Example** demonstrate sync/task execution. |

Use logical Workspace paths such as `downloads/example.mp4`, never your physical disk path. Long operations return a task ID and progress; ChatGPT should check the matching status tool no faster than its `pollIntervalMs`. Cancellation preserves completed files and cannot undo a message already sent. Creation normally saves files; `media_show` displays them and supported `addToChat:true` requests attachment/Send. See [artifact tasks](features/ARTIFACT_TASKS.md).

On a YouTube video or Short, the popup offers **Describe this video**. Elsewhere **Study this site** opens a site copy and one leading ChatGPT chat in a Chrome group. Drag additional site tabs into that group while researching; close or remove them when finished. **List group tabs** discovers current sites. All downloaded images/files are delivered to the leading chat. Other ChatGPT tabs in the group cannot use Site tools. Closing the leader ends group automation; another chat is never substituted. The source stays in place. Page research works without the Local Agent; downloading/saving files requires it. Use `site_get_images` for visual input and `site_get_files` for other observed files. The default chat batch limit is 20 files. After upgrading, reload the Extension and refresh the MCP catalog. See [Browser Agent](features/BROWSER_AGENT.md).

You can also create a Chrome tab group yourself, place one leading saved ChatGPT conversation and the sites inside it, and ask ResearchTube to research the group. ChatGPT uses `system_get_chat_context` and the existing compact widget to identify its exact tab; no manual tab ID is needed. Close duplicate views of that same conversation before connecting. If ChatGPT reports a pending connection, let the widget load and ask it to continue. The Local Agent is not needed to connect or read pages; saving images/files still requires it.

Tools that send files or messages to a chat add them to any existing Composer text and attachments, then send everything together. A draft does not block delivery. Cancel before Send to retain the Composer. Help and the two popup study shortcuts clear their own new chat before inserting the startup prompt.

You can customize both popup startup prompts in `agent/agent-config.json`: edit `studyThisSitePrompt.value` or `describeThisVideoPrompt.value`. Their comments list the square-bracket placeholders, such as `[chat_tab_id]` and `[video_link]`. The active entries have no numeric suffix and request answers **in my language**. Original shorter variants are saved as `studyThisSitePrompt1` and `describeThisVideoPrompt1`. To switch, give the current active entry an unused number and remove the number from the desired variant. Restart the Agent after editing; the next popup launch uses the new template. See [Prompt templates](features/BROWSER_AGENT.md#prompt-templates).

If Study this site reports **BROWSER_DEBUGGER_RESTRICTED**, Chrome refused access because the page embeds another extension’s frame. Temporarily disable the extension injecting that frame for the site, reload and retry. ResearchTube skips inaccessible child frames when the main page connection is available. See [Troubleshooting](TROUBLESHOOTING.md#study-this-site--browser-agent).

## Common problems: start here

| Symptom | First checks / action |
| --- | --- |
| Extension missing | `chrome://extensions`: enabled, correct `extension/` folder, no load errors. Keep the extracted installation folder. |
| ResearchTube absent from ChatGPT | Add **https://rtube.win** in ChatGPT Plugins as a custom MCP server, choose OAuth and follow the setup instructions. |
| Agent unavailable | Start its Windows EXE or Python script, answer the Workspace prompt if shown, keep the console open, match the port, then Test connection. Do not open its port publicly. |
| Version mismatch | Use compatible components from the release; reload Extension, restart changed Agent, refresh ChatGPT catalog. Version numbers need not be equal; interfaces must match. |
| Tool missing or `TOOL_DISABLED` | Enable that tool in Extension Settings; in ChatGPT open ResearchTube's management and **Refresh**, then use a new chat. |
| Download reports a missing final file after yt-dlp succeeds | Update/restart the Local Agent, retry once and request download diagnostics. Cyrillic and Unicode filenames are supported; renaming the video is unnecessary. |
| Single-file sharing rejected | Update the Extension. Use `online_share_start` with `workspacePath`, without folder categories; the result supplies `publicFileUrl`. |
| Storyboard download failed | Inspect task `creation.data.failureDetails` for stage, HTTP status and OS error code. |
| Component missing or stale | Check `system_agent_status`; install/extract only the relevant component, remove ambiguous duplicate executables, restart Agent. |
| Chrome flag still Disabled/Mixed | Fully exit Chrome; relaunch with the edited shortcut; restart Agent for a fresh snapshot. Flag is optional. |
| YouTube verification/403/429 | Respect the returned retry time. Open YouTube normally and complete visible verification if requested. Missing captions/comments can be a property of the video. |
| Task fails or remains working | Check its status, phase, percentage, error code and completed files. Do not start a duplicate operation solely because a result is delayed. |
| Media card blank | Keep Extension and Agent running; check Extension permissions on ChatGPT and the declared sandbox origin; try the card's Refresh and a small known file. See the detailed viewer troubleshooting. |
| File attachment/Send fails | Keep the originating conversation open and leave its draft unchanged. A wrong chat, user edit, active generation or attachment limits can prevent delivery. Saved files remain; don't repeatedly upload them. |
| Study misses an image | Bring it into the controlled page's viewport, read again and request the observed image. Hidden images/pseudo-element backgrounds are outside current supplemental discovery. |
| OpenAI blocks a tool call | This can happen before ResearchTube executes it. Without a returned task ID, there is no ResearchTube task to poll. Record the original refusal; don't assume files were retrieved or claim renaming fixes approval. |
| Help chat has no initial message | Sign in to ChatGPT in Chrome, wait until a normal chat input is available, then click Help again. If Chrome debugger access is denied, resolve that first. As a fallback, paste this guide's public link into a new chat and ask for ResearchTube help. |

For precise steps and error meanings use [Troubleshooting](TROUBLESHOOTING.md) and [Errors](ERRORS.md). A useful report contains the operation, exact public error code, relevant versions/component statuses, OS/Chrome version and a short redacted ResearchTube log excerpt. Keep credentials and private browser data out of support reports.

## Update without losing files

Preserve/back up your configured Workspace (default `agent/workspace/`) and `agent-config.json` when replacing or moving installations. Reload the unpacked Extension in `chrome://extensions`, restart the Agent if its files changed, then **Refresh** ResearchTube in ChatGPT's plugin/app management and start a new chat. Reloading Chrome's Extension alone does not refresh ChatGPT's catalog.

Developer-owned [Custom Tools](features/CUSTOM_TOOLS.md) are loaded at Agent startup. After package changes, restart the Agent and refresh the ChatGPT catalog. They are trusted local programs with your OS permissions; the bundled examples create no Workspace files.

## More detail

- [Installation](INSTALLATION.md): release layout, components and connection steps.
- [Guided demo](DEMO.md): examples using bundled `demo/researchtube-demo.mp4`.
- [Tools](TOOLS.md), [Troubleshooting](TROUBLESHOOTING.md), [Errors](ERRORS.md): exact behavior and diagnosis.
- [Documentation index](README.md): all feature guides and the development path.

Maintainers: keep this entry guide consistent with implementation and the linked references. Do not copy complete schemas or release version numbers here. Verify current official OpenAI guidance when changing external setup steps; label account/workspace availability conditions.

Storyboard download failures report the actual MIME, body category/bytes, encodings, redirects and timing in `creation.data.failureDetails`. See [Storyboard diagnostics](features/STORYBOARDS.md#failure-diagnostics).

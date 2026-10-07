# ResearchTube

![ResearchTube icon](icons/researchtube-64.png)

**Turn public YouTube videos and local media into research material for ChatGPT.**

ResearchTube is a local-first Chrome extension and companion Local Agent. It gives ChatGPT structured access to public YouTube search, metadata, transcripts, comments, playlists, downloads and storyboards, plus a sandboxed workspace for images, video, audio, screenshots, camera capture, speech synthesis and media editing.

ResearchTube uses an OpenAI Secure MCP Tunnel for the private ChatGPT connection. Local files remain on the user's computer: large media is streamed directly from the loopback Agent through an extension-owned viewer rather than uploaded through MCP.

> ResearchTube is currently installed as a developer-mode Chrome extension and connected as a private MCP app. It is not a public ChatGPT Store listing.

## What it can do

- Search public YouTube and inspect video, channel and playlist metadata.
- Retrieve timestamped public transcripts, comments and reply threads.
- Download complete or partial public videos and selected formats.
- Download YouTube's ready-made storyboard sheets with optional timestamps.
- Extract frames from Workspace videos or selected YouTube ranges.
- Build visual maps from uniform samples or detected scene changes.
- Cut several video or audio intervals in one asynchronous task.
- Optionally upload created frames, clips, maps, downloads, captures or speech files to the originating ChatGPT conversation using `addToChat` in the same task.
- Inspect, crop and display local images, video and audio in ChatGPT.
- Capture the desktop, a screen region, camera video or camera audio.
- Synthesize speech with Google Translate or Windows voices.
- Read and write the Windows clipboard explicitly.
- Keep all built-in filesystem operations inside a path-safe Workspace.

## Start here

| Goal | Document |
| --- | --- |
| Install ResearchTube | [Installation](docs/INSTALLATION.md) |
| Fix a problem with help from ChatGPT | [Troubleshooting](docs/TROUBLESHOOTING.md) |
| See a guided demonstration | [Demo playbook](docs/DEMO.md) |
| Understand the system | [Architecture](docs/ARCHITECTURE.md) |
| Continue development | [Development guide](docs/DEVELOPMENT.md) |
| Inspect the MCP tool set | [Tool reference](docs/TOOLS.md) |
| Navigate all documentation | [Documentation index](docs/README.md) |

Coding agents should read [AGENTS.md](AGENTS.md) before modifying the repository.

## Components

```text
ChatGPT
  ↕ OpenAI Secure MCP Tunnel
Chrome Extension
  ↕ 127.0.0.1
Local Agent
  ↕
Workspace + ffmpeg + ffprobe + yt-dlp + optional cloudflared
```

- `extension/` is the unpacked Manifest V3 Chrome extension and MCP server.
- `agent/` is the Python 3.10+ loopback Local Agent.
- `agent/workspace/` contains the user's logical ResearchTube Workspace.
- `docs/` contains the public user, troubleshooting and development documentation.

The Extension can still perform browser-based public YouTube research while the Agent is stopped. Downloads, Workspace operations and local media processing require the Agent.

## Quick installation outline

1. Extract the complete release into a permanent directory.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `extension/`.
3. Start the Agent with `python agent/researchtube_agent.py`.
4. Open ResearchTube **Settings** and test the Local Agent.
5. Configure the OpenAI Secure MCP Tunnel and a restricted API key with only the required tunnel permissions.
6. Add the tunnel as a ChatGPT MCP app named **ResearchTube**.

Follow [Installation](docs/INSTALLATION.md) for the complete procedure and component setup.

## Guided demo

The release includes `demo/researchtube-demo.mp4` inside the Agent Workspace. It contains video and audio and is safe to use for frame extraction, visual maps, clipping and audio extraction. Ask ChatGPT:

```text
@ResearchTube Give me the guided ResearchTube demo using the bundled demo media.
```

The exact non-destructive sequence is documented in [docs/DEMO.md](docs/DEMO.md).

## Privacy and security

- YouTube research uses public data and does not perform account actions.
- ResearchTube does not request Chrome's cookies permission.
- The OpenAI key and Tunnel ID remain in local extension storage and are never sent to YouTube.
- The Agent binds only to `127.0.0.1`.
- Built-in Workspace paths are logical POSIX paths; host paths never enter normal MCP results.
- Built-in filesystem tools reject traversal, absolute paths, redirects and silent overwrites.
- External modules, if added in the future, are trusted local programs and are not covered by the built-in Workspace sandbox.

See [Architecture](docs/ARCHITECTURE.md) for the complete trust-boundary model.

## Development and verification

```sh
python -m unittest discover -s agent/tests -p 'test_*.py'
npm ci --prefix extension
npm test --prefix extension
```

The generated Extension bundles are committed for installation. After changing their sources, rebuild before packaging. See [Development](docs/DEVELOPMENT.md) for the complete workflow and release checklist.

## Status

ResearchTube is an open-source personal research and local-media tool. YouTube content, transcripts and comments remain external sources that should be evaluated rather than treated as automatically verified facts.

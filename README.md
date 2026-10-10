<img src="icons/researchtube-64.png" alt="ResearchTube logo" width="64" align="left">

# ResearchTube

**Turn YouTube into Answers. And Much More.**

**Give ChatGPT the power to explore websites, investigate videos and discussions, and work with media on your computer — just by asking.**

**Free & Open Source · Local-first · Windows · macOS · Linux**

### [⬇ Download ResearchTube](https://github.com/ilinic/ResearchTube/releases)

[See What It Can Do](#what-can-researchtube-do) · [Getting Started](#getting-started)

---

## What Can ResearchTube Do?

ResearchTube turns everyday ChatGPT conversations into hands-on research and media workflows. You describe what you want; ChatGPT uses ResearchTube to investigate and get things done.

### 🎬 Explore YouTube beyond the transcript

**Go beyond what people say and see what actually happens.** Search videos, inspect frames, find important moments, build visual storyboards, and work with entire videos or selected sections.

### 💬 Understand what viewers think

**Dig into real conversations, not just video summaries.** Explore public YouTube comments and replies, discover recurring opinions, and compare different viewpoints across discussions.

### 🌐 Let ChatGPT investigate real websites

**Study the pages you're already browsing.** ResearchTube's Browser Agent can explore page content, inspect images, and interact with website controls — including pages you can access while signed in to Chrome websites. You stay in control of the browser session.

### 🎥 Turn research into videos, images, and audio

**Don't stop at an answer — create something useful.** Download supported YouTube media, extract frames, make visual maps, cut and combine clips, inspect local files, capture your screen or camera, and generate speech. Media processing happens on your own computer through the Local Agent.

## Just Ask ChatGPT

No special command language to learn. **Each example has a Copy button in the top-right corner** — copy the entire prompt and paste it into ChatGPT after connecting ResearchTube.

**Explore the visuals in an iconic YouTube video** — [OK Go: *Here It Goes Again*](https://www.youtube.com/watch?v=dTAAsCNK7RA).

```text
@ResearchTube Analyze this video: https://www.youtube.com/watch?v=dTAAsCNK7RA
Explain the choreography and interesting visual moments. Show representative frames with timestamps.
```

**Explore what people are saying** — [*Me at the zoo*](https://www.youtube.com/watch?v=jNQXAC9IVRw), the first video uploaded to YouTube.

```text
@ResearchTube Investigate the public comments on https://www.youtube.com/watch?v=jNQXAC9IVRw
Identify recurring themes, contrasting opinions, and unusual discussion patterns. Base the summary on comments actually retrieved.
```

**Study a real website** — open [Wikipedia's SpaceX page](https://en.wikipedia.org/wiki/SpaceX) in Chrome and click **ResearchTube → Study this site** to start the Browser Agent session. You can then ask in that session:

```text
Study this page and its images. Summarize the important information, explain what is useful here, and identify any details worth checking further.
```

**Turn a local video into useful media** — try the included example file `demo/researchtube-demo.mp4` in the ResearchTube Workspace.

```text
@ResearchTube Inspect demo/researchtube-demo.mp4, create a visual map of the video, and extract two frames. Keep the original file unchanged.
```

For a full guided walkthrough, see the [ResearchTube demo](docs/DEMO.md).

## Getting Started

1. **Download ResearchTube.** Open [GitHub Releases](https://github.com/ilinic/ResearchTube/releases) and choose the ZIP for your operating system under **Assets** (Windows x64, Linux x64, macOS Apple silicon, or macOS Intel). **Do not download a "Source code" archive** — it does not contain the ready-to-use package.
2. **Extract the ZIP** to a permanent folder on your computer. Keep the extracted folder in place; Chrome loads the extension from it.
3. **Install the Chrome extension.** Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `extension` folder inside ResearchTube. Make sure it's enabled, then pin ResearchTube to your Chrome toolbar.
4. **Finish setup inside ResearchTube.** Click the ResearchTube toolbar icon, open **Settings**, and expand **How to Set Up ResearchTube**. Follow the built-in illustrated guide to connect ChatGPT, start the Local Agent when needed, and configure optional features.

**Requirements:** Google Chrome and a compatible paid ChatGPT subscription with private MCP access (tested with ChatGPT Plus), plus access to OpenAI Secure MCP Tunnels. ResearchTube itself is free; a ChatGPT subscription is separate. Feature availability can depend on your platform and account.

Need extra help? See the [full installation guide](docs/INSTALLATION.md) or open **Help** in the ResearchTube extension.

## Free, Open Source, and Local-first

ResearchTube has **no ResearchTube subscription or hosted processing fee**. The extension and its companion Agent run on your computer. Local video and audio processing stays local unless you choose to share results with ChatGPT or another service. The OpenAI Secure MCP Tunnel connects your extension to ChatGPT without requiring you to run a public server.

ResearchTube is not currently distributed through the Chrome Web Store; download the packaged release from GitHub using the link above.

## Help, Documentation, and Source Code

- **[Download the latest release](https://github.com/ilinic/ResearchTube/releases)**
- [User help](docs/HELP.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [All documentation](docs/README.md)
- [Guided demo](docs/DEMO.md) · [Tool reference](docs/TOOLS.md)
- [Architecture](docs/ARCHITECTURE.md) · [Development and contributions](docs/DEVELOPMENT.md) · [Source code](https://github.com/ilinic/ResearchTube)

ResearchTube is an independent open-source project, not an official OpenAI or YouTube product. External video and website content should be evaluated critically.

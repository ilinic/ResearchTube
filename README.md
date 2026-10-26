<img src="icons/researchtube-64.png" alt="ResearchTube logo" width="64" align="left">

# ResearchTube

**Turn YouTube into Answers. And Much More.**

## Getting Started

In **ChatGPT Plugins**, add **https://rtube.win** as a **custom MCP server**, choose **OAuth** and sign in with Google. Then follow ResearchTube's setup instructions.

The [ResearchTube website](https://rtube.win) has the installation link and all the details to copy into ChatGPT.

Need help? Open **Help** in the ResearchTube extension or read the [installation guide](docs/INSTALLATION.md).

---

**Give ChatGPT the power to explore websites, investigate videos and discussions, and work with media on your computer — just by asking.**

**Free & Open Source · Local-first · Windows · macOS · Linux**

### [⬇ Download ResearchTube](https://github.com/ilinic/ResearchTube/releases)

[See What It Can Do](#what-can-researchtube-do) · [Getting Started](#getting-started)



---

### ResearchTube in Action

See what ChatGPT can do with ResearchTube in three short, real-world demos. **Click a thumbnail to watch on YouTube.**

<table>
  <tr>
    <td width="33%" align="center" valign="top">
      <a href="https://www.youtube.com/watch?v=MCERzuiS0mg">
        <img src="https://i.ytimg.com/vi_webp/MCERzuiS0mg/maxresdefault.webp" alt="Watch ChatGPT analyze OK Go's YouTube video" width="300">
      </a>
      <br><strong>See Inside YouTube Videos</strong>
      <br><sub>Visual analysis, frames and storyboards · 34 sec</sub>
    </td>
    <td width="33%" align="center" valign="top">
      <a href="https://www.youtube.com/watch?v=SKQO4lzK-Mc">
        <img src="https://i.ytimg.com/vi_webp/SKQO4lzK-Mc/maxresdefault.webp" alt="Watch ChatGPT compare two Facebook Marketplace cars" width="300">
      </a>
      <br><strong>Explore Websites Behind Your Login</strong>
      <br><sub>Compare cars across browser tabs · 24 sec</sub>
    </td>
    <td width="33%" align="center" valign="top">
      <a href="https://www.youtube.com/watch?v=_OJSxAjZUF4">
        <img src="https://i.ytimg.com/vi/_OJSxAjZUF4/maxresdefault.jpg" alt="Watch ChatGPT investigate hundreds of YouTube videos and thousands of comments" width="300">
      </a>
      <br><strong>Research Hundreds of Videos</strong>
      <br><sub>Large-scale YouTube and comment research · 25 sec</sub>
    </td>
  </tr>
</table>

Connect using the **ResearchTube server** with Google/Microsoft sign-in, or
choose **My OpenAI tunnel** in Extension Settings. See the
[connection guide](docs/HELP.md#3-set-up-the-openai-connection).

## What Can ResearchTube Do?

ResearchTube turns everyday ChatGPT conversations into hands-on research and media workflows. You describe what you want; ChatGPT uses ResearchTube to investigate and get things done.

### 🎬 Explore YouTube beyond the transcript

**Go beyond what people say and see what actually happens.** Search videos, inspect frames, find important moments, build visual storyboards, and work with entire videos or selected sections.

### 💬 Understand what viewers think

**Dig into real conversations, not just video summaries.** Explore public YouTube comments and replies, discover recurring opinions, and compare different viewpoints across discussions.

### 🌐 Explore Websites Behind Your Login

**Let ChatGPT investigate pages that ordinary web search cannot access.** ResearchTube can explore websites through your authenticated browser session — including member-only listings, private forums, account dashboards, forms, and other content available only after signing in.

ChatGPT can read text, inspect images, navigate pages, and interact with website controls using your existing browser access. No need to make private content publicly accessible.

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

On Windows, the Local Agent runs quietly in the system tray. Click its ResearchTube icon to view the live log; close the window to keep it running, or choose **Exit** from the tray menu to stop. Files use `agent/workspace` by default; change `workspacePath.value` in `agent/agent-config.json` to choose another location.

## MCP Tools

**See everything ResearchTube can do.** Browse the tools by group, with plain-language descriptions of each capability.

### [Explore the ResearchTube tool catalog →](docs/MCP_TOOLS.md)

## Free, Open Source, and Local-first

ResearchTube has **no ResearchTube subscription or hosted processing fee**. The extension and its companion Agent run on your computer. Local video and audio processing stays local unless you choose to share results with ChatGPT or another service. The public server authenticates and relays tool requests. Tools run through your connected desktop extension; server-side transcripts are not provided.

ResearchTube is not currently distributed through the Chrome Web Store; download the packaged release from GitHub using the link above.

## Help, Documentation, and Source Code

- **[Download the latest release](https://github.com/ilinic/ResearchTube/releases)**
- [User help](docs/HELP.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [All documentation](docs/README.md)
- [Guided demo](docs/DEMO.md) · [Tool reference](docs/TOOLS.md)
- [Architecture](docs/ARCHITECTURE.md) · [Development and contributions](docs/DEVELOPMENT.md) · [Source code](https://github.com/ilinic/ResearchTube)

ResearchTube is an independent open-source project, not an official OpenAI or YouTube product. External video and website content should be evaluated critically.

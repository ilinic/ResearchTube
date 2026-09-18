# ResearchTube — YouTube Research for ChatGPT

<img src="icons/researchtube-128.png" width="96" alt="ResearchTube icon">

**Turn public YouTube videos into research material for ChatGPT.**

ResearchTube is a local Chrome extension that gives ChatGPT structured access to public YouTube search results, video details, caption tracks and transcripts, comments, and selected reply threads. It is built for the part of YouTube that ordinary search often misses: long explanations, first-hand accounts, technical demonstrations, and the discussion underneath them.

Ask ChatGPT to find relevant videos, read the underlying transcript, compare competing views, and inspect the most useful public comment threads—all from one conversation.

> ResearchTube is a personal developer-mode integration for ChatGPT, connected through an OpenAI Secure MCP Tunnel. It is not a public ChatGPT Plugin Directory listing.

## Demo

See ResearchTube in action:

https://github.com/user-attachments/assets/35614a7a-98fa-4d36-9632-a0da1d7c8805

## What it makes possible

- **Go beyond titles and summaries.** Search YouTube, then ground an answer in the actual spoken content of relevant videos.
- **Compare real explanations.** Ask ChatGPT to analyse several transcripts and identify agreements, disagreements, evidence, or unanswered questions.
- **Read the audience response.** Retrieve public top comments and follow a selected reply thread when the discussion adds useful context.
- **Keep the workflow conversational.** There is no separate research dashboard: describe the question you want investigated in ChatGPT.

Example prompts:

```text
Find recent YouTube videos explaining quantum error correction.
Read the primary transcripts of the most useful ones and compare their explanations.
```

```text
Research practical vacuum toilet designs on YouTube.
Summarise the technical approaches, then analyse recurring questions in the top comments.
```

```text
Find public YouTube discussions about this topic.
Separate claims made in the videos from recurring points made by commenters.
```

## A simple guided setup

ResearchTube is designed so that you do **not** need to understand MCP transport, browser messaging, or the extension's internals to connect it.

After the extension is installed, its local **Settings** page opens automatically. It:

- opens the relevant official OpenAI and ChatGPT pages in normal browser tabs;
- asks only for a Tunnel ID and a Restricted OpenAI API Key;
- explains the recommended key permissions; and
- tests the real connection before you use the extension in ChatGPT.

The toolbar popup shows the connection status and lets you reopen Settings. The extension uses the fixed official OpenAI endpoint, so there is no custom server address to configure.

### Install and connect

1. Download the latest release and extract it to a folder you will keep.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted folder. ResearchTube opens its Settings page.
3. In Settings, create or choose an OpenAI tunnel and copy its **Tunnel ID**. This is the identifier beginning with `tunnel_`—not the tunnel's name or URL.
4. Create a separate **Restricted OpenAI API Key**. In the key's **Permissions**, allow only **Tunnels: Read + Use**. Do not use an organisation-owner, administrator, or unrestricted key. Paste both values into Settings and select **Save and test connection**.
5. In ChatGPT Settings, enable **Developer Mode**. You need a ChatGPT plan or workspace with Developer Mode access—typically Plus or higher. Then open the ChatGPT Plugins area, select the plus button, choose **Tunnel** as the connection, select or paste the same Tunnel ID, and name the app **ResearchTube**.
6. Start a new ChatGPT chat and use `@ResearchTube` before your request, for example: `@ResearchTube Find recent videos about quantum computing and compare their transcripts.`

The [OpenAI Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) explains the tunnel model.

## Tools available to ChatGPT

| Tool | What ChatGPT can do with it |
| --- | --- |
| `youtube_search` | Find public videos by topic, keywords, channel, or date. |
| `youtube_get_video` | Read a video's scale and context: metadata, normalized views/likes/comments, every public caption track with its selectable `trackIndex`, and YouTube's original display counts. |
| `youtube_get_transcript` | Retrieve timestamped text from a public caption track. By default it uses track `0`; pass a `trackIndex` from `youtube_get_video` to select another language or track. |
| `youtube_get_comments` | Retrieve ranked public top-level comments, sorted by top or newest, with normalized and display engagement counts. |
| `youtube_get_comment_replies` | Read one selected public comment thread, including its total size and the returned sample. |

## Privacy and boundaries

- ResearchTube reads public YouTube data only. It does not post, react, subscribe, or act as a YouTube account.
- YouTube requests are anonymous: the extension does not request Chrome's `cookies` permission and does not read, store, or send YouTube cookies.
- The OpenAI API key stays in local Chrome extension storage. It is sent only to OpenAI for tunnel access—never to YouTube, a webpage bridge, analytics, or a ResearchTube developer server.
- YouTube may disable comments, omit captions, restrict a video, or change its page formats. Public access cannot be guaranteed for every video.
- Searches are serialized and cached briefly. They use the open YouTube page context without changing its URL or playback. If YouTube asks for verification, ResearchTube pauses new searches and tells ChatGPT exactly when to retry instead of repeatedly sending requests.
- Settings includes a local diagnostics log for troubleshooting. It records concise tool timing, safe request summaries, errors, search queue state, and YouTube HTTP outcomes, but never API keys, Tunnel IDs, cookies, request headers, response bodies, transcript text, or comment text.

For transcripts, comments, and replies, ResearchTube uses a normal YouTube page context. It reuses an open YouTube tab when possible; otherwise it creates an inactive tab and retries once with a fresh tab if the page context becomes stale. It never opens a separate window or steals focus.

## For developers

Read [Architecture](docs/ARCHITECTURE.md) for the component model, page-bridge design, MCP contract, tool schemas, build process, and project layout.

## Status

ResearchTube is an open-source personal research tool. Before relying on a result, treat YouTube content and comments as sources to evaluate—not as automatically verified facts.

# ResearchTube documentation

This directory is the canonical documentation set for ResearchTube. Source code remains authoritative for exact schemas; these documents explain installation, behavior, architecture and safe development practices.

## Choose a path

### I want to use ResearchTube

1. [User help](HELP.md): one starting guide for setup, use and common problems. Popup **Help** opens it in a new ChatGPT help conversation.
2. [Installation](INSTALLATION.md)
3. [Guided demo](DEMO.md)
4. [Tool reference](TOOLS.md)

### Something is not working

1. Start with popup **Help** or give the public URL of [User help](HELP.md) to the assisting chat; follow its links to the relevant [Troubleshooting](TROUBLESHOOTING.md) section.
2. Use [Error reference](ERRORS.md) for a returned error code.
3. Collect only the bounded diagnostic information requested by those documents.

### I want to continue development

1. Read the repository-root [`AGENTS.md`](../AGENTS.md).
2. Read [Architecture](ARCHITECTURE.md).
3. Follow [Development](DEVELOPMENT.md).
4. Consult [Tool reference](TOOLS.md) and the relevant feature specification.

## Core documents

| Document | Purpose |
| --- | --- |
| [User help](HELP.md) | Self-contained user/ChatGPT entry guide: setup, tools, Chrome switches and common failures |
| [Architecture](ARCHITECTURE.md) | Components, boundaries, data flows, task lifecycle and security model |
| [Development](DEVELOPMENT.md) | Adding tools, changing contracts, testing, versions and releases |
| [Tools](TOOLS.md) | Public MCP inventory and operational behavior |
| [Installation](INSTALLATION.md) | First installation and required components |
| [Troubleshooting](TROUBLESHOOTING.md) | Symptom-driven diagnosis for users and assisting LLMs |
| [Errors](ERRORS.md) | Stable error-code meanings and corrective actions |
| [Demo](DEMO.md) | Non-destructive guided demonstration using bundled media |

## Feature specifications

- [YouTube Storyboards](features/STORYBOARDS.md)
- [Workspace media viewer](features/MEDIA_VIEWER.md)
- [Text to Speech](features/TEXT_TO_SPEECH.md)
- [Media clips](features/MEDIA_CLIP.md)
- [Artifact tasks and automatic chat delivery](features/ARTIFACT_TASKS.md)
- [Real timers](features/TIMERS.md)
- [Browser Agent](features/BROWSER_AGENT.md)
- [Task chat context and Composer recovery](features/TASK_CHAT.md)
- [Custom Tools](features/CUSTOM_TOOLS.md)

## Documentation rules

- Do not copy complete JSON schemas into prose. Link to the owning source file and describe stable semantics.
- Do not put release numbers in feature documentation. Runtime versions come from `system_agent_status` and code constants.
- Do not document a capability before it is implemented and tested.
- Use logical Workspace paths in examples; never publish a developer's physical path.
- Keep user instructions executable by the user or ChatGPT. Do not tell a chat to reload software, inspect a local console or edit files as if it could do those actions itself.
- Update this index when adding, moving or removing a document.
- Keep `HELP.md` aligned when user setup, capabilities or common failure recovery changes. Feature guides and source schemas remain authoritative for detail; the help prompt points to the live `main` guide.

# ResearchTube Local Agent

The Local Agent is a Python 3.10+ asyncio service bound only to `127.0.0.1`. It owns the path-safe Workspace, executable discovery, media processing, local downloads, speech callbacks and byte-range media serving used by the Chrome Extension.

Start from the repository root:

```sh
python agent/researchtube_agent.py
```

Or from this directory:

```sh
python researchtube_agent.py
```

Configuration is read from `agent-config.json`. The default port is `17843`. The Agent creates/opens `workspace/`; do not replace or delete that directory during upgrades.

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

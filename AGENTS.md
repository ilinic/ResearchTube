# ResearchTube coding-agent instructions

Read this file before changing the repository. Then read `docs/ARCHITECTURE.md` and the relevant section of `docs/DEVELOPMENT.md`.

## Repository map

- `extension/background.js` is the main Extension and MCP source.
- `extension/storyboards.js` owns the public storyboard schemas and normalization.
- `extension/youtube-page-bridge.src.js` is the source for the MAIN-world YouTube bridge.
- `extension/youtube-content.js` is the isolated YouTube content script.
- `extension/chatgpt-capture-frame-bridge.js` and `extension/media-viewer.html` implement the ChatGPT local-media bridge.
- `extension/chat-composer.js` owns scoped Composer inspection and user-edit monitoring for file submission.
- `extension/artifact-tasks.js` owns the unified asynchronous creation-and-delivery supervisor; `extension/artifact-tools.js` owns common MCP flags, result schemas and canonical Workspace argument translation.
- `agent/researchtube_agent.py` is the loopback Agent and most Agent services.
- `agent/storyboards.py` owns Agent-side storyboard discovery and tasks.
- `agent/timers.py` owns real timer tasks; `agent/task_history.py` bounds all Agent terminal-task histories.
- `extension/timers.js` owns timer schemas/normalization; `extension/task-history.js` bounds browser task Maps.
- `agent/tests/` and `extension/tests/` are required contract coverage.
- `docs/` is the canonical documentation root.

## Generated files

- `extension/dist/background.js` is generated from `extension/background.js`.
- `extension/youtube-page-bridge.js` is generated from `extension/youtube-page-bridge.src.js`.

Do not implement a fix only in a generated file. Change the source and run `npm run build --prefix extension`.

## Non-negotiable contracts

1. The Agent listens only on `127.0.0.1`.
2. Built-in filesystem and media tools accept logical Workspace paths, never host paths.
3. Validate logical paths independently in the Extension and Agent.
4. Never return credentials, cookies, signed media URLs, tokens, host paths or unbounded process output through MCP.
5. Existing output files are never overwritten silently.
6. Asynchronous tools return a task immediately, expose monotonic `progressPercent`, publish `pollIntervalMs`, support bounded status polling and preserve completed outputs on later failure where practical.
7. A creation tool does not display media automatically unless its documented contract explicitly says so. Use `media_show` for deliberate presentation.
8. Public MCP inputs and Agent responses are allowlisted with strict schemas or explicit normalization.
9. Expected input, availability and state errors use stable structured codes; unexpected transport or implementation failures remain tool errors.
10. Browser automation must not steal focus unless the public tool contract explicitly requires it.

## Version policy

- Extension implementation version: `extension/package.json`, `extension/package-lock.json`, `extension/manifest.json` and `EXTENSION_VERSION` in `extension/background.js` must agree.
- Agent implementation version: `AGENT_VERSION` in `agent/researchtube_agent.py` is independent of the Extension implementation version. Increment only the component whose behavior changes; MCP tool descriptions that change model behavior belong to the Extension. Do not bump an unchanged Agent or Extension to match the other. Synchronize implementation versions only when the user explicitly requests it.
- Compatibility version: `INTERFACE_VERSION` in the Agent must equal `REQUIRED_AGENT_INTERFACE_VERSION` in the Extension.
- Increment the interface version only when the Extension ↔ Agent contract becomes incompatible or gains a required contract surface.
- An Extension-only implementation or documentation bootstrap change does not require an interface-version increment.
- Update the appropriate tests whenever a version changes.

## Adding or changing an MCP tool

1. Add or update the public definition and strict schemas in `extension/background.js` or the feature module that owns it.
2. Add explicit Settings metadata in `MCP_TOOL_SETTINGS`.
3. Normalize input before sending it to the Agent or browser bridge.
4. Normalize and project every response before returning it through MCP.
5. Add Agent routes and task management only when local work is required.
6. Keep Agent console logging compact; task status lines expose percentage without dumping payloads or internal callback URLs.
7. Add Extension contract tests and Agent behavioral tests.
8. Update `docs/TOOLS.md`, relevant troubleshooting entries and any feature specification.
9. Rebuild generated bundles.

## Verification

Run from the repository root:

```sh
python -m unittest discover -s agent/tests -p 'test_*.py'
npm test --prefix extension
git diff --check
```

For media changes, also perform a small real-FFmpeg integration test where available. Mocked tests do not replace live Windows/Chrome verification for browser, camera, screen, clipboard, CDP or ChatGPT-widget behavior.

## Change discipline

- Preserve unrelated user changes in a dirty worktree.
- Do not delete or rewrite user Workspace content.
- Do not commit, push, publish, open a pull request or modify remote state unless the user explicitly asks.
- Do not add installation steps or permissions that are not required by the implemented behavior.
- Keep the root README concise; put durable detail in `docs/`.
- Do not duplicate complete JSON schemas in prose. Code is authoritative; documentation explains stable behavior and invariants.

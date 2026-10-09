# Text to Speech


All start/status/cancel calls use the common [artifact workflow](ARTIFACT_TASKS.md). Public results expose native task metadata under `creation.data` and created paths under `files`; `addToChat` optionally extends the same task through upload and Send. `media_task_status` and `media_task_cancel` are shared follow-up tools. Specialized status/cancel names are aliases.

ResearchTube exposes asynchronous speech synthesis through Google Translate and Windows voices.

## Tools

- `system_speech_list_voices`
- `system_speech_speak`
- `system_speech_status`
- `system_speech_cancel`

## Engines

### Google Translate

Google Translate is the default engine and automatically detects the source language. No target-language argument exists.

ResearchTube retains one inactive Translate tab. For every request it:

1. attaches CDP and emulates focus and an active lifecycle without activating the tab;
2. waits for page readiness, clears earlier source text, then inserts and verifies the exact requested text;
3. resolves one enabled source listen button and starts observing its label before clicking;
4. clicks `aria-label="Listen to source text"` using browser input;
5. confirms the source control changed to `Stop listening`; if pointer input is ignored, waits up to 60 seconds for asynchronous startup before considering one guarded direct-control retry; only the same source text and an enabled source Listen permit that retry;
6. keeps waiting through disabled, missing or replaced source controls; tracks the new source control across DOM updates, never the target-language Stop. The initial click and guarded retry each have a 60-second startup window; idle alone or a prefetched network response never counts as success;
7. collects file audio from CDP network responses when required;
8. waits for the source control to remain back at enabled Listen for one second after confirmed playback in every output mode before reporting completion, saving file output and releasing focus emulation.

ResearchTube does not use `chrome.tabCapture`, does not require an `activeTab` recording gesture and never closes the retained Translate tab.

### Windows

Windows speech uses voices exposed by Windows Media Speech Synthesis. Public `voiceId` values are opaque ResearchTube identifiers and never reveal registry paths. File output is WAV and filenames include the selected public voice name.

The Windows EXE includes the WinRT dependencies and starts a separate copy of itself in speech-helper mode. Python mode uses the helper wrapper and requires `python -m pip install -r agent/requirements-windows.txt`; this includes the collection projection needed to enumerate voices. Both modes use the same `agent/windows_speech.py` implementation and external Workspace configuration.

## Output modes

Exactly one mode is selected:

- `speakers`: play only;
- `file`: save only;
- `both`: play and save.

For Google Translate file-only mode, the tab is muted while Google plays internally. It is unmuted only after playback/audio collection and file saving are complete. For `both`, the same synthesis remains audible while its source response is saved.

When no output path is supplied for a file-producing mode, ResearchTube writes a unique file under lowercase `text-to-speech/`. Existing files are never overwritten silently.

## Tasks

The start tool returns immediately. Status exposes engine, output mode, phase, progress, public voice/format metadata and the logical output path after completion. Cancellation stops active local synthesis or browser collection, stops confirmed Translate playback and removes the playback observer and focus emulation while retaining the Google Translate tab.

The primary implementation is in `extension/background.js`, `agent/researchtube_agent.py` and `agent/windows_speech.py`; `agent/tools/windows-speech/` retains the Python entry wrapper.

The common task and service widget identify speech as a speech operation, including speakers-only requests with `files: []`. Task status exposes the native phase and message, such as opening Google Translate, preparing speech or playing speech; it never claims Workspace file creation for speakers-only output.

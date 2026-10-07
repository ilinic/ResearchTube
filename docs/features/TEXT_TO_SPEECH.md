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

1. waits for page readiness;
2. clears earlier source text;
3. inserts and verifies the exact requested text;
4. waits until the source listen button is enabled;
5. attaches CDP, emulates focus and an active lifecycle without activating the tab;
6. clicks the button identified by `aria-label="Listen to source text"` using browser input;
7. collects file audio from CDP network responses when required;
8. waits for playback completion before finalizing file-only output and restoring mute state.

ResearchTube does not use `chrome.tabCapture`, does not require an `activeTab` recording gesture and never closes the retained Translate tab.

### Windows

Windows speech uses voices exposed by Windows Media Speech Synthesis. Public `voiceId` values are opaque ResearchTube identifiers and never reveal registry paths. File output is WAV and filenames include the selected public voice name.

## Output modes

Exactly one mode is selected:

- `speakers`: play only;
- `file`: save only;
- `both`: play and save.

For Google Translate file-only mode, the tab is muted while Google plays internally. It is unmuted only after playback/audio collection and file saving are complete. For `both`, the same synthesis remains audible while its source response is saved.

When no output path is supplied for a file-producing mode, ResearchTube writes a unique file under lowercase `text-to-speech/`. Existing files are never overwritten silently.

## Tasks

The start tool returns immediately. Status exposes engine, output mode, phase, progress, public voice/format metadata and the logical output path after completion. Cancellation stops active local synthesis or browser collection but retains the Google Translate tab.

The primary implementation is in `extension/background.js`, `agent/researchtube_agent.py` and `agent/tools/windows-speech/`.

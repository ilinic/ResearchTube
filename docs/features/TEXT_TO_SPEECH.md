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
5. confirms the source control changed to `Stop listening`; if pointer input is ignored, tries the same control directly once after two seconds, provided playback has not started and source text still matches;
6. reports a playback failure if no confirmed start arrives within the bounded readiness timeout; idle alone never counts as success;
7. collects file audio from CDP network responses when required;
8. waits for confirmed playback completion in every output mode before reporting completion, saving file output and releasing focus emulation.

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

The start tool returns immediately. Status exposes engine, output mode, phase, progress, public voice/format metadata and the logical output path after completion. Cancellation stops active local synthesis or browser collection, stops confirmed Translate playback and removes the playback observer and focus emulation while retaining the Google Translate tab.

The primary implementation is in `extension/background.js`, `agent/researchtube_agent.py` and `agent/tools/windows-speech/`.

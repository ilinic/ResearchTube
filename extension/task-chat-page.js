// Bundled as an isolated-world page script; no eval or remote code.
import { installComposerWatchdog } from "./task-chat.js";
import { inspectChatComposer } from "./chat-composer.js";
globalThis.__researchtubeInstallComposerWatchdog = seconds => installComposerWatchdog(seconds, inspectChatComposer);

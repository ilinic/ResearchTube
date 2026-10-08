# Task chat context and automatic Send

Task IDs remain independent of Chrome tabs. Every asynchronous launch accepts optional integer `tabId` (zero or greater), naming the ChatGPT destination. Describe this video and Study this site include it once in their short startup prompt. The model passes it to later asynchronous calls. No preliminary tab-discovery tool is needed; omitting it leaves ordinary tasks without a completion wake-up.

The Extension stores context on its existing artifact, Library, media-to-chat and site-file task records. Agent-owned timers and asynchronous Custom Tools use bounded Extension task records for autonomous polling and chat context. The Agent still owns their execution; package arguments and native producer inputs never receive the browser-only parameter. There is no separate task-to-tab lookup table. Task status exposes context where available. Site-file tasks inherit their session's known ChatGPT tab; supplied tabId must match it. Media-to-chat's existing authenticated widget can fill the task's context after launch.

Only a public workflow completion notifies ChatGPT. Internal Agent creation and reserved file-delivery tasks do not emit separate completion messages. The Extension marks the notification handled before attempting browser work. Immediate completion at launch is handled too; repeated status reads do not resend. The fixed text is `ResearchTube task <taskId> completed.`. Failed/cancelled tasks do not emit this success message.

Completion checks the named tab, never current focus. A missing tab, non-ChatGPT page, busy model, unavailable Composer, changing draft or owned file-submission stage consumes the completion notification without queued wake-up. An empty idle Composer receives the message immediately. A nonempty stable Composer retains its text and attachments; the message is appended with editor input before Send. The operation does not create/activate another tab, clean up drafts, or retarget a different conversation.

## Composer watchdog

`composerAutoSendTimeoutSeconds` in `agent/agent-config.json` defaults to 20 (integer 1–3600). The setting is read through the existing internal settings endpoint and cached briefly. It is independent of Send retries and explicit `sendDelaySeconds`.

An Extension-owned isolated script observes only ResearchTube-used ChatGPT tabs. Text or visible attachment-count changes restart the stability interval; an empty Composer resets it. A nonempty stable Composer is sent only when the model is idle and Send is enabled. This includes existing user drafts in these monitored tabs. File submission and an explicit waiting-to-send stage take priority. Cancellation or uncertain Send suppresses recovery of the retained draft until the user edits text or the Composer empties.

Watchdog and completion use `sendComposerWhenReady`, serialized with existing file automation. It appends without replacing text, rechecks the draft/count and idle state before clicks, and uses the existing configured repeated Send controller. Submission is acknowledged by a new user message, generation, or a changed Send control with an emptied Composer; a click alone is insufficient. Ambiguous committed clicks are not replayed by the watchdog.

There is no pending completion queue or reboot recovery promise. Closing the tab removes its page monitor. Browser session stop releases its monitor. A Chrome/Agent restart may interrupt in-flight work. Live Chrome verification remains necessary because ChatGPT UI readiness and selectors can change.

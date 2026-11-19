# Task chat context and automatic Send

Task IDs remain independent of Chrome tabs. Public launches no longer accept destination tab IDs. The Extension resolves chat context from an account-scoped MCP conversation key bound to the exact Chrome document. Only chat-targeted operations require a connection; ordinary research and file-only creation do not inspect ChatGPT or render a connection widget. timer_start accepts notifyInChat=true for optional idle-only completion. See [Chat binding](CHAT_BINDING.md).

The Extension stores private context on artifact, media-to-chat and site-file tasks. Agent-owned timers use bounded Extension records for autonomous polling. The Agent owns execution and never receives browser routing metadata. Source-site tab IDs from site_list_tabs remain public and distinct from the privately resolved leading chat. A missing connection fails before productive work, so a post-binding retry cannot duplicate creation or Send.

Only a public workflow completion notifies ChatGPT. Internal Agent creation and reserved file-delivery tasks do not emit separate completion messages. The Extension marks the notification handled before attempting browser work. Immediate completion at launch is handled too; repeated status reads do not resend. The fixed text is `ResearchTube task <taskId> completed.`. Failed/cancelled tasks do not emit this success message.

Completion checks the named tab, never current focus. A missing tab, non-ChatGPT page, busy model, unavailable Composer or owned file-submission stage consumes the completion notification without queued wake-up. An empty idle Composer receives the message immediately. A nonempty Composer, including an actively edited draft, retains its text and attachments; the message is appended with editor input before Send. The operation does not create/activate another tab, clean up drafts, or retarget a different conversation.

## Composer watchdog

`composerAutoSendTimeoutSeconds` in `agent/agent-config.json` defaults to 20 (integer 1–3600). The setting is read through the existing internal settings endpoint and cached briefly. It is independent of Send retries and explicit `sendDelaySeconds`.

An Extension-owned isolated script observes only ResearchTube-used ChatGPT tabs. Text or visible attachment-count changes restart the stability interval; an empty Composer resets it. A nonempty stable Composer is sent only when the model is idle and Send is enabled. This includes existing user drafts in these monitored tabs. File submission and an explicit waiting-to-send stage take priority. Cancellation or uncertain Send suppresses recovery of the retained draft until the user edits text or the Composer empties.

Watchdog and completion use `sendComposerWhenReady`, serialized with existing file automation. Task messages append without replacing text and do not require draft stability; existing and newly edited data are submitted together. The independent watchdog still requires its configured stability interval and unchanged draft/count. Both paths recheck the destination and idle state before clicks, and uses the existing configured repeated Send controller. Submission is acknowledged by a new user message, generation, or a changed Send control with an emptied Composer; a click alone is insufficient. Ambiguous committed clicks are not replayed by the watchdog.

There is no pending completion queue or reboot recovery promise. Closing the tab removes its page monitor. Group Stop cancels pending file/page work. Site research has one leading chat per group; its own file/task completion messages go only to that exact chat. A Chrome/Agent restart may interrupt in-flight work. Live Chrome verification remains necessary because ChatGPT UI readiness and selectors can change.

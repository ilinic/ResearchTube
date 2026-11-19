# Lazy current-chat binding

Ordinary YouTube research, local reads and file-only creation execute immediately
without reading ChatGPT or requiring a widget. Chat delivery (`media_view`,
artifact `addToChat=true`), Site tools and timer `notifyInChat=true` need the exact
invoking Chrome document. Public calls never supply destination `tabId` or
`chatTabId`. Source-site `tabId` values from `site_list_tabs` remain page targets.

## Call flow

1. Call the productive tool first. If its conversation has a verified live
   connection, execute immediately with the private target and existing guards.
2. Otherwise return structured `BROWSER_CONTEXT_REQUIRED` **before** creating a
   task, mutating a page, attaching files or clicking Send. This error expressly
   means the operation has not executed.
3. Call `system_get_chat_context` with no tab ID. Only this tool declares the
   compact 32px connection template. Its task returns immediately, with monotonic
   progress, `pollIntervalMs`, and private capability metadata hidden from the
   model. The widget needs no clicks, user message, prompt marker or UI scraping.
4. The installed content bridge forwards the capability; Chrome supplies
   `sender.tab.id`. The Extension checks its own sender ID, live saved conversation,
   exact top `documentId`, unique conversation tab, deadline and connection state.
5. Poll `system_chat_context_status` at `pollIntervalMs`; once completed, retry the
   original unexecuted tool. `system_chat_context_cancel` cancels pending binding.
   Neither polling nor cancellation declares a widget. Reuse the live connection.

ChatGPT associates UI templates with tool descriptors, so conditional rendering
is achieved with this dedicated tool, not an unsupported per-result template
override or a hidden iframe on every productive tool. The model performs the
extra tool step automatically only when required. ChatGPT controls the actual
reserved iframe height. `media_show` retains its deliberate playback UI.

`resumeGroup=true` on `system_get_chat_context` explicitly resumes a stopped Site
group. Default false binds only the chat: media delivery does not require a tab
group, and incidental reconnects never undo group Stop. The first productive Site
call discovers its group and verifies its existing leading-chat ownership.

## Scope and invalidation

ChatGPT documents `params._meta["openai/session"]` as an anonymized conversation
identifier. The Worker hashes bounded session, subject and organization hints
together with the OAuth account into a private 64-character `chatSession` key.
Only this allowlisted hash crosses the relay. It is a routing hint, not a credential
or proof of browser origin. The widget capability and Chrome sender provide the
initial association. Capabilities and keys never enter model-visible results,
startup prompts, Agent requests or logs.

Missing session metadata produces `CHAT_SESSION_UNAVAILABLE` only for chat-targeted
operations; ordinary tools still work. No active-tab fallback exists. Session
stability across browser restarts is not assumed. Navigation, document reload,
tab closure, binding expiry, socket replacement, browser restart or Extension
reload require fresh binding when next needed. Old widget receipts cannot retarget
a task or replay an action. Duplicate views of one conversation are refused.
In-flight tasks retain their original private document and stop if it changes;
reconnecting never redirects interrupted uploads or replays unknown Send outcomes.
Terminal binding history and pending tasks are bounded and worker-local.

## Updating and verification

Build the Extension and regenerate the Worker catalog/validators. Deploy the
updated Worker and reload the unpacked Extension, then refresh ResearchTube's MCP
tool list. The Agent interface and executable implementation are unchanged.
Restart a running Agent to reload the edited active startup prompt configuration;
legacy numeric routing placeholders are suppressed by the Extension even when an
older Agent snapshot supplies them. The YouTube prompt requests relevant video
frames/storyboards when visual details matter and uploads selected frames for
visual analysis.

Run Extension, Agent and Worker suites. Native Chromium tests exercise the real
unpacked Extension, content script sender, iframe handshake, target reuse and
reload invalidation against simulated host pages and local workerd. This does not
prove that the current signed-in ChatGPT host renders the template or sends the
documented session field: verify both in live ChatGPT after refreshing its catalog.

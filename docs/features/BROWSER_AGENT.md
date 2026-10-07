# Browser Agent

## Launch and ownership

The original [technical specification](BROWSER_AGENT_SPEC.md) is included for development continuity. Chrome 125 or later is required for flattened iframe debugger sessions.

**Study this site** in the Extension popup duplicates the exact source tab and opens a separate, ordinary ChatGPT tab in the same Chrome window. The copy uses the current Chrome profile and existing site login. The original tab is untouched. If ChatGPT restores an existing draft or attachments into the newly opened chat, startup refuses to overwrite or send them. The source is restored after Chrome selects its duplicate; subsequent actions do not activate tabs. `Describe this video` remains a separate YouTube action.

A session owns its agent tab and dedicated ChatGPT conversation. The startup prompt supplies an opaque `sessionId` (`bas_` plus ten random URL-safe characters) for all browser calls. Users can switch active tabs or windows during initialization, observation and delivery; each operation retains the exact agent/chat tab IDs captured at session creation. It never selects a target by current focus, URL similarity or the most recently used window. Starting from an existing agent or chat tab creates an independent copy and session; it does not transfer ownership. There is no configured cap on active sessions. Conversation validation always reads the live URL of the exact owned ChatGPT tab. A delayed Chrome URL-event snapshot cannot stop or rebind a session whose actual conversation still matches. Genuine navigation to another conversation still stops the session; no replacement destination is selected. Console diagnostics include only the expected, live and event conversation paths, never query strings.

The Extension icon shows a bright blue **AUTO** badge on the controlled agent and dedicated ChatGPT tabs, including during startup. Paused sessions retain **AUTO** with an amber background; a failed session shows **ERR** in red. Its tooltip explains the current stage. Open the popup on either bound tab for **Pause**, **Resume** and **Stop**, without exposing session IDs. The studied page receives no overlay, badge, injected controls or layout changes. Camera/microphone recording indicators take precedence; Browser Agent state remains available in the popup.

CDP attaches and enables focus/lifecycle emulation before waiting for the site. Startup waits for a document body and `interactive`/`complete` readyState rather than waiting for every image, advertisement or background request. The document and ChatGPT Composer have bounded two-minute waits; cancellation is checked during document waiting. The initial prompt does not require a preliminary full AX-tree read. The first `browser_observe` obtains the current tree when requested. After Send, startup waits up to two minutes for the dedicated tab to receive its saved conversation address. ChatGPT’s temporary `/c/local-chatgpt%3A…` address is never bound; its replacement by the saved address is part of startup, not a conversation change. Stop and tab closure are respected during this wait. Console startup phases and popup status distinguish document waiting, Composer preparation, Send and conversation confirmation; failures retain their specific code/message.

Closing the agent or dedicated chat tab, changing the dedicated conversation or debugger detachment stops the session. Closing the original source tab does not. Stop clears the automation indicator and detaches the debugger, leaving tabs, attachments and saved files intact. An Extension/browser restart loses the in-memory session and task records; an old ID returns an explanatory not-found result. No tabs or sessions are invisibly recreated.

## Observation and actions

Accessibility Tree is primary. DOM is used for resource references, allowed attributes, geometry and input targets. Ordinary observation does not capture a screenshot or return full HTML. The serializer removes ignored AX nodes, redundant inline text boxes and unnamed generic wrappers while preserving meaningful hierarchy through `roots`, `parentId` and `childIds`. Child IDs outside the returned slice are deferred references, not missing tree relationships.

Start with `browser_observe` in `outline` mode. Expand relevant nodes with `browser_get_children` or `subtree`; use `full` only when necessary. `depth`, `maxNodes`, `maxChars` and `offset` bound output. Long node text is marked truncated and can be read with `browser_get_text` offset/limit. Pagination is a fresh live read: if the page revision changes, restart from offset 0 rather than treating two different page states as one snapshot.

`browser_get_node` adds safe DOM details and resource references. `browser_get_text` returns AX subtree text without duplicated inline text. Password/protected values are omitted. Page addresses and link destinations omit query strings and fragments; signed resource URLs, cookies, browser handles and physical paths are private.

`browser_act` supports click, hover, replacing editable text, named keys/key combinations, wheel scrolling and choosing native SELECT options. Actions address a current node and use CDP input. Typing verifies the actual resulting value. Custom listboxes are handled by observing and clicking their option nodes. There is no public arbitrary-JavaScript, cookie or credential-export operation.

Same-process frames are read via frame IDs. Out-of-process iframe debugger sessions are attached recursively using flattened CDP targets. Navigation invalidates all previous node/resource IDs, including subframe navigation. AX/DOM events increment the revision; observations read the live tree again. This favors correctness over a brittle delta-only cache. `PAGE_CHANGED` means re-observe; `STALE_NODE` means the observed DOM element disappeared or changed. DOM-free AX text nodes remain readable but are not actionable.

Pause blocks new mutating actions and resource requests; observation remains available. In-flight synchronous input cannot be undone. Pending resource tasks wait before delivery/Send; subsequent observations read the live page after Resume. Stop/cancel prevents later Send but cannot undo a Send already committed.

## Resources and real visual input

`browser_get_resource` returns a standard `tsk_…` task immediately. Poll `browser_resource_status` at its `pollIntervalMs`; `browser_resource_cancel` is available before Send commits. Selected resources belong to exactly one session and page version.

The extraction order is:

1. Original image/media/document bytes through Chrome's browser-authenticated network resource loader.
2. Browser resource cache, when available.
3. Blob/data resources or SVG/canvas rendering in the resource's DOM context.
4. Image element screenshot, clipped to the viewport.
5. Normal viewport screenshot only when no usable image element box exists.

Audio, video and document extraction fails explicitly if original bytes cannot be read; a screenshot cannot replace them. Image metadata includes the extraction method, so a rendering fallback is never represented as the original file. HTTP redirects/authentication failures may require a screenshot fallback. Files remain byte-for-byte originals whenever original extraction succeeds; no transcoding is introduced.

The Agent saves bounded bytes under `browser-resources/` using an exclusive file create. `limits.mediaToChatMaxFileSizeMiB` also bounds resource extraction and this narrow binary ingestion endpoint. Formats are detected from bytes where possible. Large resources fail with the configured threshold rather than downloading an unbounded file. Original URLs/headers and private file paths never appear in MCP output.

By default, the saved file is attached through the existing CDP file chooser to the session's **exact dedicated conversation**. A minimal continuation identifies the resource and session. Attachment verification and user-edit monitoring remain active across the one authorized continuation insertion. A user draft, changed attachment or changed chat blocks Send; attachments and saved files remain. `addToChat:false` saves only. Media viewer widgets and Library storage are not used.

After requesting automatic delivery, the assistant should finish its current response so ChatGPT can enable Send. The Extension continues independently. Status polling/cancellation before Send is allowed, but no timer/status tool can independently wake a completed assistant turn. Once the browser sends the attachment plus continuation, the next turn can use the same session and inspect further resources.

## Tests and live verification

Automated tests cover strict schemas, hierarchy, pagination, safe DOM projection, original resource extraction, screenshot fallback, stream cleanup, size limits, CDP input, exact routing, navigation, iframe setup, popup controls, document readiness, startup cancellation, cancellation and stop. Agent tests cover byte preservation, exclusive output creation, sandbox containment, MIME detection and request limits.

Live verification must additionally cover Chrome's actual AX/iframe behavior, authenticated resources, popup duplication and ChatGPT attachment/continuation rendering. Mocked protocol checks are not a claim that a particular external site has passed a real-browser test. Test a text site first, then a dynamic logged-in site and an image-bearing page, and finally multiple independent sessions/windows with manual navigation and Pause/Stop.

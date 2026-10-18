# Browser Agent group specification

The current implementation and lifecycle are documented in [Browser Agent](BROWSER_AGENT.md). Code schemas in `extension/browser-tools.js` are authoritative.

- **Launch:** Study this site duplicates the source, creates one ChatGPT tab and groups the new pair. The source remains in place. The prompt supplies the task/language and `chatTabId` only.
- **Identity:** every call supplies the initiating `chatTabId`; page commands also supply an exact target `tabId`. Group membership is checked live. No public browser session token exists.
- **Session:** one in-memory group object contains one leading ChatGPT tab, any number of current site tabs, independent page contexts and file tasks. No Chrome Storage persistence is added.
- **Scheduling:** a shared queue per physical tab serializes page actions and file delivery; different tabs can proceed independently. Resource extraction releases the source queue before waiting for its destination. Shared debugger leases preserve retained page connections.
- **Discovery:** list current participants with pagination. New sites join automatically. A site's closure/departure cancels its work only; closing the leading chat stops the group without a replacement. Empty site lists are idle, not a permanent group failure.
- **Changes:** successful Site results passively report site additions/removals through `groupChanges`. Preserve unreported changes on errors; a missing prior snapshot requests `site_list_tabs`. Additional ChatGPT tabs are ignored and cannot connect or use Site tools.
- **References:** tab/document-scoped AX and resource IDs; main-document replacement invalidates its IDs, frame replacement only the affected subtree. Reject stale/cross-tab references before input or delivery.
- **Resources:** observed IDs only, explicit images/non-images, bounded original bytes or labelled image fallback, exclusive Workspace outputs, one ordered batch delivery to the initiating chat. Partial files survive failures and cancellation.
- **Restart:** recover the owner from its Extension-isolated page marker, mirrored on ignored ChatGPT tabs; query Chrome for current sites and reread pages. No replacement chat is elected. In-memory tasks/history do not resume. Browser restart requires new tab IDs.
- **Stop:** cancel pending group work and release automation; preserve tabs, files and drafts. Explicitly reconnect the leading chat to resume.
- **Privacy:** keep CDP handles, signed resource URLs, credentials and physical file paths outside public results. Fixed Extension-owned page functions only; no public eval parameter or focus-based target selection.

Validate mocked contracts and real Chrome/ChatGPT behavior separately. See [Development](../DEVELOPMENT.md) and [Tools](../TOOLS.md).

# Browser Agent group specification

The current implementation and lifecycle are documented in [Browser Agent](BROWSER_AGENT.md). Code schemas in `extension/browser-tools.js` are authoritative.

- **Launch:** Study this site duplicates the source, creates one ChatGPT tab and groups the new pair. The source remains in place. The prompt supplies the task/language and `chatTabId` only.
- **Identity:** every call supplies the initiating `chatTabId`; page commands also supply an exact target `tabId`. Group membership is checked live. No public browser session token exists.
- **Session:** one in-memory group object contains any number of site/ChatGPT participants, independent page contexts, tasks and notifications. No Chrome Storage persistence is added.
- **Scheduling:** a shared queue per physical tab serializes page actions, file delivery and chat messages; different tabs can proceed independently. Resource extraction releases the source queue before waiting for its destination. Shared debugger leases preserve retained page connections.
- **Discovery:** list current participants with pagination. New members join automatically. Closure/departure cancels only work involving that participant. Empty site lists are idle, not a permanent group failure.
- **Communication:** page tools can read peer chats; asynchronous message delivery addresses a specific saved peer conversation, waits for an idle/empty Composer and preserves user drafts. No automatic message forwarding loop is created.
- **Notifications:** coalesce Chrome membership events, include current membership in tool results and queue an idle-chat update if the caller has not already received it. Revalidate before Send and never retry an uncertain committed message.
- **References:** tab/document-scoped AX and resource IDs; main-document replacement invalidates its IDs, frame replacement only the affected subtree. Reject stale/cross-tab references before input or delivery.
- **Resources:** observed IDs only, explicit images/non-images, bounded original bytes or labelled image fallback, exclusive Workspace outputs, one ordered batch delivery to the initiating chat. Partial files survive failures and cancellation.
- **Restart:** rediscover current Chrome membership from `chatTabId`; reread pages. In-memory tasks/history do not resume. Browser restart requires new tab IDs.
- **Stop:** cancel pending group work and release automation; preserve tabs, files and drafts. Start a new study group to resume.
- **Privacy:** keep CDP handles, signed resource URLs, credentials and physical file paths outside public results. Fixed Extension-owned page functions only; no public eval parameter or focus-based target selection.

Validate mocked contracts and real Chrome/ChatGPT behavior separately. See [Development](../DEVELOPMENT.md) and [Tools](../TOOLS.md).

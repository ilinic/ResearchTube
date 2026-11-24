# Browser Agent group specification

The current implementation and lifecycle are documented in [Browser Agent](BROWSER_AGENT.md). Code schemas in `extension/browser-tools.js` are authoritative.

- **Launch:** Study this site duplicates the source, creates one ChatGPT tab and groups the new pair. The source remains in place. The prompt supplies the task/language, never a required numeric tab ID.
- **Identity:** the current-chat widget obtains the live initiating `chatTabId` on demand; Site calls use that ID; page commands also supply an exact target `tabId`. Group membership is checked live. No public browser session token exists.
- **Session:** one in-memory group object contains all current HTTP/HTTPS tabs, independent page contexts and file tasks. Each saved ChatGPT tab is a possible caller and target; there is no owner. No Chrome Storage persistence is added.
- **Scheduling:** a shared queue per physical tab serializes page actions and file delivery; different tabs can proceed independently. Resource extraction releases the source queue before waiting for its destination. Shared debugger leases preserve retained page connections.
- **Discovery:** list all participants with pagination. New sites and chats join automatically. Closure/departure cancels only work involving that tab; the remaining group continues. A caller without other tabs sees idle.
- **Changes:** successful Site results passively report tab additions/removals, including chats, through `groupChanges`. Track roster and page-change baselines independently for each caller. Preserve unreported changes on errors; a missing prior snapshot requests `site_list_tabs`.
- **References:** tab/document-scoped AX and resource IDs; main-document replacement invalidates its IDs, frame replacement only the affected subtree. Reject stale/cross-tab references before input or delivery.
- **Resources:** observed IDs only, explicit images/non-images, bounded original bytes or labelled image fallback, exclusive Workspace outputs, one ordered batch delivery to the initiating chat. Partial files survive failures and cancellation.
- **Restart:** recover group automation state from its Extension-isolated markers on grouped ChatGPT tabs; query Chrome for all current tabs and reread pages. Legacy marker owner IDs are ignored. In-memory tasks/history do not resume. Browser restart requires new tab IDs.
- **Stop:** cancel pending group work and release automation; preserve tabs, files and drafts. Explicitly reconnect any saved ChatGPT tab in the group to resume.
- **Privacy:** keep CDP handles, signed resource URLs, credentials and physical file paths outside public results. Fixed Extension-owned page functions only; no public eval parameter or focus-based target selection.

Validate mocked contracts and real Chrome/ChatGPT behavior separately. See [Development](../DEVELOPMENT.md) and [Tools](../TOOLS.md).

- **Browser-wide access:** current group first; other Chrome windows/groups and loose tabs appear in an independently paginated `otherTabs` inventory. Explicit `scope: "all"` allows external reads and resource extraction only. Interaction is restricted to the initiating chat's actual Chrome group, with live checks before mutations. No external focus, scroll, or input.

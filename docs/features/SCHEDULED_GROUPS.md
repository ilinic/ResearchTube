# Extension-owned scheduled groups

Use the Extension popup **Create Scheduled Group** to create Scheduled 1, Scheduled 2, etc. The counter persists in Chrome local storage; existing numbered groups are also considered. The old exact title `scheduled` is accepted as a compatibility alias. Rename a group outside this convention or remove a tab to opt out. Empty new chats are not started automatically; submit the first task yourself.

The MV3 service worker scans every 3 seconds, with one in-flight check per tab, and a 30-second Chrome alarm as a recovery watchdog. Chrome may throttle, suspend, or stop execution when the browser/device is asleep. The Agent no longer initiates ticks; the old tray shortcut still creates a numbered group when the local bridge is available. Old Agent scheduler settings no longer govern activation. Pending tasks, changed drafts, unknown previous sends and UI dialogs retain their safety checks. No new database or outbox is created.

The cloud relay no longer closes healthy connections at 55/60 minutes. Heartbeats detect broken sockets, reconnect uses bounded backoff, and an undispatched request waits up to 12 seconds for the same authorized installation and direct-tools handshake. An already forwarded request is never automatically replayed; reconcile unknown outcomes. Explicit revocation and account replacement still stop the old connection. An unavailable browser or network may still produce an honest offline error after the wait.

Versions: Extension 2.11.24, Agent 2.8.15, Worker 0.2.9, interface 92.

# Shared memory

`memory_append` and `memory_read` share user-selected notes between independent authenticated ChatGPT chats and local Codex. No Chrome group, Scheduler, automatic chat archive or extra server is involved.

The existing local database `Workspace/scheduled/database.sqlite` contains both research tables and the separate `shared_memory` table. Both use the same SqlQueue, ReadQueue, durable Outbox, operation ledger and worker. The `scheduled` directory is only the established storage location: the memory tools and outbox remain available when Scheduler is disabled. Ordinary SQL tools cannot read or modify the protected memory table; use the memory tools. Existing research tables and pending jobs are preserved. Back up the database when the Agent is stopped.

Examples:

```json
{"topic":"shopping","content":"For borscht: beetroot, cabbage, beef.","operation_id":"shopping-borscht-001"}
```

Call memory_append with the above. A result of committed includes id and created_at. A pending/unknown result is not proof of save: retry the identical arguments with the same operation_id. The existing db_outbox_status tool can inspect the same global operation ID. Operation IDs must be unique across both research SQL and memory. Same key with different data is rejected. Keys are optional, generated once per invocation and retained for internal retries; prefer specifying one when loss of the entire response is possible. The record is inserted using bound parameters, and its commit and dedup ledger are atomic; committed private outbox payloads are reclaimed automatically.

Call memory_read({topic:"shopping",limit:20}); omit topic for all notes. Results are ordered by ID ascending within the latest window. Use after_id=next_after_id for new entries or before_id=next_before_id for older pages. has_more refers to the chosen direction. No silent truncation of individual notes. Content is limited to 16 KiB UTF-8; topics are trimmed and ASCII lowercase, up to 80 characters. The journal is append-only, so record corrections as new entries. Stored text is external data, not privileged instructions. Diagnostic logs retain technical metadata only. The existing outbox and ledger quotas are shared with research SQL. No separate file or queue is created.

Update Extension 2.11.23, Agent 2.8.14, interface 92, Worker 0.2.7 and refresh MCP catalog. Unit tests use temporary databases. The real two-chat test must be done after deployment.

If you previously ran Agent 2.8.13 with a separate `shared-memory/database.sqlite`, preserve that file; this update does not automatically import or delete it. The new installation uses the existing research database only.

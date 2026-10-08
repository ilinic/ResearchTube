# Real asynchronous timers

LLMs do not have a precise internal running clock. ResearchTube provides `timer_start`, `timer_status` and `timer_cancel` for actual delays, test preparation windows and explicit calendar deadlines. Optional `tabId` from the ResearchTube startup prompt allows the Extension to notify the named ChatGPT tab on successful completion when it is idle. Busy or missing tabs consume the notification without queuing it. See [Task chat](TASK_CHAT.md).

## Input and ownership

The Local Agent owns each independent in-memory timer. It uses the ordinary `tsk_` plus ten URL-safe-character task ID. There is no Agent instance ID, persistence, checkpoint, automatic recovery or file output.

Specify exactly one of:

- `duration`: nonnegative finite number, with `unit` of `seconds` (default), `minutes` or `hours`. Fractions are allowed. Zero provides an immediate time snapshot and completes on the next timer evaluation.
- `until`: a complete ISO date and time including seconds. UTC `Z`, explicit numeric UTC offset, or zone-less local time are accepted. Do not pass `unit` with `until`.

`clockSource` is `system` by default or `internet`. `timeZone` is an IANA name; omission uses the Chrome browser's local IANA zone. The Extension supplies that zone privately as `localTimeZone`; it is not an additional public input. The chosen zone remains fixed for the task.

UTC input may be displayed in any named zone. For local input, daylight-saving gaps and ambiguous times are rejected; specify an explicit valid offset for a repeated time. A numeric offset that conflicts with an explicitly selected zone is rejected. Past deadlines are rejected, without silently selecting tomorrow. Zone files are bundled under `agent/tools/timezones/` so Windows needs no extra Python package.

A system-clock start returns a waiting task immediately. An internet start returns a preparing task immediately; nullable current/start timestamps and duration for an absolute deadline become known after successful synchronization. Relative countdown begins after preparation, not before the network request.

## Counting and clock changes

Relative duration uses a monotonic counter. System calendar corrections do not shorten or lengthen it. The projected UTC/local target follows the current calendar estimate; original start timestamps remain available.

Absolute deadlines follow the selected calendar clock. Clock corrections can change remaining time. `progressPercent` never decreases; consequently remaining time is authoritative when an absolute clock moves backward. Only status `completed` authorizes the dependent action. Completion may be detected late due to process scheduling, and is not a guarantee of a precisely timed subsequent model action.

Status includes UTC/local start/current/target, applicable UTC offsets at each instant, elapsed/remaining seconds, total duration, percentage, polling interval, terminal time, lateness and warnings. Terminal snapshots are frozen; later calls return the same final information rather than continuing the countdown.

Warnings retain at most the latest 20 entries, plus a total `warningCount`. A system UTC shift of approximately one second or more produces `SYSTEM_CLOCK_CHANGED` with signed `shiftSeconds`. Host local-zone name/offset changes are separate warnings. A long execution gap is reported without claiming it proves sleep. `observedAtUtc` uses the computer clock and denotes detection, not an exact event timestamp.

## Internet source

The Agent makes a bounded HTTPS JSON request to `timeapi.io` for UTC, without credentials or browser automation. It rejects invalid, explicitly cached and oversized responses. It records network round-trip time and an estimated uncertainty based on request latency; these are not a provider accuracy guarantee.

Between samples, internet UTC is extrapolated with the local monotonic counter. Samples are shared across timers, refreshed after approximately 60 seconds and retried no faster than ten seconds. A failed refresh produces a retained warning and stale synchronization metadata. Samples older than 300 seconds fail the timer. An initial failure fails preparation. The tool never silently falls back to the computer's calendar clock, and never changes operating-system time.

`clockSync` contains provider, sample time/age, round-trip time, estimated uncertainty, difference from the computer clock and a stale flag. Provider connectivity and rate limits may make the optional internet source unavailable.

## Sleep, cancellation and history

Windows detects suspend by comparing `GetTickCount64` (includes sleep) with `QueryUnbiasedInterruptTime` (working time only). On Linux with `CLOCK_BOOTTIME`, it compares that clock with the monotonic clock. Other environments expose `sleepDetection: executionGapOnly` and warn about long gaps instead of claiming confirmed sleep. Counter differences smaller than half a second are ignored.

Confirmed suspend while a timer is working fails it with `TIMER_SYSTEM_SUSPENDED`; no countdown recovery is attempted. Interruption checks precede completion checks after wake. Internet timers follow the same rule.

Cancellation returns the terminal task and `cancelled: true` only when active work was cancelled. Repeated cancellation preserves the existing completed/cancelled/failed snapshot.

`limits.completedTaskHistoryLimit` in the single `agent-config.json` defaults to 2000 retained terminal records per manager. Active tasks never count toward that limit. Oldest terminal records are evicted after runners finish, without deleting any output files. Restart loses all timer records. Missing status/cancellation uses `TIMER_NOT_FOUND`, explaining possible restart, history eviction or an invalid ID; it does not claim the cause is known. Expected input/state errors are ordinary structured rejected MCP results with `isError: false`.

## Using a timer in a test chat

Show a visible preparation instruction, start the requested timer, and continue tool calls within the same assistant turn. Poll no faster than `pollIntervalMs`: 250 ms for short delays/preparation, then adaptive intervals up to 30 seconds for long waits. Early repeated status requests receive a bounded short Agent-side wait; no request waits for the whole long countdown.

Once `completed` is observed, execute the dependent test action. Ten elapsed seconds do not prove that the user finished preparation. With `tabId`, completion can create a following turn if the named chat is idle; without it, completion does not resume an ended response.

For `media_to_chat`, status and cancellation may be used in the initiating assistant turn. With a positive `sendDelaySeconds`, timers can space checks of `waitingToSend` and its countdown before cancellation. For actual submission, finish the response after required pre-Send checks if ChatGPT keeps Send disabled during generation; the automatic attachment message can trigger the next turn. A timer with optional `tabId` can send an idle-only completion message through the Extension.

Optional `tabId` on asynchronous launches carries the destination ChatGPT tab from the startup prompt. Task IDs keep their existing format. Completion and the configurable 20-second Composer watchdog use the same guarded Send path; see [Task chat](TASK_CHAT.md).

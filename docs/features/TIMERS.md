# Persistent repeating chat timers

ResearchTube exposes only one kind of timer: a persistent repeating chat wake-up. Use `timer_start` once with `duration`, optional `unit` (seconds, minutes or hours), optional `timeZone` for display, and the verified current `tabId`. The interval must be at least one second. There is no one-shot pause, absolute deadline, internet-clock option or repeat switch.

Example: `{"duration":3,"unit":"minutes","tabId":42}`. The actual tab ID must be obtained from the current chat context, not copied from this example. Finish the assistant response after starting the timer; there is no need to poll until the next tick or create another timer at the end of each iteration.

The Extension persists the timer in its existing Chrome local task storage, not the Agent's SQLite database. It survives browser and Agent restart; one active timer per conversation prevents duplicate loops. The conversation ID is authoritative and the current tab ID is resolved at delivery, including a plan successor when available. A missing or ambiguous target, active generation, draft or pending task postpones delivery. Missed intervals are coalesced rather than replayed in a burst. The next interval starts after confirmed Send. There is no maximum fire count. An uncertain send is reconciled by its unique message marker; if there is no positive evidence it is not blindly replayed.

Use `timer_status` with the existing taskId to check the deadline, fireCount and pending/uncertain delivery. Use `timer_cancel` to stop future notifications. Do not start another timer on each tick. If an individual persistent task plan already drives the chat, use the plan instead of adding a redundant timer. See [Agent plans](AGENT_PLANS.md).

The legacy native one-shot timer endpoints and public arguments are removed. Legacy one-shot records in Chrome are ignored. Persistent timer records are unchanged.

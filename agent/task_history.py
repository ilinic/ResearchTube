"""Bounded terminal-task records; active work and output files are never removed."""
from __future__ import annotations

import asyncio
import time
from typing import Callable

TERMINAL_STATES = frozenset({"completed", "cancelled", "failed"})


class TaskHistory(dict):
    def __init__(self, maximum: Callable[[], int]):
        super().__init__()
        self.maximum = maximum
        self.terminal_order: dict[str, float] = {}

    def __setitem__(self, key, task):
        super().__setitem__(key, task)
        # Managers assign runner immediately after registering their task.
        try:
            asyncio.get_running_loop().call_soon(self._watch_runner, key, task)
        except RuntimeError:
            pass
        self.prune()

    def _watch_runner(self, key, task):
        runner = getattr(task, "runner", None)
        if runner is not None:
            runner.add_done_callback(lambda _: self._runner_finished(key, task))

    def _runner_finished(self, key, task):
        if self.get(key) is task and getattr(task, "status", None) in TERMINAL_STATES:
            self.terminal_order.setdefault(key, time.monotonic())
        self.prune()

    def prune(self):
        # A terminal status can precede final publication/cleanup. Keep that
        # record until its runner has actually returned.
        for key, task in self.items():
            runner = getattr(task, "runner", None)
            if getattr(task, "status", None) in TERMINAL_STATES and (runner is None or runner.done()):
                self.terminal_order.setdefault(key, time.monotonic())
            else:
                self.terminal_order.pop(key, None)
        for key in tuple(self.terminal_order):
            if key not in self:
                self.terminal_order.pop(key)
        excess = len(self.terminal_order) - self.maximum()
        for key in sorted(self.terminal_order, key=self.terminal_order.get)[:max(0, excess)]:
            self.pop(key, None)
            self.terminal_order.pop(key, None)

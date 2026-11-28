"""Task history retention and configuration contracts."""
import asyncio
import json
import unittest
from types import SimpleNamespace
from agent import researchtube_agent as agent
from agent.task_history import TaskHistory


class HistoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_evicts_oldest_terminal_only_and_limit_changes(self):
        cap = [2]
        history = TaskHistory(lambda: cap[0])
        for key in ["a", "b", "c"]:
            history[key] = SimpleNamespace(status="completed", runner=None, result={"path": "preserved.mp4"})
        history["active"] = SimpleNamespace(status="working", runner=None)
        self.assertEqual(set(history), {"b", "c", "active"})
        cap[0] = 1
        history.prune()
        self.assertEqual(set(history), {"c", "active"})
        self.assertEqual(history["c"].result["path"], "preserved.mp4")

    async def test_never_removes_runner_before_final_publication(self):
        history = TaskHistory(lambda: 1)
        gate = asyncio.Event()
        async def run(): await gate.wait()
        old = SimpleNamespace(status="completed", runner=asyncio.create_task(run()))
        history["old"] = old
        history["new"] = SimpleNamespace(status="completed", runner=None)
        history.prune()
        self.assertIn("old", history)
        await asyncio.sleep(0)
        gate.set()
        await old.runner
        await asyncio.sleep(0)
        self.assertEqual(set(history), {"old"}, "old runner actually completed last")

    async def test_completion_callback_bounds_quiet_manager(self):
        history = TaskHistory(lambda: 2)
        async def run(task):
            await asyncio.sleep(0)
            task.status = "completed"
        for i in range(10):
            task = SimpleNamespace(status="working", runner=None)
            history[str(i)] = task
            task.runner = asyncio.create_task(run(task))
        await asyncio.gather(*(t.runner for t in list(history.values())))
        await asyncio.sleep(0)
        self.assertEqual(len(history), 2)

    async def test_all_agent_managers_have_retention(self):
        for manager in [agent.TASKS, agent.SPEECH_TASKS, agent.CAPTURE_FRAME_TASKS, agent.MEDIA_CLIP_TASKS, agent.CAMERA_RECORD_TASKS, agent.VISUAL_MAP_TASKS, agent.STORYBOARD_TASKS]:
            self.assertIsInstance(manager.tasks, TaskHistory)

    async def test_config_comments_and_limit_validation(self):
        config = json.loads(agent.CONFIG_PATH.read_text())
        self.assertEqual(config["limits"]["completedTaskHistoryLimit"]["value"], 2000)
        entries = [value for key, value in config.items() if key != "limits"] + list(config["limits"].values())
        for entry in entries:
            self.assertEqual(set(entry), {"value", "comment"})
            self.assertTrue(entry["comment"].strip())
        self.assertTrue(agent.configured_new_tools_default())

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent import researchtube_agent as agent
from agent.custom_tools import CustomToolRegistry


class CustomToolsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        await agent.CUSTOM_TOOLS.shutdown()

    def logging_registry(self, directory, source, execution="sync", logger=None):
        root = Path(directory)
        package = root / "logging"
        package.mkdir()
        (package / "manifest.json").write_text(json.dumps({
            "manifestVersion": 1, "id": "example.logging", "version": "1", "groupTitle": "Logging",
            "tools": [{"name": "named_example", "title": "Example", "description": "Example.",
                       "entryPoint": "tools.py:run", "execution": execution, "inputSchema": {"type": "object"}}]
        }), encoding="utf-8")
        (package / "tools.py").write_text(source, encoding="utf-8")
        return CustomToolRegistry(root, agent.AgentApiError, logger=logger)

    async def test_sync_logs_name_and_outcome_without_percentage_or_payloads(self):
        lines = []
        with tempfile.TemporaryDirectory() as directory:
            registry = self.logging_registry(directory,
                "def run(arguments, context):\n"
                "    context.progress(12.5, 'PRIVATE progress message')\n"
                "    return {'progressPercent': 87.5, 'text': arguments['text']}\n", logger=lines.append)
            result = await registry.call("named_example", {"text": "PRIVATE input"})
            self.assertEqual(result["result"]["text"], "PRIVATE input")
            self.assertEqual(lines, ["named_example -> working", "named_example -> completed"])
            self.assertNotIn("PRIVATE", "\n".join(lines))
            await registry.shutdown()

    async def test_async_logs_live_progress_completion_and_cancellation(self):
        lines = []
        with tempfile.TemporaryDirectory() as directory:
            registry = self.logging_registry(directory,
                "import asyncio\n"
                "async def run(arguments, context):\n"
                "    context.progress(37.5, 'PRIVATE progress message')\n"
                "    await asyncio.sleep(arguments['delay'])\n"
                "    return {'done': True}\n", execution="task", logger=lines.append)
            start = await registry.call("named_example", {"delay": 0})
            task_id = start["task"]["taskId"]
            await registry.tasks[task_id].runner
            self.assertIn(f"named_example taskId={task_id} -> working 37.5%", lines)
            self.assertIn(f"named_example taskId={task_id} -> completed 100%", lines)
            start = await registry.call("named_example", {"delay": 60})
            task_id = start["task"]["taskId"]
            await asyncio.sleep(0)
            await registry.cancel(task_id)
            await asyncio.gather(registry.tasks[task_id].runner, return_exceptions=True)
            self.assertIn(f"named_example taskId={task_id} -> cancelled 37.5%", lines)
            self.assertNotIn("PRIVATE", "\n".join(lines))
            await registry.shutdown()

    async def test_logging_failures_preserve_results_and_tool_errors(self):
        def broken_logger(message):
            raise OSError("console closed")
        with tempfile.TemporaryDirectory() as directory:
            registry = self.logging_registry(directory,
                "def run(arguments, context):\n"
                "    context.progress(25, 'Progress')\n"
                "    if arguments.get('fail'): raise ValueError('PRIVATE error')\n"
                "    return {'ok': True}\n", logger=broken_logger)
            self.assertEqual((await registry.call("named_example", {}))["result"], {"ok": True})
            with self.assertRaises(agent.AgentApiError) as raised:
                await registry.call("named_example", {"fail": True})
            self.assertEqual(raised.exception.code, "CUSTOM_TOOL_EXECUTION_FAILED")
            lines = []
            registry.logger = lines.append
            with self.assertRaises(agent.AgentApiError):
                await registry.call("named_example", {"fail": True})
            self.assertEqual(lines[-1], "named_example -> failed")
            self.assertNotIn("PRIVATE", "\n".join(lines))
            await registry.shutdown()

    async def test_agent_request_logs_resolve_custom_names_and_real_percentages(self):
        class Writer:
            def write(self, data): pass
            async def drain(self): pass
            def close(self): pass
            async def wait_closed(self): pass
        async def request(method, path, payload=None):
            body = json.dumps(payload).encode() if payload is not None else b""
            reader = asyncio.StreamReader()
            reader.feed_data(f"{method} {path} HTTP/1.1\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
            reader.feed_eof()
            await agent.handle_client(reader, Writer())
        with tempfile.TemporaryDirectory() as directory:
            registry = self.logging_registry(directory,
                "def run(arguments, context): return {'progressPercent': 42.5, 'private': 'PRIVATE'}\n")
            with patch.object(agent, "CUSTOM_TOOLS", registry), patch.object(agent, "log") as logged:
                await request("POST", "/custom-tools/call", {"name": "named_example", "arguments": {}})
                logged.assert_called_with("POST /custom-tools/named_example -> 200 completed")
            await registry.shutdown()
        task_id = "ct_abcdefghijk"
        doc = {"tool": "wait_seconds", "taskId": task_id, "status": "working", "progressPercent": 37.5}
        for path, body, expected in [
            ("/custom-tools/call", {"kind": "task", "task": doc}, f"/custom-tools/wait_seconds/{task_id}"),
            (f"/custom-tools/tasks/{task_id}", doc, f"/custom-tools/wait_seconds/{task_id}"),
            (f"/custom-tools/tasks/{task_id}/cancel", doc, f"/custom-tools/wait_seconds/{task_id}/cancel"),
        ]:
            self.assertEqual(agent.compact_custom_tool_log_path(path, body), expected)
            self.assertEqual(agent.response_log_suffix(path, body), " working 37.5%")
        for progress in [42.5, True, "50", -1, 101, float("nan"), float("inf")]:
            self.assertEqual(agent.response_log_suffix("/custom-tools/call", {"kind": "result", "result": {"progressPercent": progress}}), " completed")
            self.assertEqual(agent.response_log_suffix(f"/custom-tools/tasks/{task_id}", {**doc, "progressPercent": progress}), " working 42.5%" if progress == 42.5 else " working")

    async def test_bundled_example_has_sync_and_async_tools(self):
        catalog = agent.CUSTOM_TOOLS.catalog()
        self.assertEqual(catalog["errors"], [])
        self.assertEqual([tool["name"] for tool in catalog["tools"]], ["count_words", "wait_seconds"])
        self.assertEqual(catalog["tools"][0]["_meta"]["researchtube/customTool"]["groupTitle"], "Custom Toolset")
        self.assertEqual(catalog["tools"][1]["_meta"]["researchtube/customTool"]["execution"], "task")
        result = await agent.CUSTOM_TOOLS.call("count_words", {"text": "one two three"})
        self.assertEqual(result["result"]["wordCount"], 3)
        task = await agent.CUSTOM_TOOLS.call("wait_seconds", {"seconds": 1})
        self.assertEqual(task["kind"], "task")
        await asyncio.sleep(1.1)
        self.assertEqual(agent.CUSTOM_TOOLS.status(task["task"]["taskId"])["status"], "completed")

    async def test_package_can_expose_multiple_tools_and_reject_bad_entrypoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "example"
            package.mkdir()
            (package / "manifest.json").write_text(json.dumps({
                "manifestVersion": 1, "id": "example.package", "version": "1", "groupTitle": "Example",
                "tools": [{"name": "echo_value", "title": "Echo", "description": "Echo.", "entryPoint": "tools.py:echo", "inputSchema": {"type": "object"}}]
            }), encoding="utf-8")
            (package / "tools.py").write_text("def echo(arguments, context): return {'value': arguments['value']}\n", encoding="utf-8")
            registry = CustomToolRegistry(root, agent.AgentApiError)
            self.assertEqual((await registry.call("echo_value", {"value": "ok"}))["result"], {"value": "ok"})
            await registry.shutdown()
            (package / "manifest.json").write_text(json.dumps({
                "manifestVersion": 1, "id": "example.package", "version": "1", "groupTitle": "Example",
                "tools": [{"name": "bad_tool", "title": "Bad", "description": "Bad.", "entryPoint": "../outside.py:run", "inputSchema": {"type": "object"}}]
            }), encoding="utf-8")
            registry.reload()
            self.assertEqual(registry.catalog()["tools"], [])
            self.assertEqual(registry.catalog()["errors"][0]["code"], "CUSTOM_TOOL_ENTRYPOINT_INVALID")

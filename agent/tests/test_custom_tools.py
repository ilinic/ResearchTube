import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from agent import researchtube_agent as agent
from agent.custom_tools import CustomToolRegistry


class CustomToolsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        await agent.CUSTOM_TOOLS.shutdown()

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

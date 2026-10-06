"""Startup-only diagnostics and cached, nonblocking loopback health behavior."""
from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, Mock, patch

from agent import researchtube_agent as agent


class StartupHealthTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.previous = agent.HEALTH_SNAPSHOT, agent.PUBLIC_HEALTH_SNAPSHOT
        self.patches = [
            patch.object(agent, "public_platform_metadata", return_value={
                "operatingSystem": "Windows", "release": "11", "version": "test", "architecture": "AMD64"}),
            patch.object(agent, "workspace_health", return_value={"status": "available", "availableBytes": 123}),
            patch.object(agent, "log"),
        ]
        for item in self.patches:
            item.start()

    async def asyncTearDown(self):
        agent.HEALTH_SNAPSHOT, agent.PUBLIC_HEALTH_SNAPSHOT = self.previous
        for item in reversed(self.patches):
            item.stop()

    async def get_health(self, server):
        port = server.sockets[0].getsockname()[1]
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        await writer.drain()
        response = await reader.read()
        writer.close()
        await writer.wait_closed()
        headers, body = response.split(b"\r\n\r\n", 1)
        self.assertIn(b"200 OK", headers)
        return json.loads(body)

    async def test_pending_health_answers_without_probes_config_or_filesystem(self):
        initial = agent.initialize_health_snapshot()
        self.assertEqual(initial["chromeAutomation"]["state"], "checking")
        self.assertTrue(all(c["status"] == "checking" for c in initial["components"].values()))
        with patch.object(agent, "component_health", new=AsyncMock(side_effect=AssertionError("No probe"))) as components, \
             patch.object(agent, "chrome_automation_status", new=AsyncMock(side_effect=AssertionError("No Chrome query"))) as chrome, \
             patch.object(agent, "workspace_health", side_effect=AssertionError("No filesystem check")), \
             patch.object(agent, "read_agent_config", side_effect=AssertionError("No config read")) as config, \
             patch.object(agent, "public_health_document", side_effect=AssertionError("No projection rebuilt")):
            server = await asyncio.start_server(agent.handle_client, "127.0.0.1", 0)
            async with server:
                results = await asyncio.wait_for(asyncio.gather(*(self.get_health(server) for _ in range(8))), 1)
            self.assertTrue(all(result == results[0] for result in results))
            self.assertEqual(results[0]["interfaceVersion"], agent.INTERFACE_VERSION)
            self.assertEqual(results[0]["chromeAutomation"]["state"], "checking")
            self.assertIs(await agent.health_snapshot(), initial)
            components.assert_not_awaited()
            chrome.assert_not_awaited()
            config.assert_not_called()

    async def test_diagnostics_publish_independently_once_and_remain_cached(self):
        initial = agent.initialize_health_snapshot()
        components_release = asyncio.Event()
        chrome_release = asyncio.Event()
        chrome_started = asyncio.Event()
        async def component(name, definition):
            await components_release.wait()
            return name, {"status": "available", "version": "1", "source": "local",
                          "privatePath": "C:/private/tool.exe", "message": None}
        async def provider():
            await components_release.wait()
            return "youtubePoTokenProvider", {"status": "missing", "version": None,
                                               "source": "local", "privatePath": "C:/private/provider", "message": None}
        async def chrome():
            chrome_started.set()
            await chrome_release.wait()
            return {"state": "enabled", "chromeRunning": True, "browserInstances": 1, "message": "Enabled"}
        with patch.object(agent, "component_health", new=AsyncMock(side_effect=component)) as component_mock, \
             patch.object(agent, "youtube_pot_provider_health", new=AsyncMock(side_effect=provider)) as provider_mock, \
             patch.object(agent, "chrome_automation_status", new=AsyncMock(side_effect=chrome)) as chrome_mock:
            task = asyncio.create_task(agent.collect_startup_health(initial))
            try:
                await asyncio.wait_for(chrome_started.wait(), 1)
                components_release.set()
                for _ in range(10):
                    await asyncio.sleep(0)
                    if all(c["status"] != "checking" for c in initial["components"].values()):
                        break
                self.assertTrue(all(c["status"] != "checking" for c in initial["components"].values()))
                pending = agent.cached_public_health()
                self.assertEqual(pending["chromeAutomation"]["state"], "checking")
                self.assertNotIn("C:/private", json.dumps(pending))
                self.assertNotIn("privatePath", json.dumps(pending))
                chrome_release.set()
                await asyncio.wait_for(task, 1)
                cached = agent.cached_public_health()
                chrome_mock.side_effect = AssertionError("Must not refresh")
                for _ in range(20):
                    self.assertIs(agent.cached_public_health(), cached)
                    await agent.health_snapshot()
                self.assertEqual(cached["chromeAutomation"]["state"], "enabled")
                self.assertEqual(component_mock.await_count, len(agent.COMPONENTS))
                provider_mock.assert_awaited_once()
                chrome_mock.assert_awaited_once()
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def test_failed_checks_do_not_remain_checking_or_block_health(self):
        initial = agent.initialize_health_snapshot()
        with patch.object(agent, "component_health", new=AsyncMock(side_effect=OSError())), \
             patch.object(agent, "youtube_pot_provider_health", new=AsyncMock(side_effect=OSError())), \
             patch.object(agent, "chrome_automation_status", new=AsyncMock(side_effect=OSError())):
            await agent.collect_startup_health(initial)
        cached = agent.cached_public_health()
        self.assertTrue(all(c["status"] == "error" for c in cached["components"].values()))
        self.assertEqual(cached["chromeAutomation"]["state"], "unknown")
        self.assertEqual(cached["status"], "ok")

    async def test_server_and_startup_log_do_not_wait_for_diagnostics(self):
        release = asyncio.Event()
        started = asyncio.Event()
        server_ready = asyncio.Event()
        server_holder = []
        original_start = asyncio.start_server
        async def bind(*args, **kwargs):
            server = await original_start(*args, **kwargs)
            server_holder.append(server)
            return server
        def startup_log(snapshot, port):
            self.assertEqual(snapshot["chromeAutomation"]["state"], "checking")
            server_ready.set()
        async def diagnostics(snapshot):
            started.set()
            await release.wait()
        with patch.object(asyncio, "start_server", side_effect=bind), \
             patch.object(agent, "log_startup_health", side_effect=startup_log), \
             patch.object(agent, "collect_startup_health", side_effect=diagnostics) as probe:
            runner = asyncio.create_task(agent.serve(0))
            try:
                await asyncio.wait_for(server_ready.wait(), 1)
                await asyncio.wait_for(started.wait(), 1)
                result = await asyncio.wait_for(self.get_health(server_holder[0]), 1)
                self.assertEqual(result["chromeAutomation"]["state"], "checking")
                self.assertFalse(release.is_set())
                probe.assert_awaited_once()
            finally:
                runner.cancel()
                await asyncio.gather(runner, return_exceptions=True)
            self.assertFalse(server_holder[0].is_serving())

    async def test_cancelled_probe_reaps_its_child(self):
        entered = asyncio.Event()
        process = AsyncMock()
        process.returncode = None
        async def communicate():
            entered.set()
            await asyncio.Event().wait()
        process.communicate.side_effect = communicate
        def kill():
            process.returncode = -9
        process.kill = Mock(side_effect=kill)
        with patch.object(asyncio, "create_subprocess_exec", return_value=process):
            task = asyncio.create_task(agent.health_process_output(("probe",), 3))
            await entered.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        process.kill.assert_called_once()
        process.wait.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()

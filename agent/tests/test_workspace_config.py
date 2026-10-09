"""Configured Workspace startup, real loopback routing and stable run root."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent import researchtube_agent as agent


class WorkspaceConfigTests(unittest.IsolatedAsyncioTestCase):
    async def test_server_uses_configured_root_until_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            config = root / 'agent-config.json'
            legacy = root / 'workspace'
            legacy.mkdir()
            (legacy / 'keep.txt').write_text('original', encoding='utf-8')
            new_root = root / 'other disk' / 'user workspace'
            servers = []
            bound = asyncio.Event()
            real_start = asyncio.start_server

            async def bind(*args, **kwargs):
                server = await real_start(*args, **kwargs)
                servers.append(server)
                return server

            async def diagnostics(_snapshot):
                await asyncio.Event().wait()

            async def request(method, path, payload=None):
                port = servers[-1].sockets[0].getsockname()[1]
                reader, writer = await asyncio.open_connection('127.0.0.1', port)
                body = json.dumps(payload).encode() if payload is not None else b''
                headers = f'{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n'.encode()
                writer.write(headers + body)
                await writer.drain()
                response = await asyncio.wait_for(reader.read(), 2)
                writer.close()
                await writer.wait_closed()
                status, content = response.split(b'\r\n\r\n', 1)
                return status, json.loads(content)

            with patch.object(agent, 'ROOT', root), patch.object(agent, 'CONFIG_PATH', config), \
                 patch.object(agent, 'WORKSPACE_PATH', legacy), patch.object(agent, 'HEALTH_SNAPSHOT'), \
                 patch.object(agent, 'PUBLIC_HEALTH_SNAPSHOT'), patch.object(agent, 'log'), \
                 patch.object(agent, 'log_startup_health', side_effect=lambda *_: bound.set()), \
                 patch.object(agent, 'collect_startup_health', side_effect=diagnostics), \
                 patch.object(asyncio, 'start_server', side_effect=bind):
                for configured in [str(new_root), 'next workspace']:
                    config.write_text(json.dumps({'workspacePath': {'value': configured}}), encoding='utf-8')
                    expected = new_root if configured == str(new_root) else root / configured
                    bound.clear()
                    runner = asyncio.create_task(agent.serve(0))
                    try:
                        await asyncio.wait_for(bound.wait(), 2)
                        self.assertEqual(agent.WORKSPACE_PATH, expected)
                        self.assertTrue(expected.is_dir())
                        status, health = await request('GET', '/health')
                        self.assertIn(b'200 OK', status)
                        self.assertEqual(health['workspace']['status'], 'available')
                        self.assertNotIn(str(root), json.dumps(health))
                        # Editing the setting while running cannot redirect I/O.
                        config.write_text(json.dumps({'workspacePath': {'value': 'unused'}}), encoding='utf-8')
                        status, result = await request('POST', '/workspace/mkdir', {'path': 'captures/test'})
                        self.assertIn(b'200 OK', status)
                        self.assertTrue((expected / 'captures/test').is_dir())
                        self.assertNotIn(str(root), json.dumps(result))
                        self.assertFalse((root / 'unused').exists())
                        status, _ = await request('POST', '/workspace/mkdir', {'path': '../outside'})
                        self.assertIn(b'400', status)
                        self.assertFalse((root / 'outside').exists())
                    finally:
                        runner.cancel()
                        await asyncio.gather(runner, return_exceptions=True)
                    self.assertFalse(servers[-1].is_serving())
                self.assertEqual((legacy / 'keep.txt').read_text(encoding='utf-8'), 'original')
                self.assertTrue((new_root / 'captures/test').is_dir(), 'old output is preserved after switching roots')


if __name__ == '__main__':
    unittest.main()

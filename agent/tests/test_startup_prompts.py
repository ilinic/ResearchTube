"""Editable popup prompts: validation, isolation and loopback startup snapshots."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from agent import researchtube_agent as agent


class StartupPromptTests(unittest.IsolatedAsyncioTestCase):
    async def test_numbered_variants_are_inactive_until_renamed(self):
        shipped = json.loads((Path(agent.__file__).parent / 'agent-config.json').read_text(encoding='utf-8'))
        keys = ['studyThisSitePrompt', 'describeThisVideoPrompt']
        active = {key: shipped[key]['value'] for key in keys}
        original = {key: shipped[key + '1']['value'] for key in keys}
        for key in keys:
            self.assertIn('in English', active[key])
            self.assertNotIn('in my language', active[key])
            self.assertIn('in my language', original[key])
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'agent-config.json'
            with patch.object(agent, 'CONFIG_PATH', config):
                # High numbers and experimental unused text never influence selection.
                entries = {key: shipped[key] for key in keys}
                for key in keys:
                    entries[key + '1'] = shipped[key + '1']
                    entries[key + '123'] = {'value': 'Unused [experimental_placeholder]'}
                config.write_text(json.dumps(entries), encoding='utf-8')
                self.assertEqual(agent.configured_startup_prompts(), active)
                # Switch purely by renaming keys; both saved texts remain intact.
                for key in keys:
                    entries[key + '2'] = entries.pop(key)
                    entries[key] = entries.pop(key + '1')
                config.write_text(json.dumps(entries), encoding='utf-8')
                self.assertEqual(agent.configured_startup_prompts(), original)
                for key in keys:
                    self.assertEqual(entries[key + '2']['value'], active[key])
                    del entries[key]
                config.write_text(json.dumps(entries), encoding='utf-8')
                self.assertEqual(agent.configured_startup_prompts(), {}, 'never auto-select a numbered variant')

    async def test_startup_snapshot_is_stable_until_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = root / 'agent-config.json'
            ready = asyncio.Event()
            servers = []
            real_start = asyncio.start_server

            async def bind(*args, **kwargs):
                server = await real_start(*args, **kwargs)
                servers.append(server)
                return server

            async def diagnostics(_snapshot):
                await asyncio.Event().wait()

            def save(prompts):
                config.write_text(json.dumps({
                    **{key: {'value': value} for key, value in prompts.items()},
                    'studyThisSitePrompt1': {'value': 'Inactive site prompt'},
                    'describeThisVideoPrompt99': {'value': 'Inactive video prompt'},
                    'workspacePath': {'value': str(root / 'PRIVATE' / 'workspace')},
                }), encoding='utf-8')

            async def get():
                reader, writer = await asyncio.open_connection('127.0.0.1', servers[-1].sockets[0].getsockname()[1])
                writer.write(b'GET /internal/prompt-templates HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
                await writer.drain()
                response = await asyncio.wait_for(reader.read(), 2)
                writer.close()
                await writer.wait_closed()
                headers, body = response.split(b'\r\n\r\n', 1)
                self.assertIn(b'200 OK', headers)
                return json.loads(body)

            initial = {
                'studyThisSitePrompt': 'Исследуй [site_title] [site_link]\n[chat_tab_id] [site_tab_id] [group_id]',
                'describeThisVideoPrompt': 'Опиши 🐈 [video_title]\n[video_link] [chat_tab_id]',
            }
            updated = {'studyThisSitePrompt': 'Updated [chat_tab_id]'}
            with patch.object(agent, 'CONFIG_PATH', config), patch.object(agent, 'ROOT', root), \
                 patch.object(agent, 'WORKSPACE_PATH', root / 'workspace'), \
                 patch.object(agent, 'STARTUP_PROMPTS', {}), patch.object(agent, 'log'), \
                 patch.object(agent, 'initialize_health_snapshot', return_value={}), \
                 patch.object(agent, 'log_startup_health', side_effect=lambda *_: ready.set()), \
                 patch.object(agent, 'collect_startup_health', side_effect=diagnostics), \
                 patch.object(asyncio, 'start_server', side_effect=bind):
                # Each real Agent run loads once, then ignores file edits.
                for expected in [initial, updated, {}]:
                    save(expected)
                    ready.clear()
                    runner = asyncio.create_task(agent.serve(0))
                    try:
                        await asyncio.wait_for(ready.wait(), 2)
                        self.assertEqual(await get(), expected)
                        save({'studyThisSitePrompt': '[typo]'})
                        with patch.object(agent, 'read_agent_config', side_effect=AssertionError('request read config')):
                            self.assertEqual(await get(), expected)
                            self.assertEqual(await get(), expected)
                        self.assertNotIn('PRIVATE', json.dumps(await get()))
                    finally:
                        runner.cancel()
                        await asyncio.gather(runner, return_exceptions=True)
                    self.assertFalse(servers[-1].is_serving())

    async def test_invalid_prompt_stops_startup_before_binding(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'agent-config.json'
            config.write_text(json.dumps({'studyThisSitePrompt': {'value': '[typo]'}}), encoding='utf-8')
            with patch.object(agent, 'CONFIG_PATH', config), patch.object(asyncio, 'start_server') as bind:
                with self.assertRaises(agent.AgentApiError) as raised:
                    await agent.serve(0)
                self.assertEqual(raised.exception.code, 'CONFIG_INVALID')
                bind.assert_not_called()

    async def test_template_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'agent-config.json'
            with patch.object(agent, 'CONFIG_PATH', config):
                for key, value in [
                    ('studyThisSitePrompt', ''), ('studyThisSitePrompt', ' \n'),
                    ('studyThisSitePrompt', 3), ('studyThisSitePrompt', None),
                    ('studyThisSitePrompt', 'x' * 16001),
                    ('studyThisSitePrompt', '[video_link]'),
                    ('describeThisVideoPrompt', '[session_id]'),
                ]:
                    with self.subTest(key=key, value_type=type(value).__name__):
                        config.write_text(json.dumps({key: {'value': value}}), encoding='utf-8')
                        with self.assertRaises(agent.AgentApiError) as raised:
                            agent.configured_startup_prompts()
                        self.assertEqual(raised.exception.code, 'CONFIG_INVALID')
                config.write_text(json.dumps({'studyThisSitePrompt': {'value': '🐈' * 16000}}), encoding='utf-8')
                self.assertEqual(agent.configured_startup_prompts()['studyThisSitePrompt'], '🐈' * 16000)
                config.write_text(json.dumps({'studyThisSitePrompt': {'value': 'Plain [not a placeholder]'}}), encoding='utf-8')
                self.assertEqual(agent.configured_startup_prompts()['studyThisSitePrompt'], 'Plain [not a placeholder]')


if __name__ == '__main__':
    unittest.main()

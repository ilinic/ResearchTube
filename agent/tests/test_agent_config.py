"""Validate the human-editable configuration boundary and live value changes."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from agent import researchtube_agent as agent


class AgentConfigTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.path = Path(self.folder.name) / 'agent-config.json'
        self.original = json.loads(agent.CONFIG_PATH.read_text(encoding='utf-8'))
        self.path.write_text(json.dumps(self.original), encoding='utf-8')
        self.override = patch.object(agent, 'CONFIG_PATH', self.path)
        self.override.start()

    def tearDown(self):
        self.override.stop()
        self.folder.cleanup()

    def write(self, document):
        self.path.write_text(json.dumps(document), encoding='utf-8')

    def test_values_are_unwrapped_without_comments_in_runtime_result(self):
        self.original['port']['value'] = 18999
        self.original['newToolsEnabledByDefault']['value'] = False
        self.original['visualMapTimestampFont']['value'] = 'Example.otf'
        self.original['limits']['completedTaskHistoryLimit']['value'] = 3
        self.write(self.original)
        self.assertEqual(agent.configured_port(), 18999)
        self.assertFalse(agent.configured_new_tools_default())
        self.assertEqual(agent.configured_visual_map_timestamp_font(), 'Example.otf')
        self.assertEqual(agent.configured_task_history_limit(), 3)
        self.assertEqual(agent.configured_tool_limits()['completedTaskHistoryLimit'], 3)
        self.assertNotIn('comment', agent.read_agent_config())

    def test_comment_edits_do_not_change_settings_and_values_reload(self):
        before = agent.read_agent_config()
        self.original['limits']['mediaClipMaxSegments']['comment'] = 'Any helpful text'
        self.write(self.original)
        self.assertEqual(agent.read_agent_config(), before)
        self.original['limits']['mediaClipMaxSegments']['value'] = 7
        self.write(self.original)
        self.assertEqual(agent.configured_tool_limits()['mediaClipMaxSegments'], 7)

    def test_invalid_structure_reports_setting_name(self):
        cases = [([], 'object'), ({'port': 17843}, 'port'),
                 ({'port': {'comment': 'Missing value'}}, 'port'),
                 ({'port': {'value': 17843, 'unexpected': True}}, 'port'),
                 ({'limits': []}, 'limits'),
                 ({'limits': {'mediaClipMaxSegments': {'value': 2, 'comment': False}}}, 'limits.mediaClipMaxSegments.comment')]
        for document, name in cases:
            with self.subTest(document=document):
                self.write(document)
                with self.assertRaises(agent.AgentApiError) as raised:
                    agent.read_agent_config()
                self.assertEqual(raised.exception.code, 'CONFIG_INVALID')
                self.assertIn(name, raised.exception.message)

    def test_wrong_types_ranges_and_unknown_limits_are_rejected(self):
        for value in [True, 0, -1, 100001, '2000', None]:
            self.write({'limits': {'completedTaskHistoryLimit': {'value': value}}})
            with self.assertRaises(agent.AgentApiError) as raised:
                agent.configured_tool_limits()
            self.assertIn('completedTaskHistoryLimit', raised.exception.message)
        self.write({'limits': {'unknown': {'value': 2}}})
        with self.assertRaises(agent.AgentApiError):
            agent.configured_tool_limits()
        self.write({'newToolsEnabledByDefault': {'value': 'false'}})
        with self.assertRaises(agent.AgentApiError):
            agent.configured_new_tools_default()

    def test_defaults_and_cleanup_fallback(self):
        self.write({})
        self.assertEqual(agent.configured_port(), 17843)
        self.assertTrue(agent.configured_new_tools_default())
        self.assertEqual(agent.configured_tool_limits(), agent.DEFAULT_TOOL_LIMITS)
        self.path.write_text('{ broken', encoding='utf-8')
        self.assertEqual(agent.configured_task_history_limit(), 2000)
        self.assertEqual(agent.configured_port(), 17843)
        with self.assertRaises(agent.AgentApiError):
            agent.configured_tool_limits()
        self.write({'port': {'value': True}})
        self.assertEqual(agent.configured_port(), 17843)

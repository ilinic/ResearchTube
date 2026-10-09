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

    def test_workspace_default_relative_and_absolute_paths(self):
        self.assertEqual(self.original['workspacePath']['value'], 'workspace')
        with patch.object(agent, 'ROOT', Path(self.folder.name)):
            self.write({})
            self.assertEqual(agent.configured_workspace_path(), Path(self.folder.name) / 'workspace')
            self.write({'workspacePath': {'value': 'media/Workspace with spaces'}})
            self.assertEqual(agent.configured_workspace_path(), Path(self.folder.name) / 'media/Workspace with spaces')
            absolute = Path(self.folder.name) / 'separate location'
            self.write({'workspacePath': {'value': str(absolute)}})
            self.assertEqual(agent.configured_workspace_path(), absolute)
            self.assertFalse(absolute.exists(), 'resolving config does not create or move files')

    def test_invalid_workspace_paths_do_not_fall_back(self):
        for value in ['', ' \t ', '\0bad', None, True, 12, [], {}]:
            with self.subTest(value=value):
                self.write({'workspacePath': {'value': value}})
                with self.assertRaises(agent.AgentApiError) as raised:
                    agent.configured_workspace_path()
                self.assertEqual(raised.exception.code, 'CONFIG_INVALID')
                self.assertIn('workspacePath', raised.exception.message)

    def test_invalid_workspace_config_stops_startup_before_binding(self):
        self.write({'workspacePath': {'value': ''}})
        with patch.object(agent, 'parse_args', return_value=type('Args', (), {'port': 17843})()), \
             patch.object(agent, 'clear_console'), patch.object(agent, 'log') as logged, \
             patch.object(agent.asyncio, 'start_server') as bind:
            self.assertEqual(agent.main(), 1)
            bind.assert_not_called()
            self.assertIn('CONFIG_INVALID', logged.call_args.args[0])
            self.assertIn('workspacePath', logged.call_args.args[0])

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

    def test_default_upload_size_is_twenty_mib_for_both_destinations(self):
        for key in ['libraryStoreMaxFileSizeMiB', 'mediaToChatMaxFileSizeMiB']:
            self.assertEqual(self.original['limits'][key]['value'], 20)
            self.assertEqual(agent.configured_tool_limits()[key], 20)
        self.write({})
        for key in ['libraryStoreMaxFileSizeMiB', 'mediaToChatMaxFileSizeMiB']:
            self.assertEqual(agent.configured_tool_limits()[key], 20)

    def test_image_widget_timeout_defaults_validation_and_live_edits(self):
        self.assertEqual(self.original['mediaWidgetHandshakeTimeoutSeconds']['value'], 10)
        self.assertEqual(agent.configured_media_widget_handshake_timeout(), 10)
        self.write({})
        self.assertEqual(agent.configured_media_widget_handshake_timeout(), 10)
        for value in [1, 7, 300]:
            self.write({'mediaWidgetHandshakeTimeoutSeconds': {'value': value}})
            self.assertEqual(agent.configured_media_widget_handshake_timeout(), value)
        for value in [True, 0, -1, 301, 1.5, '10', None]:
            self.write({'mediaWidgetHandshakeTimeoutSeconds': {'value': value}})
            with self.assertRaises(agent.AgentApiError) as raised:
                agent.configured_media_widget_handshake_timeout()
            self.assertEqual(raised.exception.code, 'CONFIG_INVALID')
            self.assertIn('mediaWidgetHandshakeTimeoutSeconds', raised.exception.message)

    def test_browser_study_grouping_defaults_and_live_edits(self):
        self.assertTrue(self.original['browserStudyGroupTabs']['value'])
        self.assertTrue(agent.configured_browser_study_group_tabs())
        self.write({})
        self.assertTrue(agent.configured_browser_study_group_tabs())
        for value in [False, True]:
            self.write({'browserStudyGroupTabs': {'value': value}})
            self.assertIs(agent.configured_browser_study_group_tabs(), value)
        for value in [None, 1, 0, 'true', [], {}]:
            self.write({'browserStudyGroupTabs': {'value': value}})
            with self.assertRaises(agent.AgentApiError) as raised:
                agent.configured_browser_study_group_tabs()
            self.assertEqual(raised.exception.code, 'CONFIG_INVALID')
            self.assertIn('browserStudyGroupTabs', raised.exception.message)

    def test_browser_study_logging_defaults_and_live_edits(self):
        self.assertTrue(self.original['browserStudyDetailedLogging']['value'])
        self.assertTrue(agent.configured_browser_study_detailed_logging())
        self.write({})
        self.assertTrue(agent.configured_browser_study_detailed_logging())
        for value in [False, True]:
            self.write({'browserStudyDetailedLogging': {'value': value}})
            self.assertIs(agent.configured_browser_study_detailed_logging(), value)
        for value in [None, 1, 0, 'true', [], {}]:
            self.write({'browserStudyDetailedLogging': {'value': value}})
            with self.assertRaises(agent.AgentApiError) as raised:
                agent.configured_browser_study_detailed_logging()
            self.assertEqual(raised.exception.code, 'CONFIG_INVALID')
            self.assertIn('browserStudyDetailedLogging', raised.exception.message)

    def test_browser_study_observation_defaults_ceilings_and_validation(self):
        defaults = {'maxNodes': 200, 'maxChars': 48000}
        self.assertEqual(agent.configured_browser_study_observation(), defaults)
        self.write({})
        self.assertEqual(agent.configured_browser_study_observation(), defaults)
        for name, output, minimum, maximum in [
            ('browserStudyMaxNodes', 'maxNodes', 1, 1000),
            ('browserStudyMaxChars', 'maxChars', 1000, 100000),
        ]:
            for value in [minimum, maximum]:
                self.write({name: {'value': value, 'comment': 'Readable limit'}})
                self.assertEqual(agent.configured_browser_study_observation()[output], value)
            for value in [True, minimum - 1, maximum + 1, 1.5, '200', None]:
                self.write({name: {'value': value}})
                with self.assertRaises(agent.AgentApiError) as raised:
                    agent.configured_browser_study_observation()
                self.assertEqual(raised.exception.code, 'CONFIG_INVALID')
                self.assertIn(name, raised.exception.message)

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

    def test_composer_retry_defaults_live_edits_and_validation(self):
        defaults = {'retryCount': 15, 'retryIntervalSeconds': 2}
        self.assertEqual(agent.configured_composer_media_retry(), defaults)
        self.write({})
        self.assertEqual(agent.configured_composer_media_retry(), defaults)
        for name, output, maximum in [('composerMediaRetryCount', 'retryCount', 300),
                                      ('composerMediaRetryIntervalSeconds', 'retryIntervalSeconds', 60)]:
            for value in [1, maximum]:
                self.write({name: {'value': value, 'comment': 'Human-readable explanation'}})
                self.assertEqual(agent.configured_composer_media_retry()[output], value)
            for value in [True, 0, -1, maximum + 1, 1.5, '2', None]:
                self.write({name: {'value': value}})
                with self.assertRaises(agent.AgentApiError) as raised:
                    agent.configured_composer_media_retry()
                self.assertEqual(raised.exception.code, 'CONFIG_INVALID')
                self.assertIn(name, raised.exception.message)

    def test_composer_auto_send_timeout_defaults_live_edits_and_validation(self):
        self.write({})
        self.assertEqual(agent.configured_composer_auto_send_timeout(), 20)
        for value in [1, 20, 600, 3600]:
            self.write({'composerAutoSendTimeoutSeconds': {'value': value, 'comment': 'Watchdog only'}})
            self.assertEqual(agent.configured_composer_auto_send_timeout(), value)
        for value in [True, 0, -1, 3601, 1.5, '20', None]:
            self.write({'composerAutoSendTimeoutSeconds': {'value': value}})
            with self.assertRaises(agent.AgentApiError) as raised:
                agent.configured_composer_auto_send_timeout()
            self.assertEqual(raised.exception.code, 'CONFIG_INVALID')

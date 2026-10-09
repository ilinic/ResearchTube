"""The EXE uses its installation, embedded helper and external editable data."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from agent import researchtube_agent as agent
from agent.runtime_paths import installation_root
from scripts.build_release import package_release


class FrozenRuntimeTests(unittest.TestCase):
    def test_installation_root_uses_executable_only_when_frozen(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source/researchtube_agent.py'
            exe = root / 'installed/ResearchTubeAgent.exe'
            with patch.object(sys, 'executable', str(exe)), patch.object(sys, 'frozen', False, create=True):
                self.assertEqual(installation_root(str(source)), source.parent)
            with patch.object(sys, 'executable', str(exe)), patch.object(sys, 'frozen', True, create=True):
                self.assertEqual(installation_root(str(root / 'temporary/bundle.py')), exe.parent)

    def test_speech_self_exec_dispatch_never_starts_server_or_prompts(self):
        from agent import windows_speech
        with patch.object(sys, 'argv', ['ResearchTubeAgent.exe', '--windows-speech-helper', '--action', 'list-voices']), \
             patch.object(windows_speech, 'main', return_value=0) as speech, \
             patch.object(agent, 'serve') as serve, patch('builtins.input') as prompt:
            self.assertEqual(agent.main(), 0)
            speech.assert_called_once_with(['--action', 'list-voices'])
            serve.assert_not_called()
            prompt.assert_not_called()

    def test_source_and_frozen_speech_prefixes_and_independent_child(self):
        with patch.object(sys, 'frozen', False, create=True):
            self.assertEqual(agent.windows_speech_command('python.exe'), ['python.exe', str(agent.WINDOWS_SPEECH_SCRIPT_PATH)])
            self.assertIsNone(agent.windows_speech_environment())
        with patch.object(sys, 'frozen', True, create=True):
            self.assertEqual(agent.windows_speech_command('Agent.exe'), ['Agent.exe', '--windows-speech-helper'])
            self.assertEqual(agent.windows_speech_environment()['PYINSTALLER_RESET_ENVIRONMENT'], '1')

    def test_zip_has_both_launches_and_no_user_workspace_or_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, data in {'README.md': 'guide', 'agent/researchtube_agent.py': '# code',
                               'agent/runtime_paths.py': '# paths', 'agent/windows_speech.py': '# speech',
                               'agent/agent-config.json': json.dumps({'workspacePath': {'value': 'PRIVATE', 'comment': 'keep'}}),
                               'agent/workspace/demo/demo.mp4': 'demo', 'agent/workspace/secret.txt': 'private',
                               'agent/__pycache__/cache.pyc': 'cache', 'agent/agent/old.py': 'legacy',
                               'agent/tools/timezones/zoneinfo.zip': 'tz',
                               'agent/tools/yt-dlp/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip': 'plugin',
                               'agent/tools/windows-speech/researchtube_speech.py': '# wrapper',
                               'agent/custom-tools/example/manifest.json': '{}',
                               'extension/dist/background.js': '// bundle',
                               'extension/node_modules/unused.js': 'cache'}.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(data, encoding='utf-8')
            executable = root / 'built.exe'
            executable.write_bytes(b'MZfixture')
            output = package_release(root, executable, root / 'out/release.zip')
            with zipfile.ZipFile(output) as archive:
                names = archive.namelist()
                self.assertIn('ResearchTube/agent/ResearchTubeAgent.exe', names)
                self.assertIn('ResearchTube/agent/researchtube_agent.py', names)
                self.assertIn('ResearchTube/agent/tools/timezones/zoneinfo.zip', names)
                self.assertIn('ResearchTube/agent/tools/yt-dlp/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip', names)
                self.assertFalse(any('secret' in name or '__pycache__' in name or 'node_modules' in name or '/agent/agent/' in name for name in names))
                self.assertEqual(json.loads(archive.read('ResearchTube/agent/agent-config.json'))['workspacePath']['value'], '')
                self.assertIsNone(archive.testzip())
            self.assertEqual(json.loads((root / 'agent/agent-config.json').read_text())['workspacePath']['value'], 'PRIVATE')
            with self.assertRaises(FileExistsError):
                package_release(root, executable, output)


if __name__ == '__main__':
    unittest.main()

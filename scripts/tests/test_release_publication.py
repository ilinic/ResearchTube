"""Release identity, exact-build selection and resumable publication."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from scripts.publish_release import find_release, publish
from scripts.release_metadata import release_metadata


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / 'extension').mkdir()
        (self.root / 'agent').mkdir()
        (self.root / 'extension/manifest.json').write_text('{"version":"2.2.101"}')
        (self.root / 'agent/researchtube_agent.py').write_text('AGENT_VERSION = "2.2.71"\n')
        self.config = self.root / 'release.json'
        self.config.write_text('{"prerelease":true}')
        self.commit = 'a' * 40
        self.archive = self.root / 'ResearchTube.zip'
        self.write_archive()
        self.calls = []

    def write_archive(self, metadata=None):
        with zipfile.ZipFile(self.archive, 'w') as archive:
            archive.writestr('ResearchTube/release-info.json', json.dumps(metadata or release_metadata(self.root, self.commit)))

    def draft(self):
        return {'draft': True, 'target_commitish': self.commit, 'assets': []}

    def record(self, *args):
        self.calls.append(args)
        if args[:2] == ('release', 'create'):
            notes = Path(args[args.index('--notes-file') + 1]).read_text()
            self.assertIn('Extension: 2.2.101', notes)
            self.assertIn('Agent: 2.2.71', notes)

    def test_pre_and_stable_use_component_pair_and_latest_policy(self):
        for prerelease in (True, False):
            with self.subTest(prerelease=prerelease):
                self.config.write_text(json.dumps({'prerelease': prerelease}))
                self.write_archive()
                self.calls.clear()
                with patch('scripts.publish_release.find_release', side_effect=[None, self.draft()]), \
                     patch('scripts.publish_release.gh', side_effect=self.record):
                    url = publish(self.archive, 'owner/repo', self.commit, self.root)
                self.assertTrue(url.endswith('/ext-2.2.101_agent-2.2.71'))
                self.assertEqual([call[1] for call in self.calls], ['create', 'upload', 'upload', 'edit'])
                create, edit = self.calls[0], self.calls[-1]
                self.assertIn('--draft', create)
                if prerelease:
                    self.assertIn('--prerelease', create)
                else:
                    self.assertNotIn('--prerelease', create)
                self.assertIn('--latest=false' if prerelease else '--latest=true', edit)
                self.assertIn('--prerelease=' + str(prerelease).lower(), edit)
                self.assertNotIn('--clobber', ' '.join(' '.join(call) for call in self.calls))

    def test_published_pair_is_kept_without_replacing_assets(self):
        existing = {'draft': False, 'html_url': 'https://github.com/owner/repo/releases/tag/old'}
        with patch('scripts.publish_release.find_release', return_value=existing), \
             patch('scripts.publish_release.gh') as gh:
            self.assertEqual(publish(self.archive, 'owner/repo', self.commit, self.root), existing['html_url'])
            gh.assert_not_called()

    def test_archive_from_another_commit_is_rejected_before_remote_calls(self):
        self.write_archive(release_metadata(self.root, 'b' * 40))
        with patch('scripts.publish_release.find_release') as find:
            with self.assertRaisesRegex(ValueError, 'ZIP release metadata'):
                publish(self.archive, 'owner/repo', self.commit, self.root)
            find.assert_not_called()

    def test_upload_failure_does_not_publish_incomplete_draft(self):
        def fail(*args):
            self.record(*args)
            if args[1] == 'upload':
                raise RuntimeError('upload failed')
        with patch('scripts.publish_release.find_release', side_effect=[None, self.draft()]), \
             patch('scripts.publish_release.gh', side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, 'upload failed'):
                publish(self.archive, 'owner/repo', self.commit, self.root)
        self.assertFalse(any(call[1] == 'edit' for call in self.calls))

    def test_retry_uploads_missing_asset_only_and_publishes(self):
        draft = self.draft()
        draft['assets'] = [{'name': self.archive.name, 'digest': 'sha256:' + hashlib.sha256(self.archive.read_bytes()).hexdigest()}]
        with patch('scripts.publish_release.find_release', return_value=draft), \
             patch('scripts.publish_release.gh', side_effect=self.record):
            publish(self.archive, 'owner/repo', self.commit, self.root)
        self.assertEqual([call[1] for call in self.calls], ['upload', 'edit'])
        self.assertTrue(self.calls[0][3].endswith('ResearchTube.zip.sha256'))

    def test_existing_draft_assets_are_never_silently_replaced(self):
        draft = self.draft()
        draft['assets'] = [{'name': self.archive.name, 'digest': 'sha256:OTHER'}]
        with patch('scripts.publish_release.find_release', return_value=draft), \
             patch('scripts.publish_release.gh') as gh:
            with self.assertRaisesRegex(ValueError, 'draft asset differs'):
                publish(self.archive, 'owner/repo', self.commit, self.root)
            gh.assert_not_called()

    def test_only_404_is_treated_as_missing_release(self):
        with patch('scripts.publish_release.subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', 'HTTP 404')):
            self.assertIsNone(find_release('owner/repo', 'tag'))
        with patch('scripts.publish_release.subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', 'HTTP 403')):
            with self.assertRaisesRegex(RuntimeError, '403'):
                find_release('owner/repo', 'tag')

"""Release identity, platform archive validation and resumable publication."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from scripts.publish_release import PLATFORMS, find_release, publish
from scripts.release_metadata import release_metadata


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / 'extension').mkdir()
        (self.root / 'agent').mkdir()
        (self.root / 'extension/manifest.json').write_text('{"version":"2.2.101"}')
        (self.root / 'agent/researchtube_agent.py').write_text('AGENT_VERSION = "2.2.72"\n')
        (self.root / 'release.json').write_text('{"prerelease":true}')
        self.commit = 'a' * 40
        self.archives = [self.make_archive(platform, filename) for platform, filename in PLATFORMS.items()]
        self.calls = []

    def make_archive(self, platform, filename, commit=None):
        archive_path = self.root / filename
        info = release_metadata(self.root, commit or self.commit)
        info['platform'] = platform
        with zipfile.ZipFile(archive_path, 'w') as archive:
            archive.writestr('ResearchTube/release-info.json', json.dumps(info))
        return archive_path

    def draft(self, assets=None):
        return {'draft': True, 'target_commitish': self.commit, 'assets': assets or []}

    def record(self, *args):
        self.calls.append(args)
        if args[:2] == ('release', 'create'):
            notes = Path(args[args.index('--notes-file') + 1]).read_text()
            self.assertIn('Extension: 2.2.101', notes)
            self.assertIn('Agent: 2.2.72', notes)
            for filename in PLATFORMS.values():
                self.assertIn(filename, notes)

    def test_pre_and_stable_upload_all_archives_and_checksums(self):
        for prerelease in (True, False):
            with self.subTest(prerelease=prerelease):
                (self.root / 'release.json').write_text(json.dumps({'prerelease': prerelease}))
                for index, (platform, filename) in enumerate(PLATFORMS.items()):
                    self.archives[index] = self.make_archive(platform, filename)
                self.calls.clear()
                with patch('scripts.publish_release.find_release', return_value=None) as find, \
                     patch('scripts.publish_release.gh', side_effect=self.record):
                    url = publish(self.archives, 'owner/repo', self.commit, self.root)
                find.assert_called_once_with('owner/repo', 'ext-2.2.101_agent-2.2.72')
                self.assertTrue(url.endswith('/ext-2.2.101_agent-2.2.72'))
                self.assertEqual([call[1] for call in self.calls], ['create', *(['upload'] * 8), 'edit'])
                create, edit = self.calls[0], self.calls[-1]
                self.assertIn('--draft', create)
                self.assertEqual('--prerelease' in create, prerelease)
                self.assertIn('--latest=false' if prerelease else '--latest=true', edit)
                self.assertIn('--prerelease=' + str(prerelease).lower(), edit)
                self.assertNotIn('--clobber', ' '.join(' '.join(call) for call in self.calls))

    def test_published_pair_is_kept_without_replacing_assets(self):
        existing = {'draft': False, 'html_url': 'https://github.com/owner/repo/releases/tag/old'}
        with patch('scripts.publish_release.find_release', return_value=existing), \
             patch('scripts.publish_release.gh') as gh:
            self.assertEqual(publish(self.archives, 'owner/repo', self.commit, self.root), existing['html_url'])
            gh.assert_not_called()

    def test_wrong_commit_or_platform_is_rejected_before_remote_calls(self):
        wrong = self.make_archive('windows-x64', PLATFORMS['windows-x64'], 'b' * 40)
        archives = [wrong, *self.archives[1:]]
        with patch('scripts.publish_release.find_release') as find:
            with self.assertRaisesRegex(ValueError, 'metadata'):
                publish(archives, 'owner/repo', self.commit, self.root)
            find.assert_not_called()

    def test_incomplete_platform_set_is_rejected(self):
        with patch('scripts.publish_release.find_release') as find:
            with self.assertRaisesRegex(ValueError, 'exactly one archive'):
                publish(self.archives[:-1], 'owner/repo', self.commit, self.root)
            find.assert_not_called()

    def test_upload_failure_does_not_publish_incomplete_draft(self):
        def fail(*args):
            self.record(*args)
            if args[1] == 'upload':
                raise RuntimeError('upload failed')
        with patch('scripts.publish_release.find_release', return_value=None), \
             patch('scripts.publish_release.gh', side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, 'upload failed'):
                publish(self.archives, 'owner/repo', self.commit, self.root)
        self.assertFalse(any(call[1] == 'edit' for call in self.calls))

    def test_retry_uploads_only_missing_identical_assets(self):
        asset_files = list(self.archives)
        with tempfile.TemporaryDirectory() as directory:
            checksums = []
            for archive in asset_files:
                path = Path(directory) / (archive.name + '.sha256')
                path.write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + archive.name + '\n')
                checksums.append(path)
            assets = [{'name': path.name, 'digest': 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()}
                      for path in (*asset_files, *checksums)]
            assets.pop(3)
            with patch('scripts.publish_release.find_release', return_value=self.draft(assets)), \
                 patch('scripts.publish_release.gh', side_effect=self.record):
                publish(self.archives, 'owner/repo', self.commit, self.root)
            self.assertEqual([call[1] for call in self.calls], ['upload', 'edit'])
            self.assertTrue(self.calls[0][3].endswith(PLATFORMS['macos-x64']))

    def test_existing_draft_assets_are_never_silently_replaced(self):
        draft = self.draft([{'name': self.archives[0].name, 'digest': 'sha256:OTHER'}])
        with patch('scripts.publish_release.find_release', return_value=draft), \
             patch('scripts.publish_release.gh') as gh:
            with self.assertRaisesRegex(ValueError, 'draft asset differs'):
                publish(self.archives, 'owner/repo', self.commit, self.root)
            gh.assert_not_called()

    def test_only_404_is_treated_as_missing_release(self):
        with patch('scripts.publish_release.subprocess.run', side_effect=[
            subprocess.CompletedProcess([], 1, '', 'HTTP 404'),
            subprocess.CompletedProcess([], 0, '[[]]', '')]):
            self.assertIsNone(find_release('owner/repo', 'tag'))
        with patch('scripts.publish_release.subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', 'HTTP 403')):
            with self.assertRaisesRegex(RuntimeError, '403'):
                find_release('owner/repo', 'tag')

    def test_draft_lookup_uses_paginated_release_collection(self):
        draft = {**self.draft(), 'tag_name': 'tag'}
        with patch('scripts.publish_release.subprocess.run', side_effect=[
            subprocess.CompletedProcess([], 1, '', 'HTTP 404'),
            subprocess.CompletedProcess([], 0, json.dumps([[], [draft]]), '')]) as run:
            self.assertEqual(find_release('owner/repo', 'tag'), draft)
        self.assertIn('--paginate', run.call_args.args[0])

    def test_empty_old_draft_is_retargeted_to_corrected_build(self):
        draft = {**self.draft(), 'target_commitish': 'b' * 40}
        with patch('scripts.publish_release.find_release', return_value=draft), \
             patch('scripts.publish_release.gh', side_effect=self.record):
            publish(self.archives, 'owner/repo', self.commit, self.root)
        self.assertEqual([call[1] for call in self.calls], ['edit', *(['upload'] * 8), 'edit'])
        self.assertEqual(self.calls[0][self.calls[0].index('--target') + 1], self.commit)

    def test_old_draft_with_assets_is_not_retargeted(self):
        draft = {**self.draft([{'name': self.archives[0].name}]), 'target_commitish': 'b' * 40}
        with patch('scripts.publish_release.find_release', return_value=draft), \
             patch('scripts.publish_release.gh') as gh:
            with self.assertRaisesRegex(ValueError, 'another commit'):
                publish(self.archives, 'owner/repo', self.commit, self.root)
            gh.assert_not_called()


if __name__ == '__main__':
    unittest.main()

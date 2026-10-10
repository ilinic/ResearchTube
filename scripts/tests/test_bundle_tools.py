"""Safe extraction is necessary for downloading and redistributing binary bundles."""
from pathlib import Path
import hashlib
import io
import json
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from scripts.bundle_tools import LOCK, download, extract_archive


class BundleDownloadTests(unittest.TestCase):
    def test_release_lock_uses_versioned_urls_and_checksums(self):
        locks = json.loads(LOCK.read_text(encoding='utf-8'))
        for platform, tools in locks.items():
            for name, entry in tools.items():
                with self.subTest(platform=platform, tool=name):
                    self.assertNotIn('/latest/', entry['url'])
                    self.assertNotIn('-latest-', entry['url'])
                    self.assertRegex(entry['sha256'], r'^[0-9a-f]{64}$')

    def test_download_verifies_bytes_and_removes_mismatched_archive(self):
        data = b'upstream release archive'
        expected = hashlib.sha256(data).hexdigest()
        entry = {'url': 'https://example.com/releases/download/v1/tool.zip', 'sha256': expected}
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / 'tool.zip'
            with patch('scripts.bundle_tools.urlopen', return_value=io.BytesIO(data)):
                download(entry, destination)
            self.assertEqual(destination.read_bytes(), data)
            changed = b'replaced archive'
            actual = hashlib.sha256(changed).hexdigest()
            with patch('scripts.bundle_tools.urlopen', return_value=io.BytesIO(changed)):
                with self.assertRaisesRegex(ValueError, f'expected {expected}, got {actual}'):
                    download(entry, destination)
            self.assertFalse(destination.exists())


class BundleExtractionTests(unittest.TestCase):
    def test_zip_path_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / 'unsafe.zip'
            with zipfile.ZipFile(archive, 'w') as output:
                output.writestr('../escaped.txt', 'outside')
            with self.assertRaisesRegex(ValueError, 'Unsafe ZIP entry'):
                extract_archive(archive, root / 'tools', 'zip')
            self.assertFalse((root / 'escaped.txt').exists())

    def test_relative_tar_symlinks_become_self_contained_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / 'bundle.tar.gz'
            with tarfile.open(archive, 'w:gz') as output:
                data = b'ffmpeg library fixture'
                regular = tarfile.TarInfo('package/lib/libcodec.1.dylib')
                regular.size = len(data)
                regular.mode = 0o644
                import io
                output.addfile(regular, io.BytesIO(data))
                alias = tarfile.TarInfo('package/lib/libcodec.dylib')
                alias.type = tarfile.SYMTYPE
                alias.linkname = 'libcodec.1.dylib'
                output.addfile(alias)
            destination = root / 'tools/ffmpeg'
            extract_archive(archive, destination, 'tar.gz')
            link = destination / 'package/lib/libcodec.dylib'
            self.assertFalse(link.is_symlink())
            self.assertEqual(link.read_bytes(), data)


if __name__ == '__main__':
    unittest.main()

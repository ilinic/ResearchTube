"""Safe extraction is necessary for downloading and redistributing binary bundles."""
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

from scripts.bundle_tools import extract_archive


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

import hashlib
import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from sync_windows_screenshots import copy_new_images, snapshot_digests


class ScreenshotSyncTests(unittest.TestCase):
    def test_snapshot_digests_prevents_a_new_person_from_importing_old_screenshots(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "source"
            target = root / "target"
            source.mkdir()
            (source / "old.png").write_bytes(b"old")

            known = snapshot_digests(source)
            (source / "new.png").write_bytes(b"new")

            with contextlib.redirect_stdout(io.StringIO()):
                copied = copy_new_images(source, target, known)

            self.assertEqual(copied, 1)
            self.assertEqual((target / "page-001.png").read_bytes(), b"new")
            self.assertEqual(
                known,
                {
                    hashlib.sha256(b"old").hexdigest(),
                    hashlib.sha256(b"new").hexdigest(),
                },
            )


if __name__ == "__main__":
    unittest.main()

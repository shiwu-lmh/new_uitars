from pathlib import Path
import unittest


class UiTarsLauncherTests(unittest.TestCase):
    def test_launcher_has_a_single_instance_guard(self):
        script = (Path(__file__).parent / "UI-TARS-desktop-0.3.0" / "启动UI-TARS.ps1").read_text(
            encoding="utf-8"
        )

        self.assertIn("UI_TARS_DESKTOP_SINGLE_INSTANCE", script)
        self.assertIn("WaitOne(0", script)
        self.assertIn("ReleaseMutex", script)


if __name__ == "__main__":
    unittest.main()

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class TaskQueueCliTests(unittest.TestCase):
    def test_cli_claims_writes_prompt_and_marks_one_task(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            csv_path = root / "名单.csv"
            db_path = root / "queue.sqlite3"
            output_root = root / "medical_records"
            prompt_path = root / "current_task.md"
            task_id_path = root / "current_task.id"
            csv_path.write_text(
                "task_id,name,patient_id\n001,测试人员,TEST-001\n",
                encoding="utf-8-sig",
            )

            self._run("init", "--csv", str(csv_path), "--db", str(db_path))
            self._run(
                "next",
                "--db",
                str(db_path),
                "--output-root",
                str(output_root),
                "--prompt-file",
                str(prompt_path),
                "--task-id-file",
                str(task_id_path),
            )

            self.assertEqual(task_id_path.read_text(encoding="ascii").strip(), "001")
            self.assertIn("TEST-001", prompt_path.read_text(encoding="utf-8"))
            self.assertTrue((output_root / "001" / "task.json").exists())

            self._run(
                "mark",
                "--db",
                str(db_path),
                "--task-id",
                "001",
                "--status",
                "done",
            )
            listing = self._run("list", "--db", str(db_path))
            self.assertIn("001\tdone", listing.stdout)

    def _run(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "task_queue.py", *args],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )


if __name__ == "__main__":
    unittest.main()

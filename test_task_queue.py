import csv
import tempfile
import unittest
from pathlib import Path

from task_queue import (
    QueueStore,
    TaskValidationError,
    build_task_prompt,
    initialize_from_csv,
    task_output_dir,
)


class TaskQueueTests(unittest.TestCase):
    def test_imports_people_and_keeps_existing_status_on_resume(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            csv_path = root / "名单.csv"
            csv_path.write_text(
                "task_id,name,patient_id,birth_date\n"
                "001,张三,P001,1990-01-01\n"
                "002,李四,P002,1988-06-15\n",
                encoding="utf-8-sig",
            )
            db_path = root / "queue.sqlite3"

            initialize_from_csv(csv_path, db_path)
            queue = QueueStore(db_path)
            claimed = queue.claim_next()
            self.assertEqual(claimed.task_id, "001")
            queue.mark(claimed.task_id, "done")

            initialize_from_csv(csv_path, db_path)

            self.assertEqual(queue.get("001").status, "done")
            self.assertEqual(queue.get("002").status, "pending")

    def test_claim_next_is_serial_and_does_not_claim_running_task(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            csv_path = root / "名单.csv"
            csv_path.write_text(
                "task_id,name,patient_id\n001,张三,P001\n002,李四,P002\n",
                encoding="utf-8-sig",
            )
            db_path = root / "queue.sqlite3"
            initialize_from_csv(csv_path, db_path)
            queue = QueueStore(db_path)

            first = queue.claim_next()
            self.assertEqual(first.task_id, "001")
            self.assertEqual(queue.claim_next(), None)

    def test_rejects_duplicate_or_unsafe_task_ids_before_writing_queue(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            csv_path = root / "名单.csv"
            csv_path.write_text(
                "task_id,name,patient_id\n../escape,张三,P001\n../escape,李四,P002\n",
                encoding="utf-8-sig",
            )

            with self.assertRaises(TaskValidationError):
                initialize_from_csv(csv_path, root / "queue.sqlite3")

            self.assertFalse((root / "queue.sqlite3").exists())

    def test_output_directory_is_contained_and_does_not_use_person_name(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            output = task_output_dir(root, "001")
            self.assertEqual(output, root.resolve() / "001")
            self.assertNotIn("张三", str(output))

            with self.assertRaises(TaskValidationError):
                task_output_dir(root, "../escape")

    def test_prompt_contains_manual_confirmation_and_scoped_output(self):
        prompt = build_task_prompt(
            task_id="001",
            name="张三",
            patient_id="P001",
            output_dir=Path(r"D:\medical_records\001"),
        )

        self.assertIn("P001", prompt)
        self.assertIn(r"D:\medical_records\001", prompt)
        self.assertIn("同名", prompt)
        self.assertIn("验证码", prompt)
        self.assertIn("不要修改或提交病历", prompt)


if __name__ == "__main__":
    unittest.main()

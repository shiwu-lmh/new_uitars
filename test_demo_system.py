import json
import unittest
from pathlib import Path

ROOT = Path(__file__).parent
DEMO_ROOT = ROOT / "demo_medical_system"


class DemoMedicalSystemTests(unittest.TestCase):
    def test_demo_dataset_has_multiple_people_and_multiple_records(self):
        data = json.loads((DEMO_ROOT / "data.json").read_text(encoding="utf-8"))
        self.assertEqual(len(data), 6)
        self.assertEqual([person["patient_id"] for person in data], [f"DEMO-{index:03d}" for index in range(1, 7)])
        self.assertGreaterEqual(len(data[0]["records"]), 3)
        self.assertEqual(len(data[1]["records"]), 1)
        self.assertEqual(data[3]["name"], data[4]["name"])
        self.assertNotEqual(data[3]["birth_date"], data[4]["birth_date"])
        self.assertTrue(all(person["patient_id"].startswith("DEMO-") for person in data))
        self.assertTrue(all(person["department"] and person["status"] and person["risk"] for person in data))

    def test_demo_assets_and_instructions_are_present(self):
        self.assertTrue((DEMO_ROOT / "index.html").exists())
        self.assertTrue((ROOT / "start_demo_system.ps1").exists())
        app = (DEMO_ROOT / "app.js").read_text(encoding="utf-8")
        self.assertIn("核对患者身份并截取全部病历内容", app)
        self.assertIn("返回列表", app)
        self.assertNotIn("确认完成本次审核", app)
        self.assertNotIn("导出审核摘要", app)
        prompt = (ROOT / "demo_test_prompt.md").read_text(encoding="utf-8")
        for phrase in ("127.0.0.1:8765", "DEMO-001", "demo", "翻页", "同名消歧", "截图", "返回列表", "弹窗", "误触"):
            self.assertIn(phrase, prompt)


if __name__ == "__main__":
    unittest.main()

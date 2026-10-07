"""PyCharm 一键运行入口：日常病历自动化 + UI-TARS 兜底 + PaddleOCR。"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
WORKFLOW = PROJECT_ROOT / "run_medical_ocr_full.py"


def main() -> int:
    env = os.environ.copy()

    # 日常测试名单；更换名单时只修改这个 CSV，不需要修改自动化代码。
    env["MEDICAL_ROSTER"] = str(PROJECT_ROOT / "demo_名单.csv")

    # 开启 UI-TARS 视觉兜底和浏览器自动重启。
    env["UI_TARS_AI_RECOVERY"] = "1"
    env["MEDICAL_MAX_BROWSER_RESTARTS"] = "3"
    # PyCharm 演示时等待后台 OCR 完成，确保运行窗口能看到最终结果。
    env["MEDICAL_WAIT_FOR_OCR"] = "1"

    # 清除故障演示变量，保证这是正常日常测试。
    env.pop("MEDICAL_DEMO_FAULT", None)
    env.pop("MEDICAL_DEMO_CLOSE_STAGE", None)
    env.pop("MEDICAL_APP_URL", None)

    print("开始运行 PyCharm 日常自动化测试…", flush=True)
    print(f"项目目录：{PROJECT_ROOT}", flush=True)
    print(f"患者名单：{env['MEDICAL_ROSTER']}", flush=True)

    result = subprocess.run(
        [sys.executable, str(WORKFLOW)],
        cwd=PROJECT_ROOT,
        env=env,
        check=False,
    )

    print(f"测试结束，退出码：{result.returncode}", flush=True)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())

"""Run a real UI-TARS cross-application test with PaddleOCR in the background."""

from __future__ import annotations

import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parent
URL = "http://127.0.0.1:8765/"
CHROME = Path(r"C:\Users\musi\AppData\Local\Google\Chrome\Application\chrome.exe")
RUN_DIR = ROOT / "screenshots" / f"cross-app-ai-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
PROMPT = ROOT / "cross_app_test_prompt.md"
CHECKLIST = ROOT / "cross_app_review_checklist.txt"
SETTINGS = ROOT / "model_settings.local.json"


def server_ready() -> bool:
    try:
        with urlopen(URL, timeout=2) as response:
            return response.status == 200
    except (OSError, URLError):
        return False


def main() -> int:
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    stop_file = RUN_DIR / ".ocr-stop"
    done_file = RUN_DIR / ".ocr-done"
    ocr_log = RUN_DIR / "ocr-background.log"
    agent_status = RUN_DIR / "agent-status.json"
    demo_server = None
    ocr_worker = None
    ocr_log_handle = None
    helper_apps = []

    try:
        if not server_ready():
            print("启动本地演示病历系统…", flush=True)
            demo_server = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "http.server",
                    "8765",
                    "--bind",
                    "127.0.0.1",
                    "--directory",
                    str(ROOT / "demo_medical_system"),
                ],
                cwd=ROOT,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            for _ in range(20):
                if server_ready():
                    break
                time.sleep(0.5)
            else:
                raise RuntimeError("演示系统启动超时")

        ocr_log_handle = ocr_log.open("w", encoding="utf-8")
        ocr_worker = subprocess.Popen(
            [
                sys.executable,
                "-u",
                str(ROOT / "watch_ocr.py"),
                str(RUN_DIR),
                "--output",
                str(RUN_DIR / "ocr-result.md"),
                "--stop-file",
                str(stop_file),
                "--done-file",
                str(done_file),
                "--workers",
                "3",
            ],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=ocr_log_handle,
            stderr=subprocess.STDOUT,
            creationflags=(subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)
            if os.name == "nt"
            else 0,
        )
        time.sleep(1)
        if ocr_worker.poll() is not None:
            raise RuntimeError(f"OCR worker 启动失败，查看 {ocr_log}")

        if not CHROME.exists():
            raise FileNotFoundError(f"找不到 Chrome：{CHROME}")

        # Launch the read-only helper first, then Chrome so Chrome is foreground when
        # UI-TARS begins. The helper is a normal local app, not a browser upload target.
        helper_apps.append(
            subprocess.Popen(
                ["notepad.exe", str(CHECKLIST)],
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
            )
        )
        time.sleep(1)
        helper_apps.append(
            subprocess.Popen(
                [str(CHROME), "--new-window", URL],
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
            )
        )
        time.sleep(4)

        print("跨应用 UI-TARS agent 启动：Chrome + Notepad…", flush=True)
        agent_code = subprocess.run(
            [
                "node",
                "ui_tars_agent_runner.mjs",
                "--settings",
                str(SETTINGS),
                "--prompt-file",
                str(PROMPT),
                "--status-file",
                str(agent_status),
                "--screenshot-dir",
                str(RUN_DIR),
                "--max-loop-count",
                "40",
            ],
            cwd=ROOT,
        ).returncode
        if agent_code:
            raise RuntimeError(f"UI-TARS agent 退出码：{agent_code}")
        print("跨应用 AI 操作完成；OCR 继续后台处理截图。", flush=True)
        return 0
    finally:
        if ocr_worker is not None and ocr_worker.poll() is None:
            stop_file.touch()
            try:
                ocr_worker.wait(timeout=900)
            except subprocess.TimeoutExpired:
                ocr_worker.terminate()
                ocr_worker.wait(timeout=10)
        if ocr_log_handle is not None:
            ocr_log_handle.close()
        if demo_server is not None and demo_server.poll() is None:
            demo_server.terminate()
            demo_server.wait(timeout=5)
        print(f"AI 状态：{agent_status}", flush=True)
        print(f"截图目录：{RUN_DIR}", flush=True)
        print(f"OCR 结果：{RUN_DIR / 'ocr-result.md'}", flush=True)
        print(f"OCR 完成标记：{done_file}", flush=True)


if __name__ == "__main__":
    raise SystemExit(main())

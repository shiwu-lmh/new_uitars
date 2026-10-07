"""Run the demo browser workflow and real PaddleOCR end to end."""

from __future__ import annotations

import subprocess
import sys
import time
import os
from datetime import datetime
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parent
APP = ROOT / "UI-TARS-desktop-0.3.0"
URL = "http://127.0.0.1:8765/"
RUN_ID = datetime.now().strftime("%Y%m%d-%H%M%S")
SCREENSHOTS = Path(
    os.environ.get("MEDICAL_OCR_OUTPUT_DIR", "")
    or ROOT / "screenshots" / f"automated-medical-{RUN_ID}"
)


def demo_is_running() -> bool:
    try:
        with urlopen(URL, timeout=2) as response:
            return response.status == 200
    except (OSError, URLError):
        return False


def main() -> int:
    server: subprocess.Popen[bytes] | None = None
    ocr_worker: subprocess.Popen[bytes] | None = None
    stop_file = SCREENSHOTS / ".ocr-stop"
    done_file = SCREENSHOTS / ".ocr-done"
    ocr_log = SCREENSHOTS / "ocr-background.log"
    wait_for_ocr = os.environ.get("MEDICAL_WAIT_FOR_OCR") == "1"
    ocr_log_handle = None
    exit_code = 0
    try:
        SCREENSHOTS.mkdir(parents=True, exist_ok=True)
        if not demo_is_running():
            print("[1/3] 启动本地演示病历系统…", flush=True)
            server = subprocess.Popen(
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
            for _ in range(30):
                if demo_is_running():
                    break
                if server.poll() is not None:
                    raise RuntimeError("演示系统启动失败：请确认 8765 端口可用。")
                time.sleep(0.5)
            else:
                raise RuntimeError("等待演示系统启动超时。")
        else:
            print("[1/3] 检测到演示系统已运行，继续使用。", flush=True)

        ocr_log_handle = ocr_log.open("w", encoding="utf-8")
        ocr_worker = subprocess.Popen(
            [
                sys.executable,
                "-u",
                str(ROOT / "watch_ocr.py"),
                str(SCREENSHOTS),
                "--per-patient",
                "--stop-file",
                str(stop_file),
                "--done-file",
                str(done_file),
            ],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=ocr_log_handle,
            stderr=subprocess.STDOUT,
            creationflags=(
                subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                if sys.platform == "win32"
                else 0
            ),
        )
        time.sleep(1)
        if ocr_worker.poll() is not None:
            raise RuntimeError(f"后台 OCR 启动失败；请检查日志：{ocr_log}")
        print(
            f"[2/3] 独立后台 PaddleOCR 已启动；每位患者的实时结果：<患者编号>\\ocr-result.md；"
            f"流程根目录：{SCREENSHOTS / 'workflow-result.json'}",
            flush=True,
        )

        print("[3/3] 浏览器持续检索、展开病历和截图（OCR 同时在后台处理）…", flush=True)
        browser_env = os.environ.copy()
        browser_env["MEDICAL_OCR_OUTPUT_DIR"] = str(SCREENSHOTS)
        browser_result = subprocess.run(
            ["node", "automated_medical_ocr_e2e.mjs"], cwd=APP, env=browser_env
        )
        if browser_result.returncode:
            raise subprocess.CalledProcessError(browser_result.returncode, browser_result.args)
    except (OSError, subprocess.CalledProcessError, RuntimeError) as error:
        print(f"全流程失败：{error}", file=sys.stderr)
        exit_code = 1
    finally:
        if ocr_worker is not None and ocr_worker.poll() is None:
            stop_file.touch()
            if wait_for_ocr:
                print("浏览器自动化已结束；等待后台 OCR 完成…", flush=True)
                for _ in range(180):
                    if done_file.exists():
                        print("后台 OCR 已完成。", flush=True)
                        break
                    time.sleep(2)
                else:
                    print(f"等待 OCR 超时，请检查后台日志：{ocr_log}", flush=True)
            else:
                print("浏览器自动化已结束；后台 OCR 将独立处理剩余截图，不受此终端关闭影响。", flush=True)
        if ocr_log_handle is not None:
            ocr_log_handle.close()
        if server is not None and server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()

    if exit_code == 0:
        print(
            f"浏览器自动化部分完成。\n"
            f"流程报告：{SCREENSHOTS / 'workflow-result.json'}\n"
            f"后台 OCR 结果模式：{SCREENSHOTS}\\<患者编号>\\ocr-result.md\n"
            f"OCR 完成标记：{done_file}\n后台日志：{ocr_log}"
        )
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())

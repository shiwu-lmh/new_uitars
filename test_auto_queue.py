from __future__ import annotations

import json
from pathlib import Path

from auto_queue import (
    _ocr_page_count,
    _wait_for_ocr,
    build_agent_command,
    build_demo_prompt,
    is_successful_agent_run,
    read_agent_status,
)
from task_queue import Task


def test_build_agent_command_uses_task_prompt_and_status_file() -> None:
    command = build_agent_command(
        node="node.exe",
        runner=Path("ui_tars_agent_runner.mjs"),
        settings=Path("settings.json"),
        prompt=Path("task.md"),
        status=Path("status.json"),
    )

    assert command == [
        "node.exe",
        "ui_tars_agent_runner.mjs",
        "--settings",
        "settings.json",
        "--prompt-file",
        "task.md",
        "--status-file",
        "status.json",
    ]


def test_agent_run_is_successful_only_when_end_and_ocr_exist(tmp_path: Path) -> None:
    status_path = tmp_path / "status.json"
    status_path.write_text(json.dumps({"status": "END"}), encoding="utf-8")
    ocr_path = tmp_path / "OCR.md"
    ocr_path.write_text("# OCR\n\nrecognized text\n", encoding="utf-8")

    status = read_agent_status(status_path)

    assert is_successful_agent_run(status, ocr_path) is True


def test_agent_run_is_not_successful_for_call_user_or_missing_ocr(tmp_path: Path) -> None:
    status_path = tmp_path / "status.json"
    status_path.write_text(json.dumps({"status": "CALL_USER"}), encoding="utf-8")

    assert read_agent_status(status_path) == {"status": "CALL_USER"}
    assert is_successful_agent_run({"status": "CALL_USER"}, tmp_path / "OCR.md") is False
    assert is_successful_agent_run({"status": "END"}, tmp_path / "OCR.md") is False


def test_wait_for_ocr_requires_all_screenshots(tmp_path: Path) -> None:
    image_folder = tmp_path / "task"
    image_folder.mkdir()
    (image_folder / "page-001.png").write_bytes(b"image")
    (image_folder / "page-002.png").write_bytes(b"image")
    ocr_path = image_folder / "OCR.md"
    ocr_path.write_text("# OCR\n\n图片数：1\n\nfirst page\n", encoding="utf-8")

    assert _ocr_page_count(ocr_path) == 1
    assert _wait_for_ocr(ocr_path, 0, image_folder, settle_seconds=0) is False

    ocr_path.write_text("# OCR\n\n图片数：2\n\nall pages\n", encoding="utf-8")
    assert _wait_for_ocr(ocr_path, 1, image_folder, settle_seconds=0) is True


def test_demo_prompt_contains_local_entrypoint_and_finished_action() -> None:
    task = Task(
        task_id="001",
        name="演示患者甲",
        patient_id="DEMO-001",
        birth_date="1990-01-01",
        status="running",
        attempts=1,
        error_message="",
    )

    prompt = build_demo_prompt(task, Path("medical_records/auto/001"))

    assert "http://127.0.0.1:8765" in prompt
    assert "DEMO-001" in prompt
    assert "finished()" in prompt
    assert "call_user()" not in prompt
    assert "整个批次只登录一次" in prompt
    assert "只做身份核对和病历截图" in prompt
    assert "直接点击详情底部的“返回列表”准备下一个名单人员" in prompt


def test_auto_powershell_watches_ui_tars_project_screenshot_folder() -> None:
    script = Path("run_queue_auto.ps1").read_text(encoding="utf-8")

    assert "[string]$ScreenshotSource = (Join-Path $PSScriptRoot 'screenshots')" in script

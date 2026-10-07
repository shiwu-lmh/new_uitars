#!/usr/bin/env python3
"""Run the authorized synthetic/UI-TARS queue without interactive prompts.

The headless agent is allowed to finish only when it reports END and the OCR
watcher has produced a non-empty result file. CALL_USER, errors, timeouts, and
missing OCR results stop the queue instead of advancing to another person.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from task_queue import (
    QueueStore,
    Task,
    _write_task_files,
    initialize_from_csv,
    task_output_dir,
)
from ocr_screenshots import IMAGE_EXTENSIONS


def build_agent_command(
    *, node: str, runner: Path, settings: Path, prompt: Path, status: Path
) -> list[str]:
    return [
        node,
        str(runner),
        "--settings",
        str(settings),
        "--prompt-file",
        str(prompt),
        "--status-file",
        str(status),
    ]


def read_agent_status(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def is_successful_agent_run(status: dict[str, Any], ocr_path: Path) -> bool:
    if str(status.get("status", "")).upper() != "END":
        return False
    try:
        content = ocr_path.read_text(encoding="utf-8")
    except OSError:
        return False
    return bool(content.strip()) and "图片数：0" not in content


def build_demo_prompt(task: Task, output_dir: Path) -> str:
    return f"""这是本地虚构数据演示任务，不要访问任何真实医院系统或外部网站。

这是一个连续批量截图任务。名单中的每个人都要单独处理，截图保存到自己的输出文件夹；完成当前患者后回到患者列表继续处理下一个人。整个批次只登录一次。

本地演示地址是 http://127.0.0.1:8765。
如果当前页面已经是本地演示系统的患者列表或病历详情，不要刷新、退出或重新登录；从当前页面继续操作。只有在登录页时才使用账号 demo、密码 demo 登录。
搜索患者编号 {task.patient_id}，核对姓名为 {task.name}，出生日期为 {task.birth_date or '名单未提供'}。

执行要求：
1. 只在这个本地演示网页中操作，不要打开 PyCharm、PowerShell 或项目文件寻找入口。
2. 如果当前显示上一位患者的详情，点击“返回列表”，不要刷新页面；然后搜索当前患者编号。不要因为上一位患者的页面仍然存在就跳过当前患者。
3. 直接在“姓名/患者编号”框输入当前患者编号并点击“应用筛选”；只有搜索结果不唯一或为空时，才使用科室、状态、日期范围等辅助条件。不要为了测试而强制修改筛选条件或翻页。
4. 打开目标患者后，必须核对编号、姓名、出生日期、科室、状态、风险和更新时间。同名患者只能凭编号和出生日期确认；如果返回列表或弹窗出现，必须恢复当前患者。
5. 点击一次“展开全部记录”，从上到下查看当前患者的每一份病历；不需要收起后重新展开。
6. 在病历顶部稳定后使用 hotkey(key='win print') 保存截图，再滚动到病历底部稳定后保存第二张；内容过长时继续补截图。截图目录为：{output_dir}
7. 只做身份核对和病历截图，不执行业务确认、不修改病历、不导出摘要，也不要退出系统。
8. 在输出目录确认至少有两张当前任务截图，并确认 OCR 监视已接收全部截图后，直接点击详情底部的“返回列表”准备下一个名单人员，然后输出 finished()。不要为了找按钮反复滚回顶部，也不要处理名单中的下一位患者。
9. 如果浏览器或医院系统临时出现弹窗、确认框、加载遮罩、页面跳转或误触到无关控件，先观察并关闭/取消无关操作，恢复当前患者和当前病历位置后继续；不要提交医嘱、修改病历或处理下一位患者。病历过长时继续滚动补截图。
"""


def _start_child(command: list[str], project_root: Path) -> subprocess.Popen[bytes]:
    return subprocess.Popen(command, cwd=project_root)


def _stop_child(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _image_count(folder: Path) -> int:
    if not folder.is_dir():
        return 0
    return sum(
        1
        for child in folder.iterdir()
        if child.is_file() and child.suffix.lower() in IMAGE_EXTENSIONS
    )


def _ocr_page_count(path: Path) -> int:
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return 0
    match = re.search(r"图片数\s*[:：]\s*(\d+)", content)
    return int(match.group(1)) if match else 0


def _wait_for_ocr(
    path: Path,
    timeout_seconds: int,
    image_folder: Path,
    settle_seconds: float = 2.0,
) -> bool:
    """Wait until every copied screenshot has a non-empty OCR page.

    The watcher writes OCR.md incrementally. Checking only for a non-empty
    file allowed the queue to mark a task done after the first screenshot.
    Requiring the reported page count to match the copied image count, then
    waiting briefly for the count to stay unchanged, closes that race.
    """
    deadline = time.monotonic() + max(timeout_seconds, 0)
    stable_since: float | None = None
    last_image_count = -1
    while time.monotonic() <= deadline:
        image_count = _image_count(image_folder)
        if image_count != last_image_count:
            last_image_count = image_count
            stable_since = time.monotonic()
        if path.exists():
            try:
                content = path.read_text(encoding="utf-8")
            except OSError:
                content = ""
            page_count = _ocr_page_count(path)
            if (
                image_count > 0
                and page_count >= image_count
                and content.strip()
                and stable_since is not None
                and time.monotonic() - stable_since >= settle_seconds
            ):
                return True
        time.sleep(1)
    return False


def run_queue(args: argparse.Namespace) -> int:
    project_root = args.project_root.resolve()
    python = Path(sys.executable)
    initialize_from_csv(args.csv.resolve(), args.db.resolve())
    queue = QueueStore(args.db.resolve())
    queue.reset_running()

    args.output_root.mkdir(parents=True, exist_ok=True)
    args.prompt_file.parent.mkdir(parents=True, exist_ok=True)
    args.screenshot_source.mkdir(parents=True, exist_ok=True)

    while True:
        task = queue.claim_next()
        if task is None:
            return 0

        output_dir = task_output_dir(args.output_root, task.task_id)
        _write_task_files(task, args.output_root, args.prompt_file, args.task_id_file)
        status_file = output_dir / "agent-status.json"
        ocr_file = output_dir / "OCR.md"
        status_file.unlink(missing_ok=True)
        if args.demo_mode:
            args.prompt_file.write_text(build_demo_prompt(task, output_dir), encoding="utf-8")

        sync_process = _start_child(
            [
                str(python),
                str(project_root / "sync_windows_screenshots.py"),
                "--source",
                str(args.screenshot_source),
                "--target",
                str(output_dir),
                "--skip-existing",
                "--interval",
                "1",
            ],
            project_root,
        )
        ocr_process = _start_child(
            [
                str(python),
                str(project_root / "watch_ocr.py"),
                str(output_dir),
                "--output",
                str(ocr_file),
                "--config",
                str(args.ocr_config.resolve()),
            ],
            project_root,
        )
        agent_process: subprocess.Popen[bytes] | None = None
        try:
            agent_process = _start_child(
                build_agent_command(
                    node=args.node,
                    runner=args.agent_runner.resolve(),
                    settings=args.settings.resolve(),
                    prompt=args.prompt_file.resolve(),
                    status=status_file,
                ),
                project_root,
            )
            try:
                agent_process.wait(timeout=max(args.timeout_seconds, 1))
            except subprocess.TimeoutExpired:
                agent_process.kill()
                agent_process.wait(timeout=5)
                queue.mark(
                    task.task_id,
                    "waiting_manual",
                    "headless agent timed out; inspect the desktop and resume manually",
                )
                return 2

            status = read_agent_status(status_file)
            if str(status.get("status", "")).upper() == "CALL_USER":
                queue.mark(task.task_id, "waiting_manual", "agent requested user attention")
                return 2
            if str(status.get("status", "")).upper() == "ERROR":
                queue.mark(task.task_id, "failed", str(status.get("error", "agent error"))[:1000])
                return 1
            if not _wait_for_ocr(ocr_file, args.ocr_wait_seconds, output_dir):
                queue.mark(
                    task.task_id,
                    "failed",
                    "agent finished but OCR output for all screenshots was not produced",
                )
                return 1
            if not is_successful_agent_run(status, ocr_file):
                queue.mark(task.task_id, "failed", "agent did not report END or OCR output was empty")
                return 1
            queue.mark(task.task_id, "done")
        finally:
            _stop_child(agent_process)
            _stop_child(sync_process)
            _stop_child(ocr_process)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the queue through headless UI-TARS and OCR")
    parser.add_argument("--project-root", type=Path, default=Path(__file__).parent)
    parser.add_argument("--csv", type=Path, required=True)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--prompt-file", type=Path, required=True)
    parser.add_argument("--task-id-file", type=Path, default=Path("queue/current_task.id"))
    parser.add_argument("--ocr-config", type=Path, required=True)
    parser.add_argument("--screenshot-source", type=Path, required=True)
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("--agent-runner", type=Path, default=Path("ui_tars_agent_runner.mjs"))
    parser.add_argument("--node", default="node")
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    parser.add_argument("--ocr-wait-seconds", type=int, default=120)
    parser.add_argument("--demo-mode", action="store_true")
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        return run_queue(args)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"自动队列失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

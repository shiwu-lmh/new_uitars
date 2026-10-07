"""PyCharm 一键启动桌面端 UI-TARS 视觉任务。"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent
RUNNER = ROOT / "ui_tars_agent_runner.mjs"
DEFAULT_SETTINGS = ROOT / "model_settings.local.json"
DEFAULT_PROMPT = ROOT / "desktop_music_test_prompt.md"


def main() -> int:
    parser = argparse.ArgumentParser(description="启动桌面端 UI-TARS 视觉自动化任务")
    parser.add_argument("--prompt", type=Path, default=DEFAULT_PROMPT)
    parser.add_argument("--settings", type=Path, default=DEFAULT_SETTINGS)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--max-loop-count", type=int, default=30)
    args = parser.parse_args()

    node = shutil.which("node")
    if not node:
        print("错误：找不到 Node.js，请先确认 node 已加入 PATH。", file=sys.stderr)
        return 1
    if not RUNNER.exists():
        print(f"错误：找不到 UI-TARS runner：{RUNNER}", file=sys.stderr)
        return 1
    if not args.prompt.exists():
        print(f"错误：找不到任务提示词：{args.prompt}", file=sys.stderr)
        return 1
    if not args.settings.exists():
        print(f"错误：找不到模型配置：{args.settings}", file=sys.stderr)
        return 1

    output = args.output_dir or ROOT / "screenshots" / (
        f"desktop-ui-tars-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    )
    output.mkdir(parents=True, exist_ok=True)
    status = output / "agent-status.json"

    command = [
        node,
        str(RUNNER),
        "--settings",
        str(args.settings.resolve()),
        "--prompt-file",
        str(args.prompt.resolve()),
        "--status-file",
        str(status.resolve()),
        "--screenshot-dir",
        str(output.resolve()),
        "--max-loop-count",
        str(max(args.max_loop_count, 1)),
    ]

    print("启动桌面端 UI-TARS…", flush=True)
    print(f"任务提示词：{args.prompt.resolve()}", flush=True)
    print(f"输出目录：{output.resolve()}", flush=True)
    result = subprocess.run(command, cwd=ROOT, check=False)
    print(f"UI-TARS 结束，退出码：{result.returncode}", flush=True)
    print(f"状态文件：{status.resolve()}", flush=True)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())

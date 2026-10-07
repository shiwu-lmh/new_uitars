#!/usr/bin/env python3
"""Copy Windows Win+PrtScn screenshots into the OCR input folder."""

from __future__ import annotations

import argparse
import hashlib
import shutil
import time
from pathlib import Path

from ocr_screenshots import IMAGE_EXTENSIONS, natural_key


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot_digests(source: Path) -> set[str]:
    """Return hashes already present before a new queue task begins."""
    if not source.exists():
        return set()
    return {
        digest(path)
        for path in source.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    }


def copy_new_images(source: Path, target: Path, known: set[str]) -> int:
    target.mkdir(parents=True, exist_ok=True)
    existing = sorted(
        (p for p in target.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS),
        key=natural_key,
    )
    used_digests = {digest(path) for path in existing}
    next_number = 1
    for path in existing:
        if path.name.lower().startswith("page-"):
            try:
                next_number = max(next_number, int(path.stem.split("-")[-1]) + 1)
            except ValueError:
                pass

    copied = 0
    images = sorted(
        (p for p in source.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS),
        key=natural_key,
    ) if source.exists() else []
    for image in images:
        try:
            image_digest = digest(image)
            size = image.stat().st_size
            time.sleep(0.2)
            if image.stat().st_size != size:
                continue
        except OSError:
            continue
        if image_digest in used_digests or image_digest in known:
            continue

        destination = target / f"page-{next_number:03d}.png"
        shutil.copy2(image, destination)
        used_digests.add(image_digest)
        known.add(image_digest)
        next_number += 1
        copied += 1
        print(f"已复制：{image.name} -> {destination.name}", flush=True)
    return copied


def main() -> int:
    parser = argparse.ArgumentParser(
        description="监控 Windows Win+PrtScn 截图，并复制到 OCR 文件夹。"
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=Path.home() / "Pictures" / "Screenshots",
        help="Windows 截图目录，默认是当前用户的 Pictures\\Screenshots",
    )
    parser.add_argument(
        "--target",
        type=Path,
        default=Path(__file__).with_name("screenshots"),
        help="OCR 输入目录，默认是项目 screenshots",
    )
    parser.add_argument("--interval", type=float, default=1.0, help="扫描间隔秒数")
    parser.add_argument("--once", action="store_true", help="只同步一次然后退出")
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="启动时忽略源目录中已经存在的截图，只复制启动后新增的截图",
    )
    args = parser.parse_args()

    args.target.mkdir(parents=True, exist_ok=True)
    print(f"Windows 截图目录：{args.source.resolve()}")
    print(f"OCR 输入目录：{args.target.resolve()}")
    print("请让 UI-TARS 使用 hotkey(key='win print')；按 Ctrl+C 停止。")

    known = snapshot_digests(args.source) if args.skip_existing else set()
    while True:
        copy_new_images(args.source, args.target, known)
        if args.once:
            return 0
        try:
            time.sleep(max(args.interval, 0.2))
        except KeyboardInterrupt:
            print("已停止同步。")
            return 0


if __name__ == "__main__":
    raise SystemExit(main())

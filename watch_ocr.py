#!/usr/bin/env python3
"""Watch a folder for screenshots saved by UI-TARS and OCR new files."""

from __future__ import annotations

import argparse
from concurrent.futures import Future, ThreadPoolExecutor
import hashlib
import json
import os
import time
from pathlib import Path

from ocr_screenshots import (
    IMAGE_EXTENSIONS,
    endpoint_url,
    merge_pages,
    natural_key,
    recognize_document,
    recognize_image,
)


def load_config(path: Path) -> tuple[str, str, str, str]:
    config = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    api_mode = os.getenv("PADDLEOCR_API_MODE") or config.get("api_mode", "official-api")
    base_url = os.getenv("PADDLEOCR_BASE_URL") or config.get("base_url", "")
    model = os.getenv("PADDLEOCR_MODEL") or config.get("model", "PaddleOCR-VL")
    token = (
        os.getenv("PADDLEOCR_ACCESS_TOKEN")
        or os.getenv("PADDLEOCR_API_KEY")
        or config.get("access_token")
        or config.get("api_key")
        or config.get("accessToken")
        or ""
    )
    token = str(token).strip()
    if not base_url:
        base_url = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs"
    if api_mode == "official-api" and not token:
        raise RuntimeError(
            f"官方在线 API 需要 Access Token。请填写 {path} 的 access_token，"
            "或设置环境变量 PADDLEOCR_ACCESS_TOKEN。"
        )
    return endpoint_url(base_url, api_mode), api_mode, model, token


def write_output(
    path: Path,
    pages: list[str],
    processed_count: int,
    failures: list[tuple[str, str]],
) -> None:
    merged = merge_pages(pages)
    failure_text = ""
    if failures:
        failure_text = "\n## 失败详情\n\n" + "\n".join(
            f"- `{name}`：{reason}" for name, reason in failures
        ) + "\n"
    content = (
        f"# 截图 OCR 汇总\n\n图片数：{processed_count}\n\n"
        f"识别失败数：{len(failures)}\n\n{merged}\n{failure_text}"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def run_per_patient_mode(
    args: argparse.Namespace,
    url: str,
    api_mode: str,
    model: str,
    token: str,
) -> int:
    """Run one PaddleOCR document job for all screenshots in each patient folder."""
    workers = max(args.workers, 1)
    processed: set[str] = set()
    pending: dict[Future[str], tuple[Path, str, int]] = {}

    def current_groups() -> list[tuple[Path, list[Path]]]:
        groups: list[tuple[Path, list[Path]]] = []
        stopping = bool(args.stop_file and args.stop_file.exists())
        for folder in sorted((p for p in args.folder.iterdir() if p.is_dir()), key=natural_key):
            images = sorted(
                (p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS),
                key=natural_key,
            )
            if not images:
                continue
            # During a live run, wait for the browser's patient completion
            # marker so a folder is submitted only once, after all pages exist.
            # --once is intended for already completed folders and does not
            # require the marker.
            if not args.once and not stopping and not (folder / ".patient-done").exists():
                continue
            groups.append((folder, images))
        return groups

    def stable_group_key(folder: Path, images: list[Path]) -> str | None:
        try:
            before = [(image.name, image.stat().st_size, image.stat().st_mtime_ns) for image in images]
            time.sleep(0.2)
            after = [(image.name, image.stat().st_size, image.stat().st_mtime_ns) for image in images]
            if before != after:
                return None
            digest = hashlib.sha256()
            for image in images:
                digest.update(image.name.encode("utf-8"))
                digest.update(image.read_bytes())
            relative = folder.relative_to(args.folder).as_posix()
            return f"{relative}:{digest.hexdigest()}"
        except OSError:
            return None

    def recognize_with_retry(images: list[Path], folder: Path) -> str:
        attempts = max(args.retries, 0) + 1
        errors: list[str] = []
        for attempt in range(1, attempts + 1):
            try:
                return recognize_document(images, url, api_mode, model, token)
            except Exception as error:
                reason = f"第 {attempt}/{attempts} 次：{error}"
                errors.append(reason)
                print(f"患者 OCR 失败，准备重试：{folder.name}：{reason}", flush=True)
                if attempt < attempts:
                    time.sleep(max(args.retry_delay, 0))
        raise RuntimeError("；".join(errors))

    print(f"按患者合并 OCR，worker：{workers}")
    try:
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="paddleocr") as executor:
            while True:
                groups = current_groups()
                pending_keys = {key for _, key, _ in pending.values()}
                for folder, images in groups:
                    key = stable_group_key(folder, images)
                    if key is None or key in processed or key in pending_keys:
                        continue
                    if len(pending) >= workers:
                        break
                    print(f"提交患者 OCR：{folder.name}（{len(images)} 张截图，1 个 OCR 任务）", flush=True)
                    future = executor.submit(recognize_with_retry, images, folder)
                    pending[future] = (folder, key, len(images))
                    pending_keys.add(key)

                completed = [future for future in pending if future.done()]
                for future in completed:
                    folder, key, image_count = pending.pop(future)
                    processed.add(key)
                    result_path = folder / "ocr-result.md"
                    try:
                        text = future.result().strip()
                        if not text:
                            raise RuntimeError("OCR 返回空文本")
                        write_output(result_path, [text], image_count, [])
                        print(f"患者 OCR 完成：{folder.name}（{image_count} 张截图 → 1 个结果）", flush=True)
                    except Exception as error:
                        write_output(result_path, [], image_count, [(folder.name, str(error))])
                        print(f"患者 OCR 失败：{folder.name}：{error}", flush=True)

                if args.once and not pending:
                    remaining = any(
                        stable_group_key(folder, images) not in processed
                        for folder, images in current_groups()
                    )
                    if not remaining:
                        return 0
                if args.stop_file and args.stop_file.exists() and not pending:
                    remaining = [
                        folder.name
                        for folder, images in current_groups()
                        if stable_group_key(folder, images) not in processed
                    ]
                    if not remaining:
                        print(f"患者 OCR 队列已处理完毕：{len(processed)} 个患者任务。", flush=True)
                        if args.done_file:
                            args.done_file.parent.mkdir(parents=True, exist_ok=True)
                            args.done_file.touch()
                        return 0
                time.sleep(max(args.interval, 0.2))
    except KeyboardInterrupt:
        print("已停止监控。")
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="监控 UI-TARS 保存截图的文件夹，自动 OCR 并合并去重。"
    )
    parser.add_argument("folder", type=Path, help="UI-TARS 保存截图的文件夹")
    parser.add_argument("--output", type=Path, help="汇总 Markdown 文件路径")
    parser.add_argument(
        "--per-patient",
        action="store_true",
        help="按患者子目录分别生成 ocr-result.md，并递归监控截图",
    )
    parser.add_argument("--interval", type=float, default=2.0, help="扫描间隔秒数，默认 2")
    parser.add_argument("--once", action="store_true", help="只处理当前已有图片，然后退出")
    parser.add_argument("--stop-file", type=Path, help="文件出现后，在队列处理完毕时退出")
    parser.add_argument("--done-file", type=Path, help="队列处理完毕后创建此完成标记")
    parser.add_argument("--workers", type=int, default=3, help="并发 OCR 请求数，默认 3")
    parser.add_argument(
        "--retries",
        type=int,
        default=int(os.getenv("PADDLEOCR_RETRIES", "2")),
        help="单张图片失败后的重试次数，默认 2",
    )
    parser.add_argument(
        "--retry-delay",
        type=float,
        default=float(os.getenv("PADDLEOCR_RETRY_DELAY", "2")),
        help="OCR 重试间隔秒数，默认 2",
    )
    default_config = Path(__file__).with_name("ocr_config.local.json")
    if not default_config.exists():
        default_config = Path(__file__).with_name("ocr_config.json")
    parser.add_argument(
        "--config",
        type=Path,
        default=default_config,
        help="API 配置文件路径；默认优先读取未提交的 ocr_config.local.json",
    )
    args = parser.parse_args()

    args.folder.mkdir(parents=True, exist_ok=True)
    output = args.output or args.folder / "截图 OCR 汇总.md"
    try:
        url, api_mode, model, token = load_config(args.config)
    except (OSError, json.JSONDecodeError, RuntimeError) as error:
        print(f"配置错误：{error}")
        return 1

    print(f"正在监控：{args.folder.resolve()}")
    if args.per_patient:
        print(f"OCR 结果：每个患者子目录下的 {('ocr-result.md')}")
    else:
        print(f"OCR 结果：{output.resolve()}")
    print(f"OCR 接口：{url}")
    print(f"OCR 模型：{model}")
    print("请让 UI-TARS 把截图保存到这个文件夹；按 Ctrl+C 停止。")

    if args.per_patient:
        return run_per_patient_mode(args, url, api_mode, model, token)

    workers = max(args.workers, 1)
    processed: set[str] = set()
    pending: dict[Future[str], tuple[Path, str]] = {}
    pages_by_group: dict[Path, dict[str, str]] = {}
    failures_by_group: dict[Path, list[tuple[str, str]]] = {}
    processed_by_group: dict[Path, set[str]] = {}

    def recognize_with_retry(image: Path) -> str:
        attempts = max(args.retries, 0) + 1
        errors: list[str] = []
        for attempt in range(1, attempts + 1):
            try:
                return recognize_image(image, url, api_mode, model, token)
            except Exception as error:
                reason = f"第 {attempt}/{attempts} 次：{error}"
                errors.append(reason)
                print(f"OCR 失败，准备重试：{image.name}：{reason}", flush=True)
                if attempt < attempts:
                    time.sleep(max(args.retry_delay, 0))
        raise RuntimeError("；".join(errors))

    def current_images() -> list[Path]:
        candidates = args.folder.rglob("*") if args.per_patient else args.folder.iterdir()
        return sorted(
            (p for p in candidates if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS),
            key=natural_key,
        )

    def stable_key(image: Path) -> str | None:
        try:
            size = image.stat().st_size
            time.sleep(0.2)
            if image.stat().st_size != size:
                return None
            relative = image.relative_to(args.folder).as_posix()
            return f"{relative}:{hashlib.sha256(image.read_bytes()).hexdigest()}"
        except OSError:
            return None

    def group_for(image: Path) -> Path:
        return image.parent if args.per_patient else args.folder

    def ordered_pages(group: Path) -> list[str]:
        pages = pages_by_group.get(group, {})
        return [
            pages[name]
            for name in sorted(pages, key=lambda name: natural_key(Path(name)))
        ]

    def write_group_output(group: Path) -> None:
        result_path = group / "ocr-result.md" if args.per_patient else output
        write_output(
            result_path,
            ordered_pages(group),
            len(processed_by_group.get(group, set())),
            failures_by_group.get(group, []),
        )

    print(f"OCR 并发 worker：{workers}")
    try:
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="paddleocr") as executor:
            while True:
                images = current_images()
                pending_keys = {key for _, key in pending.values()}
                for image in images:
                    key = stable_key(image)
                    if key is None or key in processed or key in pending_keys:
                        continue
                    if len(pending) >= workers:
                        break
                    print(f"提交 OCR：{image.name}", flush=True)
                    future = executor.submit(recognize_with_retry, image)
                    pending[future] = (image, key)
                    pending_keys.add(key)

                completed = [future for future in pending if future.done()]
                for future in completed:
                    image, key = pending.pop(future)
                    processed.add(key)
                    group = group_for(image)
                    processed_by_group.setdefault(group, set()).add(image.name)
                    try:
                        text = future.result().strip()
                        if text:
                            pages_by_group.setdefault(group, {})[image.name] = text
                            print(f"OCR 完成：{image.name}", flush=True)
                        else:
                            print(f"OCR 完成但无文字：{image.name}", flush=True)
                        write_group_output(group)
                    except Exception as error:  # keep watching after one failed image
                        failures_by_group.setdefault(group, []).append((image.name, str(error)))
                        print(f"OCR 失败：{image.name}：{error}", flush=True)
                        write_group_output(group)

                if args.once and not pending:
                    remaining = False
                    for image in current_images():
                        key = stable_key(image)
                        if key is not None and key not in processed:
                            remaining = True
                            break
                    if not remaining:
                        return 0
                if args.stop_file and args.stop_file.exists() and not pending:
                    final_images = current_images()
                    remaining = []
                    for image in final_images:
                        key = stable_key(image)
                        if key is not None and key not in processed:
                            remaining.append(image.name)
                    if not remaining:
                        failure_count = sum(len(items) for items in failures_by_group.values())
                        print(f"OCR 队列已处理完毕：{len(processed)} 张，失败 {failure_count} 张。", flush=True)
                        if args.done_file:
                            args.done_file.parent.mkdir(parents=True, exist_ok=True)
                            args.done_file.touch()
                        return 0
                time.sleep(max(args.interval, 0.2))
    except KeyboardInterrupt:
        print("已停止监控。")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())

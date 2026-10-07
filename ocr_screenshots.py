#!/usr/bin/env python3
"""Batch OCR screenshots through an OpenAI-compatible PaddleOCR-VL endpoint."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
import sys
import tempfile
import urllib.error
import urllib.request
import time
from datetime import date
from pathlib import Path


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def capture_screen(destination: Path) -> Path:
    """Capture the current virtual desktop and return the saved image path."""
    try:
        from PIL import ImageGrab
    except ImportError as error:
        raise RuntimeError(
            "自动截图需要 Pillow，请运行：python -m pip install Pillow"
        ) from error

    destination.mkdir(parents=True, exist_ok=True)
    path = destination / "自动截图.png"
    try:
        image = ImageGrab.grab(all_screens=True)
    except OSError as error:
        raise RuntimeError(
            "当前环境无法读取桌面画面。请在有 Windows 交互桌面的 PowerShell 中运行，"
            "并确保 Python 进程有截屏权限。"
        ) from error
    image.save(path, format="PNG")
    return path


def natural_key(path: Path) -> list[object]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path.name)]


def normalize_line(line: str) -> str:
    # Official PaddleOCR markdown may number identical layout rows. Ignore
    # only that leading row number while deduplicating; keep the displayed
    # line unchanged in the final document.
    line = re.sub(r"^\s*\d+\s*\|", "|", line)
    return re.sub(r'[\s，,。.!！?？:：;；"“”‘’（）()【】\[\]<>《》、]', "", line).casefold()


def merge_pages(pages: list[str]) -> str:
    merged: list[str] = []
    seen: set[str] = set()

    for page in pages:
        lines = [line.strip() for line in page.splitlines() if line.strip()]
        max_overlap = min(len(merged), len(lines), 30)
        overlap = 0
        for size in range(max_overlap, 0, -1):
            if [normalize_line(line) for line in merged[-size:]] == [
                normalize_line(line) for line in lines[:size]
            ]:
                overlap = size
                break

        for line in lines[overlap:]:
            normalized = normalize_line(line)
            if normalized and normalized in seen:
                continue
            if normalized:
                seen.add(normalized)
            merged.append(line)

    return "\n".join(merged)


def endpoint_url(base_url: str, api_mode: str) -> str:
    url = base_url.strip().rstrip("/")
    if api_mode == "official-api":
        return url or "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs"
    route = "/layout-parsing" if api_mode == "paddleocr-service" else "/chat/completions"
    if url.lower().endswith(route):
        return url
    return f"{url}{route}"


def extract_markdown_text(payload: object) -> list[str]:
    """Extract markdown text from both current and legacy API result shapes."""
    texts: list[str] = []

    def visit(value: object) -> None:
        if isinstance(value, dict):
            markdown = value.get("markdown")
            if isinstance(markdown, dict):
                text = markdown.get("text")
                if isinstance(text, str) and text.strip():
                    texts.append(text)
            for key in ("result", "data", "extractResult", "layoutParsingResults"):
                child = value.get(key)
                if child is not None:
                    visit(child)
        elif isinstance(value, list):
            for item in value:
                visit(item)

    visit(payload)
    return texts


def recognize_official_api(path: Path, jobs_url: str, model: str, access_token: str) -> str:
    boundary = f"----PaddleOCRBoundary{int(time.time() * 1000)}"
    image = path.read_bytes()
    optional_payload = json.dumps(
        {
            "useDocOrientationClassify": False,
            "useDocUnwarping": False,
            # Desktop screenshots often contain overlapping application
            # windows. Allow the caller to opt into document layout parsing;
            # plain OCR is the safer default for screen text.
            "useLayoutDetection": os.getenv("PADDLEOCR_USE_LAYOUT_DETECTION", "0") == "1",
            "useChartRecognition": False,
        },
        separators=(",", ":"),
    )
    fields = [("model", model), ("optionalPayload", optional_payload)]
    body = bytearray()
    for name, value in fields:
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        body.extend(value.encode())
        body.extend(b"\r\n")
    body.extend(f"--{boundary}\r\n".encode())
    body.extend(
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'.encode()
    )
    body.extend(f"Content-Type: {mimetypes.guess_type(path.name)[0] or 'application/octet-stream'}\r\n\r\n".encode())
    body.extend(image)
    body.extend(f"\r\n--{boundary}--\r\n".encode())

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }
    request = urllib.request.Request(jobs_url, data=bytes(body), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            submitted = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"在线 API 提交失败 HTTP {error.code}: {detail[:1000]}") from error

    job_id = (submitted.get("data") or {}).get("jobId")
    if not job_id:
        raise RuntimeError(submitted.get("msg") or "在线 API 没有返回 jobId")

    for _ in range(120):
        time.sleep(5)
        status_request = urllib.request.Request(
            f"{jobs_url}/{job_id}", headers={"Authorization": f"Bearer {access_token}"}
        )
        try:
            with urllib.request.urlopen(status_request, timeout=60) as response:
                status = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"在线 API 查询失败 HTTP {error.code}: {detail[:1000]}") from error

        data = status.get("data") or {}
        extract_result = data.get("extractResult") or {}
        state = data.get("state") or (
            extract_result.get("state") if isinstance(extract_result, dict) else None
        )
        if state == "failed":
            error_message = data.get("errorMsg") or (
                extract_result.get("errorMsg")
                if isinstance(extract_result, dict)
                else None
            )
            raise RuntimeError(error_message or "在线 API 解析失败")
        if state != "done":
            continue

        extract_result = data.get("extractResult") or {}
        result_urls = data.get("resultUrl") or (
            extract_result.get("resultUrl") if isinstance(extract_result, dict) else {}
        ) or {}
        if not isinstance(result_urls, dict):
            result_urls = {}
        json_url = result_urls.get("jsonUrl")
        markdown_url = result_urls.get("markdownUrl")
        if not json_url and not markdown_url:
            raise RuntimeError("在线 API 完成后没有返回结果地址")

        if json_url:
            with urllib.request.urlopen(json_url, timeout=120) as response:
                result_body = response.read().decode("utf-8")
            payloads: list[object] = []
            for line in result_body.splitlines():
                if line.strip():
                    payloads.append(json.loads(line))
            if not payloads and result_body.strip():
                payloads.append(json.loads(result_body))
            texts: list[str] = []
            for payload in payloads:
                texts.extend(extract_markdown_text(payload))
            if texts:
                return "\n\n".join(texts)
            if os.getenv("PADDLEOCR_DEBUG"):
                preview = result_body[:3000].replace(access_token, "<redacted>")
                print(
                    f"[PaddleOCR 调试] jsonUrl 未找到 markdown.text，返回片段：\n{preview}",
                    file=sys.stderr,
                    flush=True,
                )

        if markdown_url:
            with urllib.request.urlopen(markdown_url, timeout=120) as response:
                markdown = response.read().decode("utf-8")
            if markdown.strip():
                return markdown
            if os.getenv("PADDLEOCR_DEBUG"):
                print("[PaddleOCR 调试] markdownUrl 返回为空", file=sys.stderr, flush=True)

        return ""

    raise RuntimeError("在线 API 等待超时（10 分钟）")


def recognize_image(
    path: Path, url: str, api_mode: str, model: str, api_key: str
) -> str:
    if api_mode == "official-api":
        return recognize_official_api(path, url, model, api_key)
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    if api_mode == "paddleocr-service":
        payload = {
            "file": encoded,
            "fileType": 0 if path.suffix.lower() == ".pdf" else 1,
        }
    else:
        payload = {
            "model": model,
            "stream": False,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "请识别并完整输出这张截图中的所有文字，按阅读顺序分行或分段输出。相邻截图可能有重复内容，请完整识别，不要自行删减。",
                        },
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:{mime};base64,{encoded}"},
                        },
                    ],
                }
            ],
        }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code}: {detail[:1000]}") from error

    if api_mode == "paddleocr-service":
        if "errorCode" in result and result["errorCode"] != 0:
            raise RuntimeError(result.get("errorMsg", "PaddleOCR-VL 请求失败"))
        pages = result.get("result", {}).get("layoutParsingResults", [])
        return "\n\n".join(
            (page.get("markdown") or {}).get("text", "")
            for page in pages
            if isinstance(page, dict)
        )

    content = result["choices"][0]["message"].get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            item.get("text", "")
            for item in content
            if isinstance(item, dict) and item.get("type") == "text"
        )
    return ""


def recognize_document(
    images: list[Path], url: str, api_mode: str, model: str, api_key: str
) -> str:
    """Submit all images from one patient folder as one document OCR job.

    The official PaddleOCR API accepts a PDF as one multi-page input. The
    temporary PDF preserves the screenshot order, so one patient folder maps
    to one remote OCR job and one result document.
    """
    if not images:
        raise ValueError("患者目录中没有可识别截图")
    if len(images) == 1:
        return recognize_image(images[0], url, api_mode, model, api_key)
    if api_mode not in {"official-api", "paddleocr-service"}:
        raise RuntimeError("按患者合并 OCR 需要 official-api 或 paddleocr-service 模式")

    try:
        from PIL import Image, ImageOps
    except ImportError as error:
        raise RuntimeError("按患者合并 OCR 需要 Pillow，请运行：python -m pip install Pillow") from error

    file_descriptor, temporary_name = tempfile.mkstemp(prefix="paddleocr-patient-", suffix=".pdf")
    os.close(file_descriptor)
    temporary_pdf = Path(temporary_name)
    opened: list[Image.Image] = []
    try:
        for image_path in images:
            with Image.open(image_path) as source:
                opened.append(ImageOps.exif_transpose(source).convert("RGB"))
        opened[0].save(
            temporary_pdf,
            format="PDF",
            save_all=True,
            append_images=opened[1:],
            resolution=150.0,
        )
        return recognize_image(temporary_pdf, url, api_mode, model, api_key)
    finally:
        for image in opened:
            image.close()
        temporary_pdf.unlink(missing_ok=True)


def collect_images(source: Path) -> list[Path]:
    if source.is_file():
        if source.suffix.lower() not in IMAGE_EXTENSIONS:
            raise ValueError(f"不是支持的图片文件：{source}")
        return [source]
    if not source.is_dir():
        raise ValueError(f"找不到输入路径：{source}")
    return sorted(
        (path for path in source.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS),
        key=natural_key,
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="批量识别网页截图，去除重复文字并导出 Markdown 文档。"
    )
    parser.add_argument("input", type=Path, nargs="?", help="截图文件或截图文件夹")
    parser.add_argument(
        "--capture",
        action="store_true",
        help="先截取当前桌面，再自动提交 OCR",
    )
    parser.add_argument(
        "--base-url",
        help="OpenAI 兼容 API 地址；默认读取 ocr_config.json",
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
    parser.add_argument(
        "--model",
        help="服务端模型名（默认：PaddleOCR-VL-1.6）",
    )
    parser.add_argument(
        "--api-mode",
        choices=("official-api", "paddleocr-service", "openai-compatible"),
        help="API 类型；默认读取配置文件（默认：official-api）",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="输出 Markdown 文件路径（默认写入截图文件夹）",
    )
    args = parser.parse_args()

    try:
        config = (
            json.loads(args.config.read_text(encoding="utf-8"))
            if args.config.exists()
            else {}
        )
    except (OSError, json.JSONDecodeError) as error:
        parser.error(f"读取 API 配置文件失败：{error}")

    base_url = (
        args.base_url
        or os.getenv("PADDLEOCR_BASE_URL")
        or config.get("base_url", "")
    )
    model = (
        args.model
        or os.getenv("PADDLEOCR_MODEL")
        or config.get("model", "PaddleOCR-VL-1.6")
    )
    api_mode = args.api_mode or config.get("api_mode", "official-api")
    if api_mode not in {"official-api", "paddleocr-service", "openai-compatible"}:
        parser.error("api_mode 必须是 official-api、paddleocr-service 或 openai-compatible")
    api_key = (
        os.getenv("PADDLEOCR_ACCESS_TOKEN")
        or os.getenv("PADDLEOCR_API_KEY")
        or config.get("access_token")
        or config.get("api_key", "")
    )
    if api_mode == "official-api" and not api_key:
        parser.error("在线官方 API 需要 access_token，请在 ocr_config.json 中填写")
    if not base_url:
        parser.error("请在 ocr_config.json 的 base_url 中填写 OCR 服务地址")
    if args.capture and args.input:
        parser.error("--capture 不需要同时提供输入文件或文件夹")
    if not args.capture and not args.input:
        parser.error("请提供截图文件夹，或使用 --capture 自动截图")

    try:
        if args.capture:
            capture_path = capture_screen(Path(__file__).with_name("screenshots"))
            print(f"已截图：{capture_path}", flush=True)
            images = [capture_path]
            input_path = capture_path
        else:
            input_path = args.input
            images = collect_images(input_path)
        if not images:
            raise ValueError("输入文件夹中没有支持的图片")

        unique_images: list[Path] = []
        seen_images: set[str] = set()
        for image in images:
            digest = hashlib.sha256(image.read_bytes()).hexdigest()
            if digest not in seen_images:
                seen_images.add(digest)
                unique_images.append(image)

        url = endpoint_url(base_url, api_mode)
        pages: list[str] = []
        failures: list[tuple[Path, str]] = []
        for index, image in enumerate(unique_images, start=1):
            print(f"[{index}/{len(unique_images)}] 正在识别：{image.name}", flush=True)
            try:
                text = recognize_image(image, url, api_mode, model, api_key)
                if text.strip():
                    pages.append(text)
            except Exception as error:  # Keep processing the remaining screenshots.
                failures.append((image, str(error)))
                print(f"  识别失败：{error}", file=sys.stderr, flush=True)

        if not pages:
            print("所有截图都未能识别，没有生成文档。", file=sys.stderr)
            return 1

        merged = merge_pages(pages)
        output = args.output or (input_path if input_path.is_dir() else input_path.parent) / "截图 OCR 汇总.md"
        output.write_text(
            f"# 截图 OCR 汇总\n\n"
            f"图片数：{len(unique_images)}\n\n"
            f"识别失败数：{len(failures)}\n\n"
            f"{merged}\n",
            encoding="utf-8",
        )
        print(f"已保存：{output.resolve()}")
        if failures:
            print(f"有 {len(failures)} 张截图识别失败；文档包含其余成功结果。")
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"错误：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

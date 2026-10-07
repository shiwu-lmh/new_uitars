"""显示不抢焦点、尽量不拦截点击的桌面端 AI 操作蓝光提示。"""

from __future__ import annotations

import argparse
import ctypes
from pathlib import Path
import tkinter as tk


def make_click_through(window: tk.Tk) -> None:
    """让 Windows 叠加层不抢焦点并尽量允许鼠标事件穿透。"""

    if not hasattr(ctypes, "windll"):
        return
    window.update_idletasks()
    hwnd = window.winfo_id()
    user32 = ctypes.windll.user32
    get_long = user32.GetWindowLongPtrW
    set_long = user32.SetWindowLongPtrW
    get_long.argtypes = [ctypes.c_void_p, ctypes.c_int]
    get_long.restype = ctypes.c_longlong
    set_long.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_longlong]
    set_long.restype = ctypes.c_longlong
    exstyle_index = -20
    exstyle = get_long(hwnd, exstyle_index)
    exstyle |= 0x00000020  # WS_EX_TRANSPARENT
    # 不使用 WS_EX_LAYERED：Tk 在部分 Windows 缩放/显卡环境下会把
    # layered 窗口的蓝色内容渲染成黑色。
    exstyle |= 0x08000000  # WS_EX_NOACTIVATE
    exstyle |= 0x00000080  # WS_EX_TOOLWINDOW
    set_long(hwnd, exstyle_index, exstyle)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stop-file", type=Path, required=True)
    parser.add_argument("--ready-file", type=Path)
    parser.add_argument("--label", default="AI 正在操作桌面")
    args = parser.parse_args()

    root = tk.Tk()
    width = root.winfo_screenwidth()
    height = root.winfo_screenheight()
    # 用独立的边框窗口，不再依赖 Tk 的 transparentcolor。
    # 某些 Windows 缩放/显卡环境下，transparentcolor 会让蓝色边框不可见。
    root.withdraw()
    border = 8
    windows: list[tk.Toplevel] = []
    canvases: list[tk.Canvas] = []

    def make_strip(x: int, y: int, strip_width: int, strip_height: int) -> None:
        window = tk.Toplevel(root)
        window.overrideredirect(True)
        window.attributes("-topmost", True)
        window.configure(background="#1683ff")
        window.geometry(f"{strip_width}x{strip_height}+{x}+{y}")
        canvas = tk.Canvas(window, bg="#1683ff", highlightthickness=0)
        canvas.pack(fill="both", expand=True)
        make_click_through(window)
        windows.append(window)
        canvases.append(canvas)

    make_strip(0, 0, width, border)
    make_strip(0, height - border, width, border)
    make_strip(0, 0, border, height)
    make_strip(width - border, 0, border, height)

    badge_width = 300
    badge_height = 52
    badge = tk.Toplevel(root)
    badge.overrideredirect(True)
    badge.attributes("-topmost", True)
    badge.configure(background="#082b63")
    badge.geometry(f"{badge_width}x{badge_height}+{width - badge_width - 30}+24")
    badge_canvas = tk.Canvas(badge, bg="#082b63", highlightthickness=0)
    badge_canvas.pack(fill="both", expand=True)
    badge_canvas.create_rectangle(1, 1, badge_width - 1, badge_height - 1, outline="#55b9ff", width=2)
    badge_text = badge_canvas.create_text(
        badge_width / 2,
        badge_height / 2,
        text=f"●  {args.label}",
        fill="#f2f9ff",
        font=("Segoe UI", 12, "bold"),
    )
    make_click_through(badge)
    windows.append(badge)
    canvases.append(badge_canvas)
    root.update_idletasks()
    if args.ready_file:
        args.ready_file.parent.mkdir(parents=True, exist_ok=True)
        args.ready_file.write_text("ready\n", encoding="utf-8")

    bright = True

    def animate() -> None:
        nonlocal bright
        if args.stop_file.exists():
            if args.ready_file:
                args.ready_file.unlink(missing_ok=True)
            root.destroy()
            return
        color = "#8bd8ff" if bright else "#1683ff"
        bright = not bright
        for canvas in canvases[:4]:
            canvas.configure(background=color)
        canvases[4].configure(background="#0b438e" if bright else "#082b63")
        canvases[4].itemconfigure(badge_text, fill="#ffffff" if bright else "#d6efff")
        root.after(450, animate)

    root.after(100, animate)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

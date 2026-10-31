"""逐帧测底部条带平均亮度，定位键盘弹出的动画区间。

键盘底色比页面亮（页面 #151517 亮度 21，键盘约 #2B2B2B 亮度 43）。
键盘从底部滑上来时，底部条带的平均亮度会单调上升；动画结束就稳定。
打印全部帧，找出上升区间，再人工核对那几帧有没有异色缝。
"""
import glob
import os
import sys

from PIL import Image

FRAME_DIR = sys.argv[1] if len(sys.argv) > 1 else r"D:\dsh-mobile-app\build-artifacts\f"


def strip_mean(img, y0_ratio, y1_ratio=1.0):
    w, h = img.size
    small = img.resize((w // 6, h // 6))
    px = small.load()
    sw, sh = small.size
    y0 = int(sh * y0_ratio)
    y1 = int(sh * y1_ratio)
    s = 0
    n = 0
    for y in range(y0, y1):
        for x in range(sw):
            r, g, b = px[x, y][:3]
            s += (r * 299 + g * 587 + b * 114) // 1000
            n += 1
    return s / max(n, 1)


def main():
    paths = sorted(glob.glob(os.path.join(FRAME_DIR, "f*.jpg")))
    if not paths:
        print("NO FRAMES")
        return 1

    prev = None
    print(f"frames={len(paths)}")
    for i, p in enumerate(paths):
        img = Image.open(p).convert("RGB")
        # 最底部 12% 是键盘区域；键盘进来这里会明显变亮
        m = strip_mean(img, 0.88)
        delta = "" if prev is None else f" Δ{m - prev:+.1f}"
        mark = ""
        if prev is not None and abs(m - prev) > 2.0:
            mark = "  <<< 变化"
        print(f"#{i:03d} {os.path.basename(p)} 底部亮度={m:6.2f}{delta}{mark}")
        prev = m
    return 0


if __name__ == "__main__":
    sys.exit(main())

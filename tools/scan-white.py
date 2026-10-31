"""在录屏帧里找「疑似留白/白闪」——底部区域里近白色（高亮度、低饱和）像素。

DSH 页面底色 #151517（亮度 21），键盘底色 #2B2B2B（亮度 43）。
真正可疑的是亮度 > 120 的中性灰白色块。逐帧统计底部 45% 区域的近白像素数，
一旦数量跳变就说明出现了不属于深色主题的亮块。
"""
import glob
import os
import sys

from PIL import Image

FRAME_DIR = sys.argv[1] if len(sys.argv) > 1 else r"D:\dsh-mobile-app\build-artifacts\f2"
CROP_TOP = float(sys.argv[2]) if len(sys.argv) > 2 else 0.55


def near_white_count(img):
    w, h = img.size
    small = img.resize((w // 8, h // 8))
    sw, sh = small.size
    y0 = int(sh * CROP_TOP)
    px = small.load()
    cnt = 0
    rect = None
    for y in range(y0, sh):
        row_hit = 0
        for x in range(sw):
            r, g, b = px[x, y][:3]
            lum = (r * 299 + g * 587 + b * 114) // 1000
            if lum > 120 and max(r, g, b) - min(r, g, b) < 40:
                cnt += 1
                row_hit += 1
        if row_hit > sw * 0.5 and rect is None:
            rect = y * 8
    return cnt, rect


def main():
    paths = sorted(glob.glob(os.path.join(FRAME_DIR, "f*.jpg")))
    if not paths:
        print("NO FRAMES")
        return 1
    print(f"frames={len(paths)} crop_top={CROP_TOP}")
    prev = None
    for i, p in enumerate(paths):
        img = Image.open(p).convert("RGB")
        cnt, rect = near_white_count(img)
        tag = ""
        if prev is not None and abs(cnt - prev) > 30:
            tag = "  <<< 跳变"
        if cnt > 200:
            tag += "  [大量近白]"
        print(f"#{i:03d} {os.path.basename(p)} 近白像素={cnt:6d} 首个宽白行y={rect}{tag}")
        prev = cnt
    return 0


if __name__ == "__main__":
    sys.exit(main())

# -*- coding: utf-8 -*-
"""
逐帧测「键盘顶边」与「输入框底边」，用来判断两者位移是否同步。

实测色值（不是猜的，取自 k1\k0001.jpg 采样）：
- 页面底色 rgb(29,29,29)。注意这不是 DSH 的 body 色 #151517——
  录屏走的是 MIUI 的色彩后处理，整体抬了一档，所以判据要以录屏实色为准。
- 键盘候选栏/键区 rgb(50..55)，与页面底色差 20+，够用。
- 输入框底色 rgb(50,50,50)，同样够用。

纵向布局实测（k0001，键盘已弹出）：
- 输入框占 y≈870~1180
- 键盘顶边 y≈1530
所以输入框探测区间取 700~1400，键盘从画面底部往上扫。

只打印有变化的帧，避免上百行噪音。
"""
import sys
import os
from PIL import Image

PAGE_BG = (29, 29, 29)
DELTA = 10                 # 与页面底色差值阈值，判定「不是页面」
COMPOSER_TOP = 700
COMPOSER_BOT = 1400


def row_is_page(px, y, w):
    """取一行中间 60% 的若干采样点，判断这行是不是纯页面底色。"""
    x0 = int(w * 0.2)
    x1 = int(w * 0.8)
    step = max(1, (x1 - x0) // 40)
    for x in range(x0, x1, step):
        r, g, b = px[x, y][:3]
        if abs(r - PAGE_BG[0]) > DELTA or \
           abs(g - PAGE_BG[1]) > DELTA or \
           abs(b - PAGE_BG[2]) > DELTA:
            return False
    return True


def keyboard_top(im, px, w, h):
    for y in range(h - 1, h // 3, -1):
        if row_is_page(px, y, w):
            return y + 1
    return h


def composer_bottom(im, px, w, h):
    """输入框底边：这一区间里最后一个「明显比底色亮」的行。"""
    x = w // 2
    last = None
    for y in range(COMPOSER_TOP, min(COMPOSER_BOT, h)):
        r, g, b = px[x, y][:3]
        if r - PAGE_BG[0] > DELTA or g - PAGE_BG[1] > DELTA or b - PAGE_BG[2] > DELTA:
            last = y
    return last


def main():
    folder = sys.argv[1]
    files = sorted(os.listdir(folder))
    prev = None
    print(f"{'frame':>10} {'kbTop':>7} {'kbUp':>6} {'cmpBot':>7} {'cmpUp':>6} {'lag':>6}")
    for name in files:
        if not name.lower().endswith(('.jpg', '.png')):
            continue
        im = Image.open(os.path.join(folder, name)).convert('RGB')
        w, h = im.size
        px = im.load()
        kt = keyboard_top(im, px, w, h)
        cb = composer_bottom(im, px, w, h)
        # 屏幕上的「上移量」= 屏幕高度 - 坐标
        kb_up = h - kt
        cmp_up = (h - cb) if cb is not None else None
        lag = (kb_up - cmp_up) if cmp_up is not None else None
        cur = (kb_up, cmp_up)
        if cur != prev:
            print(f"{name:>10} {kt:>7} {kb_up:>6} "
                  f"{cb if cb is not None else -1:>7} "
                  f"{cmp_up if cmp_up is not None else -1:>6} "
                  f"{lag if lag is not None else -1:>6}")
            prev = cur


if __name__ == '__main__':
    main()

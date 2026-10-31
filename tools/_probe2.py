from PIL import Image
from collections import Counter
p = r"D:\dsh-mobile-app\build-artifacts\f2\f0055.jpg"
im = Image.open(p).convert("RGB")
w,h = im.size
px = im.load()
print("size", w, h)
# 键盘区域取 y 1700..2460 找众数色
c = Counter()
for y in range(1700, 2460, 3):
    for x in range(0, w, 3):
        c[px[x,y]] += 1
for col, n in c.most_common(6):
    print("keyboard", col, n)
c2 = Counter()
for y in range(700, 1500, 3):
    for x in range(0, w, 3):
        c2[px[x,y]] += 1
for col, n in c2.most_common(4):
    print("page", col, n)

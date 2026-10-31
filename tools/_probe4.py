from PIL import Image
import glob, os
d = r"D:\dsh-mobile-app\build-artifacts\f4"
for i in range(240, 285):
    p = os.path.join(d, f"f{i:04d}.jpg")
    if not os.path.exists(p): continue
    im = Image.open(p).convert("RGB"); px = im.load(); w,h = im.size
    # 沿中线每 60px 采一点，看有没有整段同色空白
    vals = [px[540,y][0] for y in range(1400, 2400, 100)]
    print(f"{i:04d}", " ".join(f"{v:3d}" for v in vals))

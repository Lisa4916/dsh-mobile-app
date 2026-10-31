from PIL import Image
import sys
for name in ["f0047.jpg","f0049.jpg","f0050.jpg","f0051.jpg","f0052.jpg","f0053.jpg","f0054.jpg","f0055.jpg"]:
    p = r"D:\dsh-mobile-app\build-artifacts\f2\\" + name
    im = Image.open(p).convert("RGB")
    w,h = im.size
    px = im.load()
    # 采几个纵向高度点，中部 x=540
    pts = [1400,1600,1750,1850,1950,2050,2150,2250,2350]
    vals = []
    for y in pts:
        vals.append(f"y{y}={px[540,y]}")
    # 找底部 45% 区域里「比页面底色 21 亮度低很多」或「很高」的行区间
    print(name, " ".join(vals))

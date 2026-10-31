from PIL import Image
# f0050 是留白最明显的一帧，量它的分区块色
p = r"D:\dsh-mobile-app\build-artifacts\f2\f0050.jpg"
im = Image.open(p).convert("RGB"); px = im.load(); w,h = im.size
print("h", h, "webview bottom px =", 573*2.748)
for y in range(1500, 2460, 60):
    print(y, px[540,y])

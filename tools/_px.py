from PIL import Image
im = Image.open(r'D:\dsh-mobile-app\build-artifacts\k1\k0001.jpg').convert('RGB')
w,h = im.size
px = im.load()
print('size', w, h)
for y in [600, 700, 730, 740, 750, 760, 900, 1200, 2000, 2300, 2380, 2400, 2420, 2440, 2450, 2459]:
    print(y, [px[x,y] for x in (100, 300, 540, 800, 1000)])

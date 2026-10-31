from PIL import Image
im = Image.open(r'D:\dsh-mobile-app\build-artifacts\k1\k0001.jpg').convert('RGB')
w,h = im.size
px = im.load()
prev=None
print('y  avgRowMid60')
for y in range(0, h, 10):
    xs = range(int(w*0.2), int(w*0.8), 8)
    vals = [sum(px[x,y][:3])/3 for x in xs]
    avg = sum(vals)/len(vals)
    print(y, round(avg,1))

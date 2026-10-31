from PIL import Image
import os
base = r'D:\dsh-mobile-app\build-artifacts\k1'
def prof(name):
    im = Image.open(os.path.join(base, name)).convert('RGB')
    w,h = im.size; px = im.load()
    rows=[]
    for y in range(0,h,20):
        xs = range(int(w*0.2), int(w*0.8), 8)
        rows.append((y, round(sum(sum(px[x,y][:3])/3 for x in xs)/len(xs),1)))
    return rows
for n in ['k0040.jpg','k0042.jpg','k0044.jpg','k0046.jpg','k0049.jpg','k0055.jpg']:
    p = prof(n)
    # 打印底部一半
    tail = [(y,v) for y,v in p if y>=900]
    print('==',n)
    print(tail)

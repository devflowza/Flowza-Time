import sys
from PIL import Image
out, files = sys.argv[1], sys.argv[2:]
W, H = 960, 540
img = Image.new('RGB', (W * 2, H * ((len(files) + 1) // 2)), 'white')
for i, f in enumerate(files):
    im = Image.open(f).resize((W, H), Image.LANCZOS)
    img.paste(im, ((i % 2) * W, (i // 2) * H))
img.save(out, quality=85)
print(out)

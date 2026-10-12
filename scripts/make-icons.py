"""Draws the app icons (a notebook mark on the app's green). Run: npm run icons"""
from pathlib import Path
from PIL import Image, ImageDraw

GREEN = (45, 91, 78)
PAPER = (255, 253, 248)
LINE = (45, 91, 78)
OUT = Path(__file__).resolve().parent.parent / "public" / "icons"


def draw(size: int, safe: float) -> Image.Image:
    img = Image.new("RGB", (size, size), GREEN)
    d = ImageDraw.Draw(img)
    # notebook page inside the safe zone
    w = size * safe * 0.62
    h = size * safe * 0.78
    x0 = (size - w) / 2
    y0 = (size - h) / 2
    r = size * 0.04
    d.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=r, fill=PAPER)
    # spine
    d.rectangle([x0, y0, x0 + w * 0.12, y0 + h], fill=(214, 228, 222))
    # ruled lines
    lw = max(2, size // 64)
    for i in range(1, 6):
        y = y0 + h * (0.18 + i * 0.13)
        d.line([x0 + w * 0.22, y, x0 + w * 0.86, y], fill=LINE, width=lw)
    return img


OUT.mkdir(parents=True, exist_ok=True)
draw(192, 1.0).save(OUT / "icon-192.png")
draw(512, 1.0).save(OUT / "icon-512.png")
draw(512, 0.72).save(OUT / "maskable-512.png")  # content inside the maskable safe circle
draw(180, 1.0).save(OUT / "apple-touch-icon.png")
print("icons written to", OUT)

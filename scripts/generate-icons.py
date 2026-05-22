"""Generate PNG icons from SVG for PWA manifest."""
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("pip install pillow")
    raise

OUT = Path(__file__).resolve().parents[1] / "apps" / "recorder-pwa" / "public" / "icons"


def draw_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (12, 74, 110, 255))
    d = ImageDraw.Draw(img)
    w = size
    d.polygon(
        [(w * 0.25, w * 0.62), (w * 0.5, w * 0.32), (w * 0.75, w * 0.62)],
        outline=(56, 189, 248),
        width=max(2, size // 24),
    )
    d.ellipse(
        (w * 0.42, w * 0.36, w * 0.58, w * 0.44),
        fill=(249, 115, 22, 255),
    )
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        draw_icon(size).save(OUT / f"icon-{size}.png", "PNG")
    print(f"Wrote icons to {OUT}")


if __name__ == "__main__":
    main()

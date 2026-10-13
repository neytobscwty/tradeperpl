from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "emoji" / "trend"
OUT.mkdir(parents=True, exist_ok=True)


def make(name: str, color: tuple[int, int, int, int], up: bool) -> None:
    scale = 8
    canvas = Image.new("RGBA", (100 * scale, 100 * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    points = [(50, 13), (91, 83), (9, 83)] if up else [(9, 17), (91, 17), (50, 87)]
    points = [(x * scale, y * scale) for x, y in points]
    draw.polygon(points, fill=color)
    canvas = canvas.resize((100, 100), Image.Resampling.LANCZOS)
    canvas.save(OUT / f"trend-{name}-emoji-100.png", "PNG", optimize=True)


make("up", (67, 224, 139, 255), True)
make("down", (255, 77, 94, 255), False)
print(OUT)

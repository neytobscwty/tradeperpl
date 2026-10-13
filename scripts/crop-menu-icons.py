from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
source = Image.open(ROOT / "assets" / "emoji" / "menu-icons-sheet-v2.png").convert("RGBA")
output = ROOT / "assets" / "emoji" / "menu-v2"
output.mkdir(parents=True, exist_ok=True)

names = ["positions", "orders", "portfolio", "markets", "alerts", "settings", "refresh"]
cell_width = source.width / 4
cell_height = source.height / 2

for index, name in enumerate(names):
    column, row = index % 4, index // 4
    cell = source.crop((round(column * cell_width), round(row * cell_height), round((column + 1) * cell_width), round((row + 1) * cell_height)))
    alpha_box = cell.getchannel("A").getbbox()
    if not alpha_box:
        raise RuntimeError(f"No visible pixels for {name}")
    icon = cell.crop(alpha_box)
    icon.thumbnail((94, 94), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    canvas.alpha_composite(icon, ((100 - icon.width) // 2, (100 - icon.height) // 2))
    canvas.save(output / f"{name}-emoji-100.png", "PNG", optimize=True)
    print(name, icon.size)

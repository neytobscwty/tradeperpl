from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "ui-preview-positions.png"
W, H = 1400, 1100
BG = "#0b1119"
CARD = "#172433"
TEXT = "#f5f7fa"
MUTED = "#96a7ba"
PURPLE = "#7657ff"
GREEN = "#347d39"
BLUE = "#2e7898"
RED = "#a84343"
LINE = "#243548"

font = ImageFont.truetype(r"C:\Windows\Fonts\segoeui.ttf", 25)
small = ImageFont.truetype(r"C:\Windows\Fonts\segoeui.ttf", 20)
bold = ImageFont.truetype(r"C:\Windows\Fonts\segoeuib.ttf", 27)
title = ImageFont.truetype(r"C:\Windows\Fonts\segoeuib.ttf", 32)

image = Image.new("RGB", (W, H), BG)
draw = ImageDraw.Draw(image)


def button(x, y, w, label, color=CARD):
    draw.rounded_rectangle((x, y, x + w, y + 54), radius=12, fill=color, outline=LINE)
    box = draw.textbbox((0, 0), label, font=small)
    draw.text((x + (w - (box[2] - box[0])) / 2, y + 13), label, font=small, fill=TEXT)


def panel(x, y, w, h, heading, lines, buttons):
    draw.rounded_rectangle((x, y, x + w, y + h), radius=24, fill=CARD)
    draw.text((x + 28, y + 22), heading, font=title, fill=TEXT)
    cy = y + 78
    for line, color, weight in lines:
        draw.text((x + 28, cy), line, font=bold if weight else font, fill=color)
        cy += 38
    by = y + h + 12
    gap = 10
    bw = (w - gap * (len(buttons) - 1)) / len(buttons)
    for index, (label, color) in enumerate(buttons):
        button(x + index * (bw + gap), by, bw, label, color)


draw.text((36, 26), "TradePerpl - UI states", font=title, fill=PURPLE)

panel(36, 82, 640, 390, "TradePerpl", [
    ("Monad · 0xa18e...8075", MUTED, False),
    ("$128.43 USDC", TEXT, True),
    ("Open PnL  +$12.64", "#59d98e", True),
    ("Positions · 2", TEXT, True),
    ("BTC · LONG 5x · +$14.21", TEXT, False),
    ("ETH · SHORT 3x · -$1.57", TEXT, False),
    ("BTC  $82,831.60  -1.11%", MUTED, False),
    ("ETH  $2,529.88  +0.08%", MUTED, False),
    ("MON  $0.025472  -5.56%", MUTED, False),
], [("Trade", GREEN), ("Refresh", BLUE)])

panel(724, 82, 640, 390, "OPEN POSITIONS · 2", [
    ("BTC-PERP · LONG · 5x", TEXT, True),
    ("PnL  +$14.21 · +11.4%", "#59d98e", True),
    ("Size  0.0015 BTC · Value  $124.25", MUTED, False),
    ("Entry  $73,360 · Mark  $82,832", MUTED, False),
    ("Margin  $24.85 · Liq.  $61,210", MUTED, False),
    ("ETH-PERP · SHORT · 3x", TEXT, True),
    ("PnL  -$1.57 · -2.1%", "#ef7777", True),
], [("Close all", RED), ("New trade", GREEN), ("Main menu", BLUE)])

panel(36, 580, 640, 330, "PORTFOLIO", [
    ("0xa18e...8075", MUTED, False),
    ("Balance  128.43 USDC", TEXT, True),
    ("In orders  20.00 USDC", MUTED, False),
    ("Realized PnL  +$37.12", "#59d98e", True),
    ("Volume  $8,420 · Fees  $4.18", MUTED, False),
    ("Win rate  61.5% · Trades  26", MUTED, False),
], [("Trade", GREEN), ("Main menu", BLUE)])

panel(724, 580, 640, 330, "SETTINGS", [
    ("Monad", TEXT, True),
    ("0xa18e759b0a83b7ee4432be7413b3127a9b6e8075", MUTED, False),
    ("", TEXT, False),
    ("Perpl API key active", "#59d98e", True),
], [("Replace API key", CARD), ("Disconnect", RED), ("Main menu", BLUE)])

draw.text((36, 1052), "Static preview - live values and market icons are filled by the bot.", font=small, fill=MUTED)
image.save(OUT, "PNG", optimize=True)
print(OUT)

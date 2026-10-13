from __future__ import annotations

import io
import json
import ssl
import time
import urllib.request
import urllib.error
from pathlib import Path

from PIL import Image, ImageDraw
import certifi

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "emoji" / "pack"
OUT.mkdir(parents=True, exist_ok=True)

COINS = {
    "btc": "bitcoin",
    "eth": "ethereum",
    "mon": "monad",
    "sol": "solana",
    "hype": "hyperliquid",
    "zec": "zcash",
    "lit": "lighter",
    "vvv": "venice-token",
    "pump": "pump-fun",
    "near": "near",
    "uni": "uniswap",
}
DIRECT_IMAGES = {
    "near": "https://coin-images.coingecko.com/coins/images/10365/large/near.jpg",
    "uni": "https://coin-images.coingecko.com/coins/images/12504/large/uniswap-logo.png",
}

HEADERS = {"User-Agent": "TradePerplBot/1.0"}
SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())


def fetch_json(url: str) -> dict:
    for attempt in range(5):
        request = urllib.request.Request(url, headers=HEADERS)
        try:
            with urllib.request.urlopen(request, timeout=20, context=SSL_CONTEXT) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == 4:
                raise
            time.sleep(5)
    raise RuntimeError("unreachable")


def fetch_bytes(url: str) -> bytes:
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=20, context=SSL_CONTEXT) as response:
        return response.read()


def fit_logo(data: bytes, output: Path) -> None:
    source = Image.open(io.BytesIO(data)).convert("RGBA")
    source.thumbnail((84, 84), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    canvas.alpha_composite(source, ((100 - source.width) // 2, (100 - source.height) // 2))
    canvas.save(output, "PNG", optimize=True)


def action_icon(name: str) -> None:
    canvas = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    purple = (108, 82, 255, 255)
    white = (255, 255, 255, 255)
    draw.rounded_rectangle((6, 6, 94, 94), radius=24, fill=purple)
    if name == "positions":
        draw.line((28, 73, 44, 53, 56, 62, 75, 30), fill=white, width=9, joint="curve")
        draw.ellipse((68, 23, 80, 35), fill=white)
    elif name == "orders":
        draw.rounded_rectangle((27, 23, 73, 80), radius=7, outline=white, width=7)
        draw.rectangle((39, 17, 61, 30), fill=white)
        for y in (43, 57, 71): draw.line((38, y, 63, y), fill=white, width=5)
    elif name == "portfolio":
        draw.rounded_rectangle((20, 36, 80, 76), radius=8, outline=white, width=7)
        draw.arc((37, 21, 63, 48), 180, 360, fill=white, width=7)
        draw.line((20, 51, 80, 51), fill=white, width=6)
    elif name == "markets":
        for x, top in ((25, 55), (45, 39), (65, 25)):
            draw.rounded_rectangle((x, top, x + 11, 77), radius=3, fill=white)
    elif name == "alerts":
        draw.ellipse((29, 25, 71, 70), outline=white, width=7)
        draw.rectangle((25, 51, 75, 69), fill=purple)
        draw.arc((25, 29, 75, 79), 15, 165, fill=white, width=7)
        draw.ellipse((44, 72, 56, 84), fill=white)
    elif name == "settings":
        draw.ellipse((28, 28, 72, 72), outline=white, width=10)
        draw.ellipse((43, 43, 57, 57), fill=white)
        for angle in range(0, 360, 45):
            import math
            x1 = 50 + math.cos(math.radians(angle)) * 25
            y1 = 50 + math.sin(math.radians(angle)) * 25
            x2 = 50 + math.cos(math.radians(angle)) * 37
            y2 = 50 + math.sin(math.radians(angle)) * 37
            draw.line((x1, y1, x2, y2), fill=white, width=8)
    elif name == "refresh":
        draw.arc((22, 22, 78, 78), 35, 310, fill=white, width=8)
        draw.polygon(((65, 18), (83, 24), (72, 40)), fill=white)
    canvas.save(OUT / f"{name}-emoji-100.png", "PNG", optimize=True)


for symbol, coin_id in COINS.items():
    output = OUT / f"{symbol}-emoji-100.png"
    if output.exists():
        print(symbol.upper(), "already downloaded")
        continue
    if symbol in DIRECT_IMAGES:
        fit_logo(fetch_bytes(DIRECT_IMAGES[symbol]), output)
        print(symbol.upper(), DIRECT_IMAGES[symbol])
        continue
    metadata = fetch_json(f"https://api.coingecko.com/api/v3/coins/{coin_id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false")
    fit_logo(fetch_bytes(metadata["image"]["large"]), output)
    print(symbol.upper(), metadata["name"], metadata["image"]["large"])
    time.sleep(3)

for action in ("positions", "orders", "portfolio", "markets", "alerts", "settings", "refresh"):
    action_icon(action)
    print(action)

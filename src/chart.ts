import { deflateSync } from "node:zlib";
import type { Candle } from "./perpl.js";

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(data: Buffer) { let c = 0xffffffff; for (const byte of data) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer) { const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([length, name, data, crc]); }

export function candleChartPng(candles: Candle[], priceDecimals: number, currentPrice?: number, width = 1200, height = 620) {
  const source = candles.filter(c => Number(c.h) > 0 && Number(c.l) > 0), count = Math.min(96, source.length), stride = Math.max(1, Math.ceil(source.length / Math.max(1, count)));
  const sampled = source.filter((_, index) => index % stride === 0).slice(-count), scale = 10 ** priceDecimals;
  const values = sampled.map(c => ({ t: c.t, o: Number(c.o) / scale, h: Number(c.h) / scale, l: Number(c.l) / scale, c: Number(c.c) / scale, v: Number(c.v) || 0 }));
  if (!values.length) throw new Error("No candle data available");
  if (currentPrice && Number.isFinite(currentPrice)) { const latest = values.at(-1)!; latest.c = currentPrice; latest.h = Math.max(latest.h, currentPrice); latest.l = Math.min(latest.l, currentPrice); }
  const min = Math.min(...values.map(c => c.l)), max = Math.max(...values.map(c => c.h)), range = Math.max(max - min, max * 0.001), pad = range * 0.08, lo = min - pad, hi = max + pad;
  const rgba = Buffer.alloc(width * height * 4), set = (x: number, y: number, color: number[]) => { if (x < 0 || y < 0 || x >= width || y >= height) return; const i = (y * width + x) * 4; rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2]; rgba[i + 3] = 255; };
  const fill = (x0: number, y0: number, x1: number, y1: number, color: number[]) => { for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) set(x, y, color); };
  fill(0, 0, width - 1, height - 1, [12, 18, 27]);
  const glyphs: Record<string, string[]> = {
    "0":["01110","10001","10011","10101","11001","10001","01110"], "1":["00100","01100","00100","00100","00100","00100","01110"],
    "2":["01110","10001","00001","00010","00100","01000","11111"], "3":["11110","00001","00001","01110","00001","00001","11110"],
    "4":["00010","00110","01010","10010","11111","00010","00010"], "5":["11111","10000","10000","11110","00001","00001","11110"],
    "6":["01110","10000","10000","11110","10001","10001","01110"], "7":["11111","00001","00010","00100","01000","01000","01000"],
    "8":["01110","10001","10001","01110","10001","10001","01110"], "9":["01110","10001","10001","01111","00001","00001","01110"],
    ".":["00000","00000","00000","00000","00000","00110","00110"], ",":["00000","00000","00000","00000","00110","00110","00100"],
    "-":["00000","00000","00000","11111","00000","00000","00000"],
    "H":["10001","10001","10001","11111","10001","10001","10001"], "L":["10000","10000","10000","10000","10000","10000","11111"],
    "O":["01110","10001","10001","10001","10001","10001","01110"], "C":["01111","10000","10000","10000","10000","10000","01111"],
    "V":["10001","10001","10001","10001","10001","01010","00100"], ":":["00000","00110","00110","00000","00110","00110","00000"],
    "/":["00001","00010","00010","00100","01000","01000","10000"],
  };
  const text = (x: number, y: number, value: string, color = [167, 178, 191], zoom = 2) => { let cursor = x; for (const char of value) { const glyph = glyphs[char]; if (!glyph) { cursor += 6 * zoom; continue; } glyph.forEach((row, gy) => [...row].forEach((pixel, gx) => { if (pixel === "1") fill(cursor + gx * zoom, y + gy * zoom, cursor + (gx + 1) * zoom - 1, y + (gy + 1) * zoom - 1, color); })); cursor += 6 * zoom; } };
  const chartLeft = 30, chartRight = width - 178, plotTop = 48, plotBottom = height - 145, volumeTop = height - 116, volumeBottom = height - 42;
  const yOf = (price: number) => Math.round(plotTop + (hi - price) / (hi - lo) * (plotBottom - plotTop)), slot = (chartRight - chartLeft) / Math.max(1, values.length), bodyWidth = Math.max(3, Math.floor(slot * 0.62));
  const last = values.at(-1)?.c, lastY = last ? yOf(last) : -100;
  for (let row = 0; row <= 5; row++) { const y = plotTop + Math.round(row * (plotBottom - plotTop) / 5), price = hi - row * (hi - lo) / 5; fill(chartLeft, y, chartRight, y, [27, 34, 44]); if (Math.abs(y - lastY) > 20) text(chartRight + 14, y - 7, price.toLocaleString("en-US", { maximumFractionDigits: priceDecimals })); }
  const xOf = (index: number) => Math.round(chartLeft + slot * (index + 0.5));
  const span = values.at(-1)!.t - values[0].t, timeLabel = (timestamp: number) => { const date = new Date(timestamp); return span <= 2 * 86_400_000 ? `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}` : `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`; };
  for (let column = 0; column <= 4; column++) { const index = Math.min(values.length - 1, Math.round(column * (values.length - 1) / 4)), x = xOf(index); fill(x, plotTop, x, volumeBottom, [22, 29, 38]); const label = timeLabel(values[index].t); text(Math.max(chartLeft, x - label.length * 6), height - 27, label, [125, 138, 153]); }
  values.forEach((c, index) => { const x = xOf(index), color = c.c >= c.o ? [42, 201, 122] : [239, 83, 80], top = yOf(Math.max(c.o, c.c)), bottom = yOf(Math.min(c.o, c.c)); fill(x, yOf(c.h), x, yOf(c.l), color); fill(x - Math.floor(bodyWidth / 2), top, x + Math.floor(bodyWidth / 2), Math.max(top + 2, bottom), color); });
  const maxVolume = Math.max(...values.map(c => c.v), 1); fill(chartLeft, volumeTop - 10, chartRight, volumeTop - 10, [27, 34, 44]); text(chartLeft, volumeTop - 31, "V", [145, 157, 171]);
  values.forEach((c, index) => { const x = xOf(index), barHeight = Math.max(1, Math.round(c.v / maxVolume * (volumeBottom - volumeTop))), color = c.c >= c.o ? [35, 112, 79] : [132, 55, 61]; fill(x - Math.floor(bodyWidth / 2), volumeBottom - barHeight, x + Math.floor(bodyWidth / 2), volumeBottom, color); });
  const latest = values.at(-1)!; text(chartLeft, 15, `O ${latest.o.toLocaleString("en-US", { maximumFractionDigits: priceDecimals })}  H ${latest.h.toLocaleString("en-US", { maximumFractionDigits: priceDecimals })}  L ${latest.l.toLocaleString("en-US", { maximumFractionDigits: priceDecimals })}  C ${latest.c.toLocaleString("en-US", { maximumFractionDigits: priceDecimals })}`, latest.c >= latest.o ? [76, 212, 145] : [246, 100, 105]);
  const highIndex = values.findIndex(c => c.h === max), lowIndex = values.findIndex(c => c.l === min);
  const marker = (index: number, price: number, prefix: "H" | "L") => { const x = xOf(index), y = yOf(price), label = `${prefix} ${price.toLocaleString("en-US", { maximumFractionDigits: priceDecimals })}`, labelWidth = label.length * 12, right = x + 12 + labelWidth < chartRight, tx = right ? x + 12 : Math.max(chartLeft, x - labelWidth - 12); fill(right ? x : x - 28, y, right ? x + 28 : x, y, [190, 198, 209]); text(tx, Math.max(plotTop, Math.min(plotBottom - 16, y - 17)), label, [210, 217, 226]); };
  if (highIndex >= 0) marker(highIndex, max, "H");
  if (lowIndex >= 0) marker(lowIndex, min, "L");
  if (last) { const y = yOf(last), label = last.toLocaleString("en-US", { maximumFractionDigits: priceDecimals }); for (let x = chartLeft; x < chartRight; x += 8) fill(x, y, x + 3, y, [125, 116, 245]); fill(chartRight + 6, y - 11, width - 8, y + 11, [105, 95, 220]); text(chartRight + 14, y - 7, label, [255, 255, 255]); }
  const raw = Buffer.alloc((width * 4 + 1) * height); for (let y = 0; y < height; y++) { const offset = y * (width * 4 + 1); raw[offset] = 0; rgba.copy(raw, offset + 1, y * width * 4, (y + 1) * width * 4); }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

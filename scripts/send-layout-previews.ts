import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Bot } from "grammy";
import { UserStore } from "../src/personal.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");
const users = await new UserStore().all();
if (users.length !== 1) throw new Error(`Expected one connected account, found ${users.length}`);
let btc = "🟠";
try {
  const branding = JSON.parse(readFileSync(path.resolve("data/branding.json"), "utf8"));
  const id = branding?.marketEmojiIds?.BTC;
  if (id) btc = `<tg-emoji emoji-id="${id}">🟠</tg-emoji>`;
} catch {}
const common = `💵 Entry: $83,420\n🎯 TP: $85,000\n🛡 SL: $82,500\nFunding: +&lt; $0.01 | Fee: &lt; $0.01`;
const bot = new Bot(token), chatId = users[0].row.chatId;
await bot.api.sendMessage(chatId, `<b>Option 1</b>\n\n<b>Position opened · Market ✅</b>\n\n${btc} <b>BTC 15X</b> 🟢 LONG · <b>$12.50</b>\n${common}`, { parse_mode: "HTML" });
await bot.api.sendMessage(chatId, `<b>Option 2</b>\n\n<b>Position opened ✅</b>\n\nMarket · ${btc} <b>BTC 15X</b> 🟢 LONG · <b>$12.50</b>\n${common}`, { parse_mode: "HTML" });
await bot.api.sendMessage(chatId, `<b>Option 3</b>\n\n<b>Market position opened ✅</b>\n\n${btc} <b>BTC 15X</b> 🟢 LONG · <b>$12.50</b>\n${common}`, { parse_mode: "HTML" });
console.log("Sent three layout previews");

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
const bot = new Bot(token), chatId = users[0].row.chatId;
const examples = [
  `<b>✅ [MARKET] Position opened</b>\n\n🟢 LONG ${btc} BTC $12.50 15x\n🔹 Entry: $83,420\n🎯 TP: $85,000\n🛡 SL: $82,500\nFee: &lt; $0.01`,
  `<b>✅ [LIMIT] Position opened</b>\n\n🔴 SHORT ${btc} BTC $12.50 15x\n🔹 Entry: $84,000\n🎯 TP: $82,500\n🛡 SL: $85,000\nFee: &lt; $0.01`,
  `<b>❌ [MARKET] Position closed</b>\n\n🟢 LONG ${btc} BTC $12.74 15x\n🔹 Entry: $83,420\n🔹 Exit: $85,020\n📈 PnL: +$0.24\nFunding: +&lt; $0.01  Fee: &lt; $0.01`,
  `<b>❌ [LIMIT] Position closed</b>\n\n🔴 SHORT ${btc} BTC $12.61 15x\n🔹 Entry: $84,000\n🔹 Exit: $83,200\n📈 PnL: +$0.12\nFunding: -&lt; $0.01  Fee: &lt; $0.01`,
  `<b>❌ [TP] Position closed 🎯</b>\n\n🟢 LONG ${btc} BTC $12.74 15x\n🔹 Entry: $83,420\n🔹 Exit: $85,000\n📈 PnL: +$0.24\nFunding: +&lt; $0.01  Fee: &lt; $0.01`,
  `<b>❌ [SL] Position closed 🛡</b>\n\n🟢 LONG ${btc} BTC $12.36 15x\n🔹 Entry: $83,420\n🔹 Exit: $82,400\n📉 PnL: -&lt; $0.01\nFunding: -&lt; $0.01  Fee: &lt; $0.01`,
];
await bot.api.sendMessage(chatId, "<b>Notification examples</b>", { parse_mode: "HTML" });
for (const text of examples) await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
console.log(`Sent ${examples.length} notification examples`);

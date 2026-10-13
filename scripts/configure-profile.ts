import "dotenv/config";
import path from "node:path";
import { Bot, InputFile } from "grammy";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");

const bot = new Bot(token);
await bot.api.setMyName("TradePerpl");
await bot.api.setMyShortDescription("💜 Trade Perpl directly in Telegram.");
await bot.api.setMyDescription([
  "📱 Perpl markets in your pocket.",
  "⚡ Trade with live prices, order books and fast execution.",
  "🔔 Manage positions and alerts wherever you are.",
].join("\n"));
await bot.api.setMyProfilePhoto({
  type: "static",
  photo: new InputFile(path.resolve("assets/tradeperpl-avatar.jpg")),
});
console.log("TradePerpl profile configured");

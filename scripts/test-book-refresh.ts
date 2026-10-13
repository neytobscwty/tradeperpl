import "dotenv/config";
import { Bot } from "grammy";
import { PerplClient } from "../src/perpl.js";
import { UserStore } from "../src/personal.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");
const users = await new UserStore().all();
if (users.length !== 1) throw new Error(`Expected one connected account, found ${users.length}`);
const bot = new Bot(token), chatId = users[0].row.chatId;
const perpl = new PerplClient((process.env.PERPL_API_URL || "https://app.perpl.xyz/api").replace(/\/$/, ""));
const market = await perpl.market("BTC");
const total = Math.max(1, Math.min(300, Number(process.argv[2] ?? 20)));
const intervalMs = Math.max(1_000, Math.min(10_000, Number(process.argv[3] ?? 1_000)));
const message = await bot.api.sendMessage(chatId, "⏱ Testing 1-second order book refresh…");
const samples: number[] = [];
let failures = 0;
const errors: Array<{ update: number; message: string; retryAfter?: number }> = [];
for (let i = 1; i <= total; i++) {
  const started = Date.now();
  try {
    await Promise.all([perpl.ticker(market), perpl.book(market, 100)]);
    const latency = Date.now() - started;
    samples.push(latency);
    await bot.api.editMessageText(chatId, message.message_id, `⏱ Order book refresh test ${i}/${total}\nAPI ${latency} ms`);
  } catch (error: any) { failures++; errors.push({ update: i, message: String(error?.message ?? error), retryAfter: error?.parameters?.retry_after }); }
  const remaining = intervalMs - (Date.now() - started);
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
}
const average = samples.length ? Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length) : 0;
const maximum = samples.length ? Math.max(...samples) : 0;
await bot.api.editMessageText(chatId, message.message_id, `${failures ? "⚠️" : "✅"} 1-second refresh test\n${samples.length}/${total} updates\nAverage API ${average} ms\nMaximum API ${maximum} ms`);
console.log(JSON.stringify({ updates: samples.length, failures, average, maximum, intervalMs, errors }));

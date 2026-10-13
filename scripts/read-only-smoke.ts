import "dotenv/config";
import { PerplAccountClient, UserStore } from "../src/personal.js";
import { PerplClient } from "../src/perpl.js";

const user = (await new UserStore().all())[0];
if (!user) throw new Error("No connected account");
const base = process.env.PERPL_API_URL || "https://app.perpl.xyz/api";
const publicClient = new PerplClient(base), accountClient = new PerplAccountClient(base, user.credentials);
const markets = await publicClient.markets(), btc = await publicClient.market("BTC");
const checks: Record<string, unknown> = {};
for (const [name, task] of Object.entries({
  context: Promise.resolve(markets), ticker: publicClient.ticker(btc), tickers: publicClient.tickers(),
  book: publicClient.book(btc, 5), candles: publicClient.candles(btc), wallet: accountClient.wallet(),
  positions: accountClient.positions(), openOrders: accountClient.orders(), orderHistory: accountClient.orderHistory(5), positionHistory: accountClient.history(5),
})) {
  const started = performance.now();
  const value: any = await task;
  checks[name] = { ok: true, ms: Math.round(performance.now() - started), count: Array.isArray(value) ? value.length : Array.isArray(value?.d) ? value.d.length : undefined };
}
console.log(JSON.stringify({ ok: true, checks }));

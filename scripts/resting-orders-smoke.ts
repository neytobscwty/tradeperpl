import "dotenv/config";
import { performance } from "node:perf_hooks";
import { PerplAccountClient, UserStore } from "../src/personal.js";
import { PerplClient, scaled } from "../src/perpl.js";
import { PerplTradingStream } from "../src/live.js";
import { cancelOrder, openOrder } from "../src/orders.js";

const user = (await new UserStore().all())[0]; if (!user) throw new Error("No connected account");
const base = process.env.PERPL_API_URL || "https://app.perpl.xyz/api", accountClient = new PerplAccountClient(base, user.credentials), publicClient = new PerplClient(base);
const [wallet, market] = await Promise.all([accountClient.wallet(), publicClient.market("PUMP")]);
const account = wallet.as?.find(item => !item.fr && item.fw); if (!account) throw new Error("No forwarding account");
const ticker = await publicClient.ticker(market), bid = scaled(ticker.bid, market.config.price_decimals), price = Math.floor(bid * .99 * 10 ** market.config.price_decimals);
const stream = new PerplTradingStream(process.env.PERPL_WS_URL || "wss://app.perpl.xyz", user.credentials); stream.start();
let rq = Math.max(Date.now(), Number(account.lfr ?? 0) + 1); const timings: Record<string, number> = {}, active = new Set<number>();
const submit = async (name: string, order: any) => { const start = performance.now(); const result = await stream.submit(order); timings[name] = Math.round(performance.now() - start); return result; };
try {
  for (const type of ["limit", "post"] as const) {
    const placed = await submit(`${type}PlaceMs`, openOrder({ rq: rq++, market: market.id, account: account.id, side: "long", size: 800, leverage: 2, type, price }));
    if (!placed.oid || placed.st !== 2) throw new Error(`${type} did not rest on book`); active.add(placed.oid);
    const canceled = await submit(`${type}CancelMs`, cancelOrder(rq++, account.id, { oid: placed.oid, mkt: market.id, os: 800 }));
    if (canceled.st !== 5) throw new Error(`${type} cancel status ${canceled.st}`); active.delete(placed.oid);
  }
  console.log(JSON.stringify({ ok: true, timings }));
} finally {
  for (const oid of active) try { await stream.submit(cancelOrder(rq++, account.id, { oid, mkt: market.id, os: 800 })); } catch {}
  stream.stop();
}

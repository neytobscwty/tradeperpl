import "dotenv/config";
import { performance } from "node:perf_hooks";
import { amount, PerplAccountClient, UserStore, type OrderSpec } from "../src/personal.js";
import { PerplClient, scaled } from "../src/perpl.js";
import { PerplTradingStream } from "../src/live.js";
import { cancelOrder, openOrder } from "../src/orders.js";

const base = process.env.PERPL_API_URL || "https://app.perpl.xyz/api";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const users = new UserStore(), user = (await users.all())[0];
if (!user) throw new Error("No connected Perpl API account");
const accountClient = new PerplAccountClient(base, user.credentials), publicClient = new PerplClient(base);
const [wallet, market] = await Promise.all([accountClient.wallet(), publicClient.market("PUMP")]);
const account = wallet.as?.find(a => !a.fr && a.fw);
if (!account) throw new Error("No active account with order forwarding enabled");
const marginUsd = 2.5, leverage = 2, notionalUsd = marginUsd * leverage;
if (amount(account.b) - amount(account.lb) < marginUsd + .25) throw new Error(`At least $${marginUsd + .25} available margin is required for the smoke test`);
const stream = new PerplTradingStream(process.env.PERPL_WS_URL || "wss://app.perpl.xyz", user.credentials); stream.start();
let rq = Math.max(Date.now(), Number(account.lfr ?? 0) + 1);
const timings: Record<string, number> = {};
const submit = async (name: string, order: OrderSpec) => { const start = performance.now(); console.log(JSON.stringify({ stage: name, size: order.s, type: order.t })); try { const result = await stream.submit(order); timings[name] = Math.round(performance.now() - start); return result; } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : error}`); } };
async function waitFor<T>(name: string, read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 15_000) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    const value = await read();
    if (predicate(value)) { timings[name] = Math.round(performance.now() - started); return value; }
    await sleep(200);
  }
  throw new Error(`${name} timed out after ${timeout}ms`);
}
const quote = await publicClient.ticker(market), mark = scaled(quote.mrk || quote.mid, market.config.price_decimals), bid = scaled(quote.bid, market.config.price_decimals);
const size = 800;
let positionId: number | undefined;
const restingOrderIds = new Set<number>();
try {
  for (const percent of [25, 50, 75, 100]) {
    const opened = await submit(`marketOpen${percent}Ms`, openOrder({ rq: rq++, market: market.id, account: account.id, side: "long", size, leverage, type: "market" }));
    if (![4, 10].includes(opened.st)) throw new Error(`Market open status ${opened.st}`);
    let positions = await waitFor(`marketObserved${percent}Ms`, () => accountClient.positions(), ps => ps.some(p => p.mkt === market.id && p.st === 1 && p.sd === 1));
    let position = positions.find(p => p.mkt === market.id && p.st === 1 && p.sd === 1);
    if (!position) throw new Error("Opened position not found");
    positionId = position.pid;
    const originalSize = position.s;
    const closeSize = percent === 100 ? originalSize : Math.max(1, Math.floor(originalSize * percent / 100));
    await submit(`close${percent}Ms`, { rq: rq++, mkt: market.id, acc: account.id, t: 3, p: 0, s: closeSize, ms: 100, fl: 4, lv: position.lv, lp: position.pid, lb: 0 });
    positions = await waitFor(`closeObserved${percent}Ms`, () => accountClient.positions(), ps => {
      const p = ps.find(item => item.pid === positionId && item.st === 1);
      return percent === 100 ? !p : Boolean(p && p.s === originalSize - closeSize);
    });
    position = positions.find(p => p.pid === positionId && p.st === 1);
    if (position) {
      await submit(`remainderClose${percent}Ms`, { rq: rq++, mkt: market.id, acc: account.id, t: 3, p: 0, s: position.s, ms: 100, fl: 4, lv: position.lv, lp: position.pid, lb: 0 });
      await waitFor(`remainderObserved${percent}Ms`, () => accountClient.positions(), ps => !ps.some(p => p.pid === positionId && p.st === 1));
    }
    positionId = undefined;
  }

  const limitPrice = Math.floor(bid * .995 * 10 ** market.config.price_decimals);
  const limit = await submit("limitPlaceMs", { rq: rq++, mkt: market.id, acc: account.id, t: 1, p: limitPrice, s: size, fl: 0, lv: leverage * 100, lb: 0 });
  if (!limit.oid) throw new Error("Limit order was not assigned an order id");
  restingOrderIds.add(limit.oid);
  await submit("limitCancelMs", cancelOrder(rq++, account.id, { oid: limit.oid, mkt: market.id, os: size }));
  restingOrderIds.delete(limit.oid);
  const post = await submit("postOnlyPlaceMs", { rq: rq++, mkt: market.id, acc: account.id, t: 1, p: limitPrice, s: size, fl: 1, lv: leverage * 100, lb: 0 });
  if (!post.oid) throw new Error("Post-only order was not assigned an order id");
  restingOrderIds.add(post.oid);
  await submit("postOnlyCancelMs", cancelOrder(rq++, account.id, { oid: post.oid, mkt: market.id, os: size }));
  restingOrderIds.delete(post.oid);
  console.log(JSON.stringify({ ok: true, market: "PUMP", marginUsd, leverage, notionalUsd, timings }));
} finally {
  for (const oid of restingOrderIds) {
    try { await submit("cleanupCancelMs", cancelOrder(rq++, account.id, { oid, mkt: market.id, os: size })); } catch {}
  }
  if (positionId != null) {
    try {
      const p = (await accountClient.positions()).find(item => item.pid === positionId && item.st === 1);
      if (p) await submit("cleanupCloseMs", { rq: rq++, mkt: p.mkt, acc: account.id, t: p.sd === 1 ? 3 : 4, p: 0, s: p.s, ms: 100, fl: 4, lv: p.lv, lp: p.pid, lb: 0 });
    } catch {}
  }
  stream.stop();
}

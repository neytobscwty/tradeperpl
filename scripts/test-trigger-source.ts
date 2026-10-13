import "dotenv/config";
import { PerplTradingStream } from "../src/live.js";
import { cancelOrder, closeOrder, openOrder, triggerCloseOrder } from "../src/orders.js";
import { amount, PerplAccountClient, UserStore, type Order, type Position } from "../src/personal.js";
import { marketSymbol, PerplClient, scaled } from "../src/perpl.js";

const base = (process.env.PERPL_API_URL || "https://app.perpl.xyz/api").replace(/\/$/, "");
const users = await new UserStore().all();
if (users.length !== 1) throw new Error(`Expected one connected account, found ${users.length}`);
const saved = users[0];
const personal = new PerplAccountClient(base, saved.credentials);
const publicClient = new PerplClient(base);
const stream = new PerplTradingStream(process.env.PERPL_WS_URL || "wss://app.perpl.xyz", saved.credentials);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
stream.start();

const market = await publicClient.market("BTC");
const account = (await personal.wallet()).as?.find(item => !item.fr && item.fw);
if (!account) throw new Error("No active account with order forwarding enabled");
if (amount(account.b) - amount(account.lb) < 2) throw new Error("At least $2 available margin is required");
let request = Math.max(Date.now(), Number(account.lfr ?? 0) + 1);
const nextRequest = () => request++;
const scale = 10 ** market.config.price_decimals;
const originalPositions = new Set((await personal.positions()).map(position => position.pid));
const createdOrders = new Set<number>();
let position: Position | undefined;

async function quote() {
  const [book, ticker] = await Promise.all([publicClient.book(market, 2), publicClient.ticker(market)]);
  const bid = scaled(book.bid[0]?.p, market.config.price_decimals);
  const ask = scaled(book.ask[0]?.p, market.config.price_decimals);
  return {
    bid,
    ask,
    mid: (bid + ask) / 2,
    mark: scaled(ticker.mrk, market.config.price_decimals),
    oracle: scaled(ticker.orl, market.config.price_decimals),
  };
}

async function findPosition() {
  for (let i = 0; i < 20; i++) {
    const found = (await personal.positions()).find(item => item.mkt === market.id && item.st === 1 && !originalPositions.has(item.pid));
    if (found) return found;
    await wait(500);
  }
  throw new Error("Opened position did not appear");
}

async function activeTrigger(rq: number) {
  for (let i = 0; i < 10; i++) {
    const found = (await personal.orders()).find(item => item.rq === rq && [1, 2, 3, 8, 9].includes(item.st));
    if (found) return found;
    await wait(300);
  }
}

try {
  const before = await quote();
  console.log("BEFORE", JSON.stringify(before));
  const openResult = await stream.submit(openOrder({ rq: nextRequest(), market: market.id, account: account.id, side: "long", size: 1, leverage: 1, type: "market" }));
  console.log(`OPEN ${marketSymbol(market)} status=${openResult.st}`);
  position = await findPosition();
  const entry = scaled(position.ep, market.config.price_decimals);
  const q = await quote();

  // Put one trigger between the live book and Mark whenever the gap is large enough.
  // The second trigger protects the other side and proves that TP and SL coexist.
  const gap = q.mark - q.mid;
  const tick = 1 / scale;
  let nearKind: "tp" | "sl";
  let nearPrice: number;
  if (gap > Math.max(q.ask - q.bid, tick * 4) && q.mark > entry + tick) {
    nearKind = "tp";
    nearPrice = Math.max(entry + tick, (q.ask + q.mark) / 2);
  } else if (gap < -Math.max(q.ask - q.bid, tick * 4) && q.mark < entry - tick) {
    nearKind = "sl";
    nearPrice = Math.min(entry - tick, (q.bid + q.mark) / 2);
  } else {
    nearKind = "tp";
    nearPrice = Math.max(entry + tick, q.ask + Math.max(tick, q.ask * 0.0001));
  }
  nearPrice = Math.round(nearPrice * scale) / scale;
  const farKind: "tp" | "sl" = nearKind === "tp" ? "sl" : "tp";
  const farPrice = farKind === "sl" ? entry * 0.99 : entry * 1.01;
  const nearRq = nextRequest(), farRq = nextRequest();
  console.log("SETUP", JSON.stringify({ entry, nearKind, nearPrice, farKind, farPrice, ...q }));
  for (const [rq, kind, price] of [[nearRq, nearKind, nearPrice], [farRq, farKind, farPrice]] as const) {
    const result = await stream.submit(triggerCloseOrder({ rq, market: market.id, account: account.id, side: "long", size: position.s, leverage: 1, triggerPrice: Math.round(price * scale), kind, linkedPosition: position.pid }));
    console.log(`${kind.toUpperCase()} price=${price} status=${result.st}`);
    const order = await activeTrigger(rq);
    if (order) createdOrders.add(order.oid);
  }

  let closed = false;
  for (let second = 0; second < 90; second++) {
    const sample = await quote();
    const stillOpen = (await personal.positions()).some(item => item.pid === position!.pid && item.st === 1);
    console.log("SAMPLE", JSON.stringify({ second, ...sample, stillOpen }));
    if (!stillOpen) { closed = true; break; }
    await wait(1_000);
  }
  console.log(`TRIGGERED=${closed}`);
  await wait(1_000);
  const history = await personal.history(20);
  const event = history.find(item => item.pid === position!.pid);
  console.log("HISTORY", JSON.stringify(event ?? null));
} finally {
  for (const order of await personal.orders().catch(() => [] as Order[])) {
    if (createdOrders.has(order.oid) && [1, 2, 3, 8, 9].includes(order.st)) {
      try {
        console.log(`CLEANUP CANCEL ${order.oid} status=${(await stream.submit(cancelOrder(nextRequest(), account.id, order))).st}`);
      } catch (error) {
        console.log(`CLEANUP CANCEL ${order.oid} already settled: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
  if (position && (await personal.positions().catch(() => [] as Position[])).some(item => item.pid === position!.pid && item.st === 1)) {
    console.log(`CLEANUP CLOSE ${position.pid} status=${(await stream.submit(closeOrder(nextRequest(), account.id, position, 100))).st}`);
  }
  await wait(1_000);
  stream.stop();
}

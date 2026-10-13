import "dotenv/config";
import { PerplTradingStream } from "../src/live.js";
import { cancelOrder, closeOrder, openOrder, triggerCloseOrder } from "../src/orders.js";
import { amount, PerplAccountClient, UserStore, type Order, type Position } from "../src/personal.js";
import { marketSymbol, PerplClient, scaled } from "../src/perpl.js";

const base = (process.env.PERPL_API_URL || "https://app.perpl.xyz/api").replace(/\/$/, "");
const users = new UserStore();
const savedUsers = await users.all();
if (savedUsers.length !== 1) throw new Error(`Expected exactly one connected test account, found ${savedUsers.length}`);
const saved = savedUsers[0];
const client = new PerplAccountClient(base, saved.credentials);
const publicClient = new PerplClient(base);
const stream = new PerplTradingStream(process.env.PERPL_WS_URL || "wss://app.perpl.xyz", saved.credentials);
stream.start();

const market = await publicClient.market("BTC");
const account = (await client.wallet()).as?.find(item => !item.fr && item.fw);
if (!account) throw new Error("No active account with order forwarding enabled");
if (amount(account.b) - amount(account.lb) < 3) throw new Error("At least $3 available margin is required for the smoke test");
let request = Math.max(Date.now(), Number(account.lfr ?? 0) + 1);
const nextRequest = () => request++;
const createdOrders = new Set<number>();
const createdPositions = new Set<number>();
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const priceScale = 10 ** market.config.price_decimals;
const symbol = marketSymbol(market);

async function currentPosition(excluded: Set<number>) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const found = (await client.positions()).find(position => position.mkt === market.id && position.st === 1 && !excluded.has(position.pid));
    if (found) return found;
    await wait(500);
  }
  throw new Error("Opened position did not appear in the positions API");
}

async function closePosition(position: Position) {
  const outcome = await stream.submit(closeOrder(nextRequest(), account.id, position, 100));
  console.log(`CLOSE ${symbol}: status ${outcome.st}`);
  createdPositions.delete(position.pid);
  await wait(1_000);
}

async function cancelPlaced(order: Order) {
  const outcome = await stream.submit(cancelOrder(nextRequest(), account.id, order));
  console.log(`CANCEL ${symbol}: status ${outcome.st}`);
  createdOrders.delete(order.oid);
}

try {
  const originalPositions = new Set((await client.positions()).map(position => position.pid));

  console.log("TEST 1: market open and close");
  const marketRequest = nextRequest();
  console.log(`MARKET OPEN: status ${(await stream.submit(openOrder({ rq: marketRequest, market: market.id, account: account.id, side: "long", size: 1, leverage: 1, type: "market" }))).st}`);
  const marketPosition = await currentPosition(originalPositions);
  createdPositions.add(marketPosition.pid);
  await closePosition(marketPosition);

  console.log("TEST 2: post-only place and cancel");
  const state = await publicClient.ticker(market);
  const bid = scaled(state.bid, market.config.price_decimals);
  const postRequest = nextRequest();
  const postPrice = Math.floor(bid * 0.95 * priceScale);
  console.log(`POST-ONLY: status ${(await stream.submit(openOrder({ rq: postRequest, market: market.id, account: account.id, side: "long", size: 1, leverage: 1, type: "limit", postOnly: true, price: postPrice }))).st}`);
  await wait(500);
  const posted = (await client.orders()).find(order => order.rq === postRequest);
  if (!posted) throw new Error("Post-only order did not appear in the orders API");
  createdOrders.add(posted.oid);
  await cancelPlaced(posted);

  console.log("TEST 3: executable limit long and close");
  const beforeLimit = new Set((await client.positions()).map(position => position.pid));
  const freshState = await publicClient.ticker(market);
  const ask = scaled(freshState.ask, market.config.price_decimals);
  const limitRequest = nextRequest();
  console.log(`LIMIT OPEN: status ${(await stream.submit(openOrder({ rq: limitRequest, market: market.id, account: account.id, side: "long", size: 1, leverage: 1, type: "limit", price: Math.ceil(ask * 1.001 * priceScale) }))).st}`);
  const limitPosition = await currentPosition(beforeLimit);
  createdPositions.add(limitPosition.pid);
  await closePosition(limitPosition);

  console.log("TEST 4: executable limit short and close");
  const beforeShort = new Set((await client.positions()).map(position => position.pid));
  const shortState = await publicClient.ticker(market);
  const shortBid = scaled(shortState.bid, market.config.price_decimals);
  const shortRequest = nextRequest();
  console.log(`LIMIT SHORT: status ${(await stream.submit(openOrder({ rq: shortRequest, market: market.id, account: account.id, side: "short", size: 1, leverage: 1, type: "limit", price: Math.floor(shortBid * 0.999 * priceScale) }))).st}`);
  const shortPosition = await currentPosition(beforeShort);
  createdPositions.add(shortPosition.pid);
  await closePosition(shortPosition);

  console.log("TEST 5: TP and SL creation, cancellation, position close");
  const beforeProtected = new Set((await client.positions()).map(position => position.pid));
  const protectedRequest = nextRequest();
  console.log(`PROTECTED OPEN: status ${(await stream.submit(openOrder({ rq: protectedRequest, market: market.id, account: account.id, side: "long", size: 1, leverage: 1, type: "market" }))).st}`);
  const protectedPosition = await currentPosition(beforeProtected);
  createdPositions.add(protectedPosition.pid);
  const entry = scaled(protectedPosition.ep, market.config.price_decimals);
  const tpRequest = nextRequest(), slRequest = nextRequest();
  const tp = triggerCloseOrder({ rq: tpRequest, market: market.id, account: account.id, side: "long", size: protectedPosition.s, leverage: 1, triggerPrice: Math.round(entry * 1.02 * priceScale), kind: "tp", linkedPosition: protectedPosition.pid });
  const sl = triggerCloseOrder({ rq: slRequest, market: market.id, account: account.id, side: "long", size: protectedPosition.s, leverage: 1, triggerPrice: Math.round(entry * 0.98 * priceScale), kind: "sl", linkedPosition: protectedPosition.pid });
  console.log(`TP: status ${(await stream.submit(tp)).st}`);
  console.log(`SL: status ${(await stream.submit(sl)).st}`);
  await wait(500);
  for (const order of (await client.orders()).filter(item => item.rq === tpRequest || item.rq === slRequest)) {
    createdOrders.add(order.oid);
    await cancelPlaced(order);
  }
  await closePosition(protectedPosition);
  console.log("SMOKE TEST COMPLETE");
} finally {
  for (const order of await client.orders().catch(() => [] as Order[])) {
    if (createdOrders.has(order.oid)) await cancelPlaced(order).catch(error => console.error("Cleanup order failed", error));
  }
  for (const position of await client.positions().catch(() => [] as Position[])) {
    if (createdPositions.has(position.pid)) await closePosition(position).catch(error => console.error("Cleanup position failed", error));
  }
  stream.stop();
}

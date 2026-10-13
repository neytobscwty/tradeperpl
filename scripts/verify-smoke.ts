import "dotenv/config";
import { AlertStore } from "../src/alerts.js";
import { PerplAccountClient, UserStore } from "../src/personal.js";
import { PerplClient, scaled } from "../src/perpl.js";

const base = (process.env.PERPL_API_URL || "https://app.perpl.xyz/api").replace(/\/$/, "");
const users = await new UserStore().all();
if (users.length !== 1) throw new Error(`Expected one connected account, found ${users.length}`);
const user = users[0];
const client = new PerplAccountClient(base, user.credentials);
const positions = (await client.positions()).filter(position => position.st === 1);
const orders = (await client.orders()).filter(order => [1, 2, 3, 8, 9].includes(order.st));
const btc = await new PerplClient(base).market("BTC");
console.log(`BTC MARGIN CONFIG: ${JSON.stringify({ initial: btc.config.initial_margin, maintenance: btc.config.maintenance_margin })}`);
console.log(`OPEN POSITIONS: ${positions.length}`);
if (positions.length) console.log(`POSITION DETAILS: ${JSON.stringify(positions.map(({ pid, rq, oid, mkt, st, sd, c, ep, s, lv }) => ({ pid, rq, oid, mkt, st, sd, c, ep, s, lv })))}`);
console.log(`ACTIVE ORDERS: ${orders.length}`);
if (orders.length) console.log(`ORDER DETAILS: ${JSON.stringify(orders.map(order => ({ oid: order.oid, scid: (order as any).scid, rq: order.rq, mkt: order.mkt, acc: order.acc, st: order.st, sr: order.sr, t: order.t, os: order.os, tp: order.tp, tpc: order.tpc, lp: order.lp, tr: order.tr })))}`);

if (process.argv.includes("--alert")) {
  const publicClient = new PerplClient(base), market = await publicClient.market("BTC"), ticker = await publicClient.ticker(market);
  const mark = scaled(ticker.mrk || ticker.mid || ticker.lst, market.config.price_decimals);
  const alert = await new AlertStore().add(user.row.chatId, "BTC", "above", Math.max(0, mark - 1));
  console.log(`ALERT CREATED: ${alert.id}`);
}

import "dotenv/config";
import { amount, PerplAccountClient, UserStore } from "../src/personal.js";
import { PerplClient, scaled } from "../src/perpl.js";

const user = (await new UserStore().all())[0];
if (!user) throw new Error("No connected account");
const base = process.env.PERPL_API_URL || "https://app.perpl.xyz/api";
const accountClient = new PerplAccountClient(base, user.credentials);
const publicClient = new PerplClient(base);
const [wallet, market, positions, orders, orderHistory] = await Promise.all([accountClient.wallet(), publicClient.market("BTC"), accountClient.positions(), accountClient.orders(), accountClient.orderHistory(12)]);
const ticker = await publicClient.ticker(market);
const account = wallet.as?.find(item => !item.fr && item.fw);
if (!account) throw new Error("No active forwarding account");
console.log(JSON.stringify({
  wallet: `${wallet.addr.slice(0, 8)}…${wallet.addr.slice(-6)}`,
  account: account.id,
  availableUsd: amount(account.b) - amount(account.lb),
  mark: scaled(ticker.mrk || ticker.mid, market.config.price_decimals),
  sizeDecimals: market.config.size_decimals,
  minPostingUsd: amount(market.config.min_posting_amount),
  minSettleUsd: amount(market.config.min_settle_amount),
  marketOpen: market.config.is_open,
  marginConfig: { maintenance: market.config.maintenance_margin, initial: market.config.initial_margin },
  openPositions: positions.filter(position => position.st === 1).map(position => ({ market: position.mkt, side: position.sd, size: position.s, leverage: position.lv / 100 })),
  openOrders: orders.filter(order => [1, 2, 3, 8, 9].includes(order.st)).map(order => ({ id: order.oid, request: order.rq, market: order.mkt, type: order.t, price: order.p, size: order.os, status: order.st, reason: order.sr, flags: order.fl, filledPrice: order.fp, filledSize: order.fs })),
  recentOrders: orderHistory.slice(0, 12).map(order => ({ id: order.oid, request: order.rq, market: order.mkt, type: order.t, price: order.p, size: order.os, status: order.st, reason: order.sr, flags: order.fl, triggerPrice: order.tp, triggerCondition: order.tpc, triggerRequest: order.tr, linkedPosition: order.lp, filledPrice: order.fp, filledSize: order.fs, tx: order.at?.txid })),
}));

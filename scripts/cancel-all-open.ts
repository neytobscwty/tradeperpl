import "dotenv/config";
import { PerplAccountClient, UserStore } from "../src/personal.js";
import { cancelOrder } from "../src/orders.js";
import { PerplTradingStream } from "../src/live.js";

const user = (await new UserStore().all())[0]; if (!user) throw new Error("No connected account");
const base = process.env.PERPL_API_URL || "https://app.perpl.xyz/api", client = new PerplAccountClient(base, user.credentials);
const [wallet, orders] = await Promise.all([client.wallet(), client.orders()]);
const active = orders.filter(order => [1, 2, 3, 8, 9].includes(order.st));
const stream = new PerplTradingStream(process.env.PERPL_WS_URL || "wss://app.perpl.xyz", user.credentials); stream.start();
let rq = Math.max(Date.now(), Math.max(0, ...(wallet.as ?? []).map(account => Number(account.lfr ?? 0) + 1)));
const canceled: number[] = [];
try {
  for (const order of active) {
    const account = wallet.as?.find(item => item.id === order.acc); if (!account) throw new Error(`Account ${order.acc} not found`);
    await stream.submit(cancelOrder(rq++, account.id, order)); canceled.push(order.oid);
  }
  console.log(JSON.stringify({ ok: true, canceled }));
} finally { stream.stop(); }

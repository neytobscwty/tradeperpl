import "dotenv/config";
import { performance } from "node:perf_hooks";
import { PerplAccountClient, UserStore, type OrderSpec } from "../src/personal.js";
import { PerplClient, scaled } from "../src/perpl.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const users = new UserStore();
await users.load();
const user = (await users.all())[0];
if (!user) throw new Error("No connected account");
const base = process.env.PERPL_API_URL || "https://app.perpl.xyz/api";
const accountClient = new PerplAccountClient(base, user.credentials);
const publicClient = new PerplClient(base);
const market = await publicClient.market("BTC");
const wallet = await accountClient.wallet();
const account = wallet.as?.find(item => !item.fr && item.fw);
if (!account) throw new Error("No active account with order forwarding");

async function currentBlock() {
  const state = await publicClient.ticker(market);
  return { state, block: Number(state.at?.b ?? market.state?.at?.b ?? 0) };
}
async function waitFor(predicate: (positions: Awaited<ReturnType<typeof accountClient.positions>>) => boolean, timeout = 15_000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const positions = await accountClient.positions();
    if (predicate(positions)) return { positions, elapsed: performance.now() - start };
    await sleep(200);
  }
  throw new Error(`Position state timed out after ${timeout}ms`);
}

const { state, block } = await currentBlock();
const mark = scaled(state.mrk || state.mid, market.config.price_decimals);
const size = Math.max(1, Math.floor((1 * 2 / mark) * 10 ** market.config.size_decimals));
const openRq = Math.max(Date.now(), Number(account.lfr ?? 0) + 1);
const open: OrderSpec = { rq: openRq, mkt: market.id, acc: account.id, t: 1, p: 0, s: size, ms: 100, fl: 0, lv: 200, lb: 0 };
const submitStart = performance.now();
const openResponse = await accountClient.place([open]);
const submitMs = performance.now() - submitStart;
console.log(JSON.stringify({ stage: "open_submitted", submitMs, mark, size, response: openResponse }));
if (openResponse?.status?.code || openResponse?.statuses?.some((x: any) => x.code)) throw new Error(`Open rejected: ${JSON.stringify(openResponse)}`);
const opened = await waitFor(items => items.some(p => p.mkt === market.id && p.st === 1 && p.sd === 1));
const position = opened.positions.find(p => p.mkt === market.id && p.st === 1 && p.sd === 1)!;
console.log(JSON.stringify({ stage: "open_observed", elapsedMs: opened.elapsed, positionId: position.pid, positionSize: position.s }));

const freshWallet = await accountClient.wallet();
const freshAccount = freshWallet.as?.find(item => item.id === account.id)!;
const closeState = await currentBlock();
const closeRq = Math.max(Date.now(), Number(freshAccount.lfr ?? 0) + 1, openRq + 1);
const close: OrderSpec = { rq: closeRq, mkt: market.id, acc: account.id, t: 3, p: 0, s: position.s, ms: 100, fl: 0, lv: position.lv, lb: 0 };
const closeStart = performance.now();
const closeResponse = await accountClient.place([close]);
const closeSubmitMs = performance.now() - closeStart;
console.log(JSON.stringify({ stage: "close_submitted", submitMs: closeSubmitMs, response: closeResponse }));
if (closeResponse?.status?.code || closeResponse?.statuses?.some((x: any) => x.code)) throw new Error(`Close rejected: ${JSON.stringify(closeResponse)}`);
const closed = await waitFor(items => !items.some(p => p.mkt === market.id && p.st === 1 && p.pid === position.pid));
console.log(JSON.stringify({ stage: "close_observed", elapsedMs: closed.elapsed }));

import "dotenv/config";
import { PerplAccountClient, UserStore } from "../src/personal.js";

const base = (process.env.PERPL_API_URL || "https://app.perpl.xyz/api").replace(/\/$/, "");
const users = await new UserStore().all();
if (users.length !== 1) throw new Error(`Expected one connected account, found ${users.length}`);
const history = await new PerplAccountClient(base, users[0].credentials).history(12);
console.log(JSON.stringify(history.map(event => ({
  ...event,
  c: event.c,
  fee: event.fee,
  dpnl: event.dpnl,
  fnd: event.fnd,
})), null, 2));

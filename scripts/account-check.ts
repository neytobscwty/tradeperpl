import "dotenv/config";
import { amount, PerplAccountClient, UserStore } from "../src/personal.js";
import { PerplClient } from "../src/perpl.js";

const users = new UserStore();
await users.load();
for (const user of await users.all()) {
  const client = new PerplAccountClient(process.env.PERPL_API_URL || "https://app.perpl.xyz/api", user.credentials);
  const wallet = await client.wallet();
  console.log(JSON.stringify({
    chatId: user.row.chatId,
    address: wallet.addr,
    accounts: (wallet.as ?? []).map(account => ({
      id: account.id,
      balance: amount(account.b),
      locked: amount(account.lb),
      frozen: account.fr,
      forwarding: account.fw,
      lastRequest: account.lfr,
    })),
  }));
}
const publicClient = new PerplClient(process.env.PERPL_API_URL || "https://app.perpl.xyz/api");
const btc = await publicClient.market("BTC");
console.log(JSON.stringify({ market: btc }));

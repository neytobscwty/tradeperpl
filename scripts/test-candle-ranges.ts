import "dotenv/config";
import { marketSymbol, PerplClient } from "../src/perpl.js";

const base = (process.env.PERPL_API_URL || "https://app.perpl.xyz/api").replace(/\/$/, "");
const client = new PerplClient(base);
const market = (await client.markets()).find(item => marketSymbol(item) === "ZEC") ?? (await client.markets())[0];
for (const [resolution, hours] of [[60, 2], [300, 8], [1800, 48], [3600, 120], [3600, 288], [3600, 720]]) {
    const now = Date.now(), step = resolution * 1000, to = Math.floor(now / step) * step, from = to - hours * 3_600_000;
    const response = await fetch(`${base}/v1/market-data/${market.id}/candles/${resolution}/${from}-${to}`);
    const body = await response.text();
    console.log(resolution, hours, response.status, body.slice(0, 160));
}

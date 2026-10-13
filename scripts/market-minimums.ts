import "dotenv/config";
import { PerplClient, marketSymbol, scaled } from "../src/perpl.js";
const client = new PerplClient(process.env.PERPL_API_URL || "https://app.perpl.xyz/api");
const markets = (await client.markets()).filter(market => market.config.is_open);
const rows = await Promise.all(markets.map(async market => {
  const ticker = await client.ticker(market), mark = scaled(ticker.mrk || ticker.mid, market.config.price_decimals);
  return { symbol: marketSymbol(market), mark, sizeDecimals: market.config.size_decimals, min100Notional: mark * 100 / 10 ** market.config.size_decimals, maxLeverage: market.config.initial_margin ? Math.floor(10_000 / market.config.initial_margin) : null };
}));
console.log(JSON.stringify(rows.sort((a, b) => a.min100Notional - b.min100Notional)));

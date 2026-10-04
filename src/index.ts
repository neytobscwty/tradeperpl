import "dotenv/config";
import { Bot, InlineKeyboard } from "grammy";
import { SocksProxyAgent } from "socks-proxy-agent";
import { AlertStore } from "./alerts.js";
import { amount, eventId, PerplAccountClient, type OrderSpec, type Position, UserStore } from "./personal.js";
import { compact, marketSymbol, money, PerplClient, scaled, type Market, type MarketState } from "./perpl.js";
import { PerplTradingStream } from "./live.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");
const perpl = new PerplClient((process.env.PERPL_API_URL || "https://app.perpl.xyz/api").replace(/\/$/, ""));
const proxy = process.env.TELEGRAM_PROXY?.trim();
const bot = new Bot(token, proxy ? { client: { baseFetchConfig: { agent: new SocksProxyAgent(proxy) } } } : undefined);
const alerts = new AlertStore();
const users = new UserStore();
const menu = new InlineKeyboard().text("⚡  TRADE", "trade:start").row()
  .text("📌 Positions", "positions").text("📋 Orders", "orders").row()
  .text("📊 Markets", "markets").text("💼 Portfolio", "portfolio").row()
  .text("🛡 Risk", "riskboard").text("🔔 Alerts", "alerts:menu").row()
  .text("⚙ Settings", "settings").text("🔄 Update", "home");
type TradeDraft = { symbol?: string; side?: "long" | "short"; margin?: number; leverage?: number };
const drafts = new Map<number, TradeDraft>();
const tradeKey = (chatId: number) => { const draft = drafts.get(chatId) ?? {}; drafts.set(chatId, draft); return draft; };
const homeText = "<b>TradePerplBot</b>\n\nTrade Perpl, monitor positions and receive risk alerts directly in Telegram.";
async function edit(ctx: any, text: string, keyboard: InlineKeyboard) { try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }); } catch (e: any) { if (!String(e?.message).includes("message is not modified")) throw e; } }
const backHome = () => new InlineKeyboard().text("← Main menu", "home");
const marketIcon = (symbol: string) => ({ BTC: "₿", ETH: "Ξ", MON: "◈", SOL: "◎" } as Record<string, string>)[symbol] ?? "•";
function marketPicker(markets: Market[]) { const priority = ["BTC", "ETH", "MON", "SOL"], active = markets.filter(x => x.config.is_open).sort((a, b) => { const ai = priority.indexOf(marketSymbol(a)), bi = priority.indexOf(marketSymbol(b)); return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi); }), kb = new InlineKeyboard(); active.slice(0, 18).forEach((m, i) => { const symbol = marketSymbol(m); kb.text(`${marketIcon(symbol)} ${symbol}`, `trade:market:${m.id}`); if (i % 3 === 2) kb.row(); }); return kb.row().text("← Main menu", "home"); }

const argument = (text?: string) => (text ?? "").trim().split(/\s+/).slice(1).join(" ");
const signed = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
const escape = (v: unknown) => String(v).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const usd = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const priceOf = (m: Market, s: MarketState) => scaled(s.mrk || s.mid || s.lst, m.config.price_decimals);

function fundingStats(m: Market) {
  const interval = m.funding_interval_sec / 3600;
  const rate = Number(m.funding?.rate ?? 0) / 1_000_000;
  return { interval, rate, apr: interval ? rate * (24 / interval) * 365 * 100 : 0 };
}
function fundingText(m: Market) {
  const f = fundingStats(m);
  return `${signed(f.rate * 100, 4)} / ${f.interval.toFixed(1)}h · ${signed(f.apr)} APR`;
}

async function metrics(m: Market, supplied?: MarketState) {
  const s = supplied ?? await perpl.ticker(m), pd = m.config.price_decimals, sd = m.config.size_decimals;
  const mark = priceOf(m, s), bid = scaled(s.bid, pd), ask = scaled(s.ask, pd);
  const spreadBps = mark ? ((ask - bid) / mark) * 10_000 : 0;
  const oiUsd = scaled(s.oi, sd) * mark, tvl = scaled(s.tvl, 6), utilization = tvl ? oiUsd / tvl : 0;
  const candles = await perpl.candles(m);
  const returns = candles.slice(1).map((c, i) => Math.log(c.c / candles[i].c)).filter(Number.isFinite);
  const sigma = returns.length > 1 ? Math.sqrt(returns.reduce((sum, x) => sum + x * x, 0) / returns.length) * Math.sqrt(24) * 100 : 0;
  const high = candles.length ? Math.max(...candles.map(c => scaled(c.h, pd))) : mark;
  const low = candles.length ? Math.min(...candles.map(c => scaled(c.l, pd))) : mark;
  const range = mark ? ((high - low) / mark) * 100 : 0, apr = fundingStats(m).apr;
  const score = Math.min(100, Math.round(spreadBps * 2 + utilization * 12 + Math.min(40, Math.abs(apr) / 25) + sigma * 1.5));
  return { spreadBps, oiUsd, tvl, utilization, sigma, range, apr, score, level: score >= 70 ? "🔴 High" : score >= 40 ? "🟠 Elevated" : "🟢 Normal" };
}

async function marketCard(symbol: string) {
  const m = await perpl.market(symbol), s = await perpl.ticker(m), price = priceOf(m, s);
  const previous = scaled(s.prv, m.config.price_decimals), change = previous ? ((price - previous) / previous) * 100 : 0;
  const bid = scaled(s.bid, m.config.price_decimals), ask = scaled(s.ask, m.config.price_decimals);
  const spread = price ? ((ask - bid) / price) * 10_000 : 0, name = marketSymbol(m);
  return [`<b>${name}-PERP</b> · ${m.config.is_open ? "Open" : "Closed"}`, `Mark: <b>${money(price)}</b> · ${signed(change)}`,
    `Bid / ask: ${money(bid)} / ${money(ask)} · ${spread.toFixed(1)} bps`, `24h volume: ${money(scaled(s.dva, 6))}`,
    `Open interest: ${compact(scaled(s.oi, m.config.size_decimals))} ${name}`, `Funding: ${fundingText(m)}`,
    `Points boost: ${((m.points_boost_bps ?? 10_000) / 10_000).toFixed(2)}x`, `\n/risk ${name} · /book ${name} · /alert ${name} above ${price.toPrecision(6)}`].join("\n");
}

async function marketsCard() {
  const markets = (await perpl.markets()).filter(m => m.config.is_open), states = await perpl.tickers();
  const rows = markets.map(m => { const s = states[String(m.id)] ?? m.state!; const price = priceOf(m, s), prev = scaled(s.prv, m.config.price_decimals); return { m, price, change: prev ? ((price - prev) / prev) * 100 : 0, volume: scaled(s.dva, 6) }; }).sort((a, b) => b.volume - a.volume);
  return `📊 <b>PERPL MARKETS</b>\n<i>Sorted by 24h volume</i>\n\n${rows.map(x => { const symbol = marketSymbol(x.m); return `${marketIcon(symbol)} <b>${symbol}</b>   ${money(x.price)}   <code>${signed(x.change)}</code>\n   Vol ${compact(x.volume)}`; }).join("\n\n")}`;
}

async function bookCard(symbol: string) {
  const m = await perpl.market(symbol), book = await perpl.book(m, 5), pd = m.config.price_decimals, sd = m.config.size_decimals;
  const asks = [...book.ask].reverse().map(x => `🔴 ${money(scaled(x.p, pd))} · ${compact(scaled(x.s, sd))}`), bids = book.bid.map(x => `🟢 ${money(scaled(x.p, pd))} · ${compact(scaled(x.s, sd))}`);
  return `<b>${marketSymbol(m)} order book</b>\n\n${asks.join("\n")}\n──────────\n${bids.join("\n")}`;
}

async function riskCard(symbol: string) {
  const m = await perpl.market(symbol), x = await metrics(m);
  return [`<b>${marketSymbol(m)} risk</b> · ${x.level} · <b>${x.score}/100</b>`, "", `24h volatility: ${x.sigma.toFixed(2)}%`,
    `24h range: ${x.range.toFixed(2)}%`, `Spread: ${x.spreadBps.toFixed(2)} bps`, `Open interest: ${money(x.oiUsd)}`,
    `TVL: ${money(x.tvl)}`, `OI / TVL: ${x.utilization.toFixed(2)}x`, `Funding: ${signed(x.apr)} APR`, "", `<i>Score combines volatility, spread, OI/TVL and absolute funding.</i>`].join("\n");
}

async function riskBoard() {
  const markets = (await perpl.markets()).filter(m => m.config.is_open), states = await perpl.tickers();
  const rows = await Promise.all(markets.map(async m => ({ m, x: await metrics(m, states[String(m.id)]) })));
  rows.sort((a, b) => b.x.score - a.x.score);
  return `<b>Perpl risk board</b>\n\n${rows.map(({ m, x }) => `${x.score >= 70 ? "🔴" : x.score >= 40 ? "🟠" : "🟢"} <b>${marketSymbol(m)}</b>  ${x.score}/100 · vol ${x.sigma.toFixed(1)}% · OI/TVL ${x.utilization.toFixed(1)}x`).join("\n")}`;
}

async function safeReply(ctx: any, task: () => Promise<string>) {
  try { await ctx.reply(await task(), { parse_mode: "HTML", reply_markup: menu }); }
  catch (error) { await ctx.reply(`Could not load data: ${escape(error instanceof Error ? error.message : "Unknown error")}`); }
}

const accountClient = (credentials: { apiKey: string; secret: string }) => new PerplAccountClient((process.env.PERPL_API_URL || "https://app.perpl.xyz/api").replace(/\/$/, ""), credentials);
const liveStreams = new Map<number, PerplTradingStream>();
function liveFor(chatId: number, credentials: { apiKey: string; secret: string }) {
  let stream = liveStreams.get(chatId);
  if (!stream) {
    stream = new PerplTradingStream(process.env.PERPL_WS_URL || "wss://app.perpl.xyz", credentials, message => {
      if (message.mt !== 27 || !Array.isArray(message.d)) return;
      void (async () => { for (const position of message.d as Position[]) await bot.api.sendMessage(chatId, await positionText(position, true), { parse_mode: "HTML", reply_markup: menu }); const newest = message.d.at(-1); if (newest) await users.baseline(chatId, eventId(newest)); })().catch(error => console.error("Live position update failed", chatId, error));
    });
    liveStreams.set(chatId, stream); stream.start();
  }
  return stream;
}
const eventName = (reason: number) => ({ 13: "Position closed", 14: "Position reduced", 15: "Position deleveraged", 17: "Position increased", 18: "Position inverted", 19: "Position liquidated", 21: "Position opened", 22: "Position unwound" } as Record<number, string>)[reason] ?? "Position updated";

async function positionText(position: Position, event = false) {
  const markets = await perpl.markets(), market = markets.find(x => x.id === position.mkt);
  const name = market ? marketSymbol(market) : `Market ${position.mkt}`, pd = market?.config.price_decimals ?? 0, sd = market?.config.size_decimals ?? 0;
  const states = await perpl.tickers(), state = states[String(position.mkt)] ?? market?.state;
  const mark = market && state ? priceOf(market, state) : 0, entry = scaled(position.ep, pd), size = scaled(position.s, sd);
  const side = position.sd === 1 ? "LONG 🟢" : "SHORT 🔴", direction = position.sd === 1 ? 1 : -1;
  const unrealized = mark ? (mark - entry) * size * direction : 0, collateral = amount(position.c), fees = amount(position.fee), notional = size * mark;
  const roe = collateral ? unrealized / collateral * 100 : 0, maintenance = market ? market.config.maintenance_margin / 10_000 : 0.05;
  const liqMove = notional ? Math.max(0, (collateral - notional * maintenance) / (size || 1)) : 0;
  const liquidation = position.sd === 1 ? Math.max(0, entry - liqMove) : entry + liqMove;
  return [event ? `<b>${eventName(position.sr)}</b>` : `<b>${name} ${side}</b>`, event ? `<b>${name} ${side}</b>` : "", `Size: ${compact(size)} ${name} · ${position.lv / 100}x`, `Entry / mark: ${money(entry)} / ${money(mark)}`, `Collateral: ${money(collateral)} · Notional: ${money(notional)}`, `Unrealized PnL: <b>${money(unrealized)}</b> · ${signed(roe)}`, `Est. liquidation: ${money(liquidation)}`, `Entry fees: ${money(fees)}`].filter(Boolean).join("\n");
}

async function portfolioCard(chatId: number) {
  const saved = await users.get(chatId);
  if (!saved) return `<b>Connect your Perpl account</b>\n\n1. Open Perpl and connect your wallet.\n2. Create a key with <b>Trading</b> access.\n3. Copy both values and send:\n<code>/connect API_KEY SECRET</code>\n\nThe message containing the key is deleted immediately. The key can trade but cannot withdraw funds.`;
  const client = accountClient(saved.credentials), [wallet, positions] = await Promise.all([client.wallet(), client.positions()]);
  const accounts = wallet.as ?? [], stats = wallet.sts ?? [];
  const balance = accounts.reduce((sum, x) => sum + amount(x.b), 0), locked = accounts.reduce((sum, x) => sum + amount(x.lb), 0);
  const realized = stats.reduce((sum, x) => sum + amount(x.trp), 0), volume = stats.reduce((sum, x) => sum + amount(x.tv), 0), fees = stats.reduce((sum, x) => sum + amount(x.tf), 0);
  const trades = stats.reduce((sum, x) => sum + Number(x.tt || 0), 0), winRate = trades ? stats.reduce((sum, x) => sum + Number(x.wr || 0) * Number(x.tt || 0), 0) / trades / 100 : 0;
  const open = positions.filter(x => x.st === 1), rows = await Promise.all(open.map(x => positionText(x)));
  return [`💼 <b>PORTFOLIO</b>`, `<code>${wallet.addr.slice(0, 8)}…${wallet.addr.slice(-6)}</code>`, "", `💰 Balance      <b>${usd(balance)}</b>`, `🔒 Locked       <b>${usd(locked)}</b>`, `${realized >= 0 ? "🟢" : "🔴"} Realized PnL  <b>${realized >= 0 ? "+" : ""}${usd(realized)}</b>`, "", `📊 Volume       ${usd(volume)}`, `🧾 Fees         ${usd(fees)}`, `🎯 Win rate     ${winRate.toFixed(1)}%`, `⚡ Trades       ${trades}`, "", `📌 <b>OPEN POSITIONS · ${open.length}</b>`, rows.length ? rows.join("\n\n") : "<i>No open positions</i>"].join("\n");
}

async function dashboardCard(chatId: number) {
  const saved = await users.get(chatId);
  if (!saved) return homeText;
  const client = accountClient(saved.credentials), [wallet, positions, markets, states] = await Promise.all([client.wallet(), client.positions(), perpl.markets(), perpl.tickers()]);
  const accounts = wallet.as ?? [], open = positions.filter(x => x.st === 1);
  const balance = accounts.reduce((sum, x) => sum + amount(x.b), 0), locked = accounts.reduce((sum, x) => sum + amount(x.lb), 0);
  let unrealized = 0;
  const rows = open.slice(0, 4).map(position => { const market = markets.find(x => x.id === position.mkt), state = states[String(position.mkt)] ?? market?.state; if (!market || !state) return ""; const mark = priceOf(market, state), entry = scaled(position.ep, market.config.price_decimals), size = scaled(position.s, market.config.size_decimals), pnl = (mark - entry) * size * (position.sd === 1 ? 1 : -1); unrealized += pnl; return `${position.sd === 1 ? "🟢 LONG" : "🔴 SHORT"}  <b>${marketSymbol(market)}</b> ${position.lv / 100}x  <b>${pnl >= 0 ? "+" : ""}${usd(pnl)}</b>`; }).filter(Boolean);
  const short = `${wallet.addr.slice(0, 6)}…${wallet.addr.slice(-4)}`;
  const pnlIcon = unrealized > 0 ? "🟢" : unrealized < 0 ? "🔴" : "⚪";
  const pulse = ["BTC", "ETH", "MON"].map(symbol => { const market = markets.find(x => marketSymbol(x) === symbol), state = market ? states[String(market.id)] ?? market.state : undefined; if (!market || !state) return ""; const price = priceOf(market, state), previous = scaled(state.prv, market.config.price_decimals), change = previous ? (price - previous) / previous * 100 : 0; return `${change >= 0 ? "🟢" : "🔴"} <b>${symbol}</b>  ${money(price)}  <code>${signed(change)}</code>`; }).filter(Boolean);
  return [`⚡ <b>TradePerpl</b>`, `🟢 Connected · Monad`, `<code>${short}</code>`, "", `💰 <b>${usd(balance + unrealized)}</b>  <i>equity</i>`, `└ Available ${usd(Math.max(0, balance - locked))} · Locked ${usd(locked)}`, `${pnlIcon} PnL  <b>${unrealized >= 0 ? "+" : ""}${usd(unrealized)}</b>`, "", `📌 <b>POSITIONS · ${open.length}</b>`, rows.length ? rows.join("\n") : `<i>No open positions</i>`, open.length > 4 ? `<i>+${open.length - 4} more</i>` : "", "", `📈 <b>MARKET PULSE</b>`, ...pulse].filter(Boolean).join("\n");
}

async function positionsCard(chatId: number) {
  const saved = await users.get(chatId); if (!saved) return { text: "Connect your Perpl account first.", keyboard: backHome() };
  const positions = (await accountClient(saved.credentials).positions()).filter(x => x.st === 1), kb = new InlineKeyboard();
  if (!positions.length) return { text: "📌 <b>OPEN POSITIONS</b>\n\n<i>Nothing open right now</i>", keyboard: new InlineKeyboard().text("⚡ New trade", "trade:start").text("← Home", "home") };
  const rows = await Promise.all(positions.map(position => positionText(position)));
  positions.forEach((p, i) => { kb.text(`Close ${p.sd === 1 ? "long" : "short"} #${p.pid}`, `close:ask:${p.pid}`); if (i % 2 === 1) kb.row(); });
  kb.row().text("⚡ New trade", "trade:start").text("← Home", "home");
  return { text: `📌 <b>OPEN POSITIONS · ${positions.length}</b>\n\n${rows.join("\n\n")}`, keyboard: kb };
}

async function ordersCard(chatId: number) {
  const saved = await users.get(chatId); if (!saved) return "Connect your Perpl account first.";
  const [orders, markets] = await Promise.all([accountClient(saved.credentials).orderHistory(12), perpl.markets()]);
  const status = (n: number) => ({ 1: "Pending", 2: "Open", 3: "Partial", 4: "Filled", 5: "Canceled", 6: "Expired", 7: "Failed", 10: "Executed" } as Record<number, string>)[n] ?? `Status ${n}`;
  const side = (n: number) => ({ 1: "Long", 2: "Short", 3: "Close long", 4: "Close short" } as Record<number, string>)[n] ?? "Order";
  const rows = orders.map(o => { const m = markets.find(x => x.id === o.mkt), name = m ? marketSymbol(m) : `#${o.mkt}`, size = m ? scaled(o.fs || o.os, m.config.size_decimals) : o.fs || o.os; return `${o.t === 1 || o.t === 3 ? "▲" : "▼"} <b>${name}</b> ${side(o.t)} · ${compact(size)}\n   ${status(o.st)} · fee ${money(amount(o.f))}`; });
  return `📋 <b>RECENT ORDERS</b>\n\n${rows.length ? rows.join("\n\n") : "<i>No orders yet</i>"}`;
}

bot.command("start", async ctx => ctx.reply(await dashboardCard(ctx.chat.id), { parse_mode: "HTML", reply_markup: menu }));
bot.command("help", ctx => ctx.reply(["<b>Commands</b>", "/portfolio", "/connect API_KEY SECRET_HEX", "/disconnect", "/markets", "/price BTC", "/book ETH", "/funding MON", "/risk BTC", "/riskboard", "/alert BTC above 90000", "/alerts", "/delalert 3"].join("\n"), { parse_mode: "HTML", reply_markup: menu }));
bot.command("portfolio", ctx => safeReply(ctx, () => portfolioCard(ctx.chat.id)));
bot.command("connect", async ctx => {
  if (ctx.chat.type !== "private") return ctx.reply("Connect your account in a private chat with the bot.");
  const source = ctx.message?.text ?? ""; try { await ctx.deleteMessage(); } catch {}
  const [apiKey, secret] = argument(source).split(/\s+/);
  if (!apiKey || !secret) return ctx.reply("Create a Perpl API key at app.perpl.xyz/apikeys, then use: /connect API_KEY SECRET_HEX");
  try { const credentials = { apiKey, secret }; const wallet = await accountClient(credentials).wallet(); await users.connect(ctx.chat.id, credentials); liveStreams.get(ctx.chat.id)?.stop(); liveStreams.delete(ctx.chat.id); liveFor(ctx.chat.id, credentials); await ctx.reply(`✅ Account connected\n<code>${escape(wallet.addr)}</code>\n\nLive position and order updates are enabled.`, { parse_mode: "HTML", reply_markup: menu }); }
  catch (error) { await ctx.reply(`Connection failed: ${escape(error instanceof Error ? error.message : error)}`, { parse_mode: "HTML" }); }
});
bot.command("disconnect", async ctx => { liveStreams.get(ctx.chat.id)?.stop(); liveStreams.delete(ctx.chat.id); await ctx.reply(await users.disconnect(ctx.chat.id) ? "Portfolio disconnected and stored credentials deleted." : "No portfolio is connected."); });
bot.command("markets", ctx => safeReply(ctx, marketsCard));
bot.command("price", ctx => safeReply(ctx, () => marketCard(argument(ctx.message?.text) || "BTC")));
bot.command("funding", ctx => safeReply(ctx, async () => { const m = await perpl.market(argument(ctx.message?.text) || "BTC"); return `<b>${marketSymbol(m)} funding</b>\n${fundingText(m)}`; }));
bot.command("book", ctx => safeReply(ctx, () => bookCard(argument(ctx.message?.text) || "BTC")));
bot.command("risk", ctx => safeReply(ctx, () => riskCard(argument(ctx.message?.text) || "BTC")));
bot.command("riskboard", ctx => safeReply(ctx, riskBoard));
bot.command("alert", async ctx => {
  const [rawSymbol, rawDirection, rawPrice] = argument(ctx.message?.text).split(/\s+/), symbol = rawSymbol?.toUpperCase(), direction = rawDirection?.toLowerCase(), price = Number(rawPrice);
  if (!symbol || !["above", "below"].includes(direction) || !Number.isFinite(price) || price <= 0) return ctx.reply("Use: /alert BTC above 90000");
  try { await perpl.market(symbol); const item = await alerts.add(ctx.chat.id, symbol, direction as "above" | "below", price); await ctx.reply(`Alert #${item.id}: ${symbol} ${direction} ${money(price)}`); }
  catch (error) { await ctx.reply(`Could not create alert: ${escape(error instanceof Error ? error.message : error)}`); }
});
bot.command("alerts", async ctx => { const items = await alerts.list(ctx.chat.id); await ctx.reply(items.length ? items.map(a => `#${a.id} · ${a.symbol} ${a.direction} ${money(a.price)}`).join("\n") : "No active alerts."); });
bot.command("delalert", async ctx => { const id = Number(argument(ctx.message?.text)); await ctx.reply(Number.isInteger(id) && await alerts.remove(ctx.chat.id, id) ? `Alert #${id} removed.` : "Alert not found."); });
bot.callbackQuery("markets", async ctx => { await ctx.answerCallbackQuery(); await safeReply(ctx, marketsCard); });
bot.callbackQuery("portfolio", async ctx => { await ctx.answerCallbackQuery(); const saved = await users.get(ctx.chat!.id); const kb = saved ? new InlineKeyboard().text("⚡ Trade", "trade:start").text("← Main menu", "home") : new InlineKeyboard().url("Create key on Perpl", "https://app.perpl.xyz/apikeys").row().text("← Main menu", "home"); try { await edit(ctx, await portfolioCard(ctx.chat!.id), kb); } catch (error) { await edit(ctx, `Could not load portfolio: ${escape(error instanceof Error ? error.message : error)}`, backHome()); } });
bot.callbackQuery("riskboard", async ctx => { await ctx.answerCallbackQuery(); await safeReply(ctx, riskBoard); });
bot.callbackQuery(/^market:(.+)$/, async ctx => { await ctx.answerCallbackQuery(); await safeReply(ctx, () => marketCard(ctx.match[1])); });
bot.callbackQuery("home", async ctx => { drafts.delete(ctx.chat!.id); await ctx.answerCallbackQuery(); await edit(ctx, await dashboardCard(ctx.chat!.id), menu); });
bot.callbackQuery("positions", async ctx => { await ctx.answerCallbackQuery(); const card = await positionsCard(ctx.chat!.id); await edit(ctx, card.text, card.keyboard); });
bot.callbackQuery("orders", async ctx => { await ctx.answerCallbackQuery(); await edit(ctx, await ordersCard(ctx.chat!.id), backHome()); });
bot.callbackQuery(/^close:ask:(\d+)$/, async ctx => { await ctx.answerCallbackQuery(); const pid = ctx.match[1]; await edit(ctx, `<b>Close position?</b>\n\nA market order will close the full position.`, new InlineKeyboard().text("Close now", `close:confirm:${pid}`).text("Keep position", "positions")); });
bot.callbackQuery(/^close:confirm:(\d+)$/, async ctx => { await ctx.answerCallbackQuery({ text: "Closing…" }); const saved = await users.get(ctx.chat!.id); if (!saved) return edit(ctx, "Account is not connected.", backHome()); try { const client = accountClient(saved.credentials), [wallet, positions] = await Promise.all([client.wallet(), client.positions()]), position = positions.find(x => x.pid === Number(ctx.match[1]) && x.st === 1), account = wallet.as?.find(x => x.id === position?.acc); if (!position || !account) throw new Error("Position is already closed"); const rq = Math.max(Date.now(), Number(account.lfr ?? 0) + 1), order: OrderSpec = { rq, mkt: position.mkt, acc: account.id, t: position.sd === 1 ? 3 : 4, p: 0, s: position.s, ms: 100, fl: 0, lv: position.lv, lp: position.pid, lb: 0 }; await liveFor(ctx.chat!.id, saved.credentials).submit(order); await edit(ctx, "<b>Position closed ✅</b>\n\nPerpl confirmed the order outcome.", new InlineKeyboard().text("Positions", "positions").text("← Home", "home")); } catch (error) { await edit(ctx, `<b>Could not close position</b>\n\n${escape(error instanceof Error ? error.message : error)}`, new InlineKeyboard().text("Positions", "positions").text("← Home", "home")); } });
bot.callbackQuery("trade:start", async ctx => { await ctx.answerCallbackQuery(); const saved = await users.get(ctx.chat!.id); if (!saved) return edit(ctx, "<b>Connect your Perpl account first</b>\n\nCreate a key with <b>Trading</b> access, then send:\n<code>/connect API_KEY SECRET</code>\n\nThe key cannot withdraw funds.", new InlineKeyboard().url("Create key on Perpl", "https://app.perpl.xyz/apikeys").row().text("← Main menu", "home")); drafts.set(ctx.chat!.id, {}); await edit(ctx, "<b>New order</b>\n\nChoose a market:", marketPicker(await perpl.markets())); });
bot.callbackQuery(/^trade:market:(\d+)$/, async ctx => { await ctx.answerCallbackQuery(); const m = (await perpl.markets()).find(x => x.id === Number(ctx.match[1])); if (!m) return; tradeKey(ctx.chat!.id).symbol = marketSymbol(m); const kb = new InlineKeyboard().text("🟢 Long", "trade:side:long").text("🔴 Short", "trade:side:short").row().text("← Markets", "trade:start"); await edit(ctx, `<b>${marketSymbol(m)}-PERP</b>\n\nChoose direction:`, kb); });
bot.callbackQuery(/^trade:side:(long|short)$/, async ctx => { await ctx.answerCallbackQuery(); tradeKey(ctx.chat!.id).side = ctx.match[1] as "long" | "short"; const kb = new InlineKeyboard().text("$5", "trade:margin:5").text("$10", "trade:margin:10").text("$25", "trade:margin:25").row().text("$50", "trade:margin:50").text("$100", "trade:margin:100").row().text("Cancel", "home"); await edit(ctx, `<b>${tradeKey(ctx.chat!.id).symbol} ${ctx.match[1].toUpperCase()}</b>\n\nChoose margin:`, kb); });
bot.callbackQuery(/^trade:margin:(\d+)$/, async ctx => { await ctx.answerCallbackQuery(); tradeKey(ctx.chat!.id).margin = Number(ctx.match[1]); const kb = new InlineKeyboard().text("2x", "trade:lev:2").text("3x", "trade:lev:3").text("5x", "trade:lev:5").text("10x", "trade:lev:10").row().text("Cancel", "home"); await edit(ctx, `<b>${tradeKey(ctx.chat!.id).symbol} ${tradeKey(ctx.chat!.id).side?.toUpperCase()}</b>\nMargin: ${money(Number(ctx.match[1]))}\n\nChoose leverage:`, kb); });
bot.callbackQuery(/^trade:lev:(\d+)$/, async ctx => { await ctx.answerCallbackQuery(); const d = tradeKey(ctx.chat!.id); d.leverage = Number(ctx.match[1]); const saved = await users.get(ctx.chat!.id); if (!saved) return edit(ctx, "Account is not connected.", backHome()); const [m, wallet] = await Promise.all([perpl.market(d.symbol!), accountClient(saved.credentials).wallet()]), s = await perpl.ticker(m), account = wallet.as?.find(x => !x.fr) ?? wallet.as?.[0]; if (!account) return edit(ctx, "No active Perpl account found.", backHome()); const mark = priceOf(m, s), notional = d.margin! * d.leverage, size = notional / mark, spread = mark ? (scaled(s.ask, m.config.price_decimals) - scaled(s.bid, m.config.price_decimals)) / mark * 10_000 : 0, maxLev = m.config.initial_margin ? Math.floor(10_000 / m.config.initial_margin) : 100, available = amount(account.b) - amount(account.lb), feeRate = (m.config.taker_fees?.[account.ft] ?? m.config.taker_fee ?? 0) / 1_000_000, fee = notional * feeRate, required = d.margin! + fee; if (d.leverage > maxLev) return edit(ctx, `Maximum leverage for ${d.symbol} is ${maxLev}x.`, new InlineKeyboard().text("← Choose leverage", `trade:margin:${d.margin}`).text("Cancel", "home")); if (required > available) return edit(ctx, `⚠️ <b>Not enough available margin</b>\n\nRequired: ${usd(required)}\nAvailable: ${usd(available)}`, new InlineKeyboard().text("← Change size", `trade:side:${d.side}`).text("Cancel", "home")); if (spread > 100) return edit(ctx, `⚠️ <b>Spread is too wide</b>\n\nCurrent spread: ${spread.toFixed(1)} bps\nSafety limit: 100 bps`, new InlineKeyboard().text("Try again", `trade:lev:${d.leverage}`).text("Cancel", "home")); const kb = new InlineKeyboard().text("✅ Confirm order", "trade:confirm").row().text("← Change", `trade:side:${d.side}`).text("Cancel", "home"); await edit(ctx, [`⚡ <b>ORDER PREVIEW</b>`, "", `${d.side === "long" ? "🟢 LONG" : "🔴 SHORT"}  <b>${d.symbol}-PERP</b>`, `────────────────`, `Margin       <b>${usd(d.margin!)}</b>`, `Leverage     <b>${d.leverage}x</b>`, `Position     <b>${usd(notional)}</b>`, `Size         ${compact(size)} ${d.symbol}`, "", `Mark         ${money(mark)}`, `Spread       ${spread.toFixed(2)} bps`, `Est. fee     ${usd(fee)}`, `Available    ${usd(available)}`, "", `🛡 Max slippage · <b>1.00%</b>`].join("\n"), kb); });
bot.callbackQuery("trade:confirm", async ctx => { await ctx.answerCallbackQuery({ text: "Submitting order…" }); const chatId = ctx.chat!.id, d = tradeKey(chatId), saved = await users.get(chatId); if (!saved || !d.symbol || !d.side || !d.margin || !d.leverage) return edit(ctx, "Order session expired.", backHome()); try { const client = accountClient(saved.credentials), [wallet, m] = await Promise.all([client.wallet(), perpl.market(d.symbol)]), account = wallet.as?.find(x => !x.fr) ?? wallet.as?.[0]; if (!account) throw new Error("No active Perpl account found"); if (!account.fw) throw new Error("Order forwarding is disabled for this API key. Enable it in Perpl API key settings."); const state = await perpl.ticker(m), mark = priceOf(m, state), size = Math.max(1, Math.floor((d.margin * d.leverage / mark) * 10 ** m.config.size_decimals)), rq = Math.max(Date.now(), Number(account.lfr ?? 0) + 1); const order: OrderSpec = { rq, mkt: m.id, acc: account.id, t: d.side === "long" ? 1 : 2, p: 0, s: size, ms: 100, fl: 0, lv: d.leverage * 100, lb: 0 }, outcome = await liveFor(chatId, saved.credentials).submit(order); drafts.delete(chatId); await edit(ctx, `<b>Order executed ✅</b>\n\n${d.side.toUpperCase()} ${d.symbol}-PERP · ${d.leverage}x\nMargin ${money(d.margin)} · Notional ${money(d.margin * d.leverage)}\nStatus: ${outcome.st === 4 ? "Filled" : "Confirmed"}`, new InlineKeyboard().text("📌 Positions", "positions").text("⚡ New trade", "trade:start").row().text("Main menu", "home")); } catch (error) { await edit(ctx, `<b>Order rejected</b>\n\n${escape(error instanceof Error ? error.message : error)}`, new InlineKeyboard().text("Try again", "trade:start").text("Main menu", "home")); } });
bot.callbackQuery("alerts:menu", async ctx => { await ctx.answerCallbackQuery(); const items = await alerts.list(ctx.chat!.id); await edit(ctx, `<b>Price alerts</b>\n\n${items.length ? items.map(a => `#${a.id} · ${a.symbol} ${a.direction} ${money(a.price)}`).join("\n") : "No active alerts."}\n\nCreate one with <code>/alert BTC above 90000</code>.`, backHome()); });
bot.callbackQuery("settings", async ctx => { await ctx.answerCallbackQuery(); const saved = await users.get(ctx.chat!.id); await edit(ctx, `<b>Settings</b>\n\nPerpl account: ${saved ? "connected ✅" : "not connected"}\nPosition alerts: ${saved?.row.alerts ? "enabled" : "disabled"}\n\n/connect — connect or replace API key\n/disconnect — remove encrypted credentials`, backHome()); });

async function checkAlerts() {
  const all = await alerts.list(); if (!all.length) return;
  try { const markets = await perpl.markets(), states = await perpl.tickers(), fired = new Set<number>();
    for (const item of all) { const m = markets.find(x => marketSymbol(x) === item.symbol); if (!m) continue; const price = priceOf(m, states[String(m.id)] ?? m.state!);
      if ((item.direction === "above" && price >= item.price) || (item.direction === "below" && price <= item.price)) { try { await bot.api.sendMessage(item.chatId, `🔔 <b>${item.symbol}</b> is ${item.direction} ${money(item.price)}\nCurrent mark: <b>${money(price)}</b>`, { parse_mode: "HTML" }); fired.add(item.id); } catch (e) { console.error("Could not send alert", item.id, e); } }
    } await alerts.consume(fired);
  } catch (e) { console.error("Alert check failed", e); }
}

async function checkPositionEvents() {
  for (const user of await users.all()) {
    if (!user.row.alerts) continue;
    try {
      const history = await accountClient(user.credentials).history(20);
      if (!history.length) continue;
      const newest = eventId(history[0]);
      if (!user.row.lastEvent) { await users.baseline(user.row.chatId, newest); continue; }
      const fresh: Position[] = [];
      for (const event of history) { if (eventId(event) === user.row.lastEvent) break; fresh.push(event); }
      for (const event of fresh.reverse()) await bot.api.sendMessage(user.row.chatId, await positionText(event, true), { parse_mode: "HTML", reply_markup: menu });
      if (fresh.length) await users.baseline(user.row.chatId, newest);
    } catch (error) { console.error("Position watcher failed", user.row.chatId, error); }
  }
}

bot.catch(error => console.error("Telegram update failed", error.error));
await alerts.load(); await users.load();
for (const user of await users.all()) liveFor(user.row.chatId, user.credentials);
setInterval(() => void checkAlerts(), 10_000).unref();
setInterval(() => void checkPositionEvents(), 60_000).unref();
await bot.api.setMyCommands([
  { command: "markets", description: "All markets by volume" }, { command: "price", description: "Market overview: /price BTC" },
  { command: "risk", description: "Market risk report: /risk BTC" }, { command: "riskboard", description: "Risk ranking for all markets" },
  { command: "portfolio", description: "Your positions, PnL and liquidation levels" }, { command: "connect", description: "Connect a read-only Perpl API key" },
  { command: "disconnect", description: "Delete your connected API key" },
  { command: "funding", description: "Funding rate: /funding MON" }, { command: "book", description: "Order book: /book ETH" },
  { command: "alert", description: "Price alert: /alert BTC above 90000" }, { command: "alerts", description: "Your active alerts" },
  { command: "delalert", description: "Remove alert: /delalert 3" }, { command: "help", description: "Commands and examples" },
]);
await bot.start({ onStart: info => console.log(`@${info.username} started`) });

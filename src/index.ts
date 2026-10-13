import "dotenv/config";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { SocksProxyAgent } from "socks-proxy-agent";
import { AlertStore } from "./alerts.js";
import { amount, eventId, orderEventId, PerplAccountClient, type Order, type OrderSpec, type Position, UserStore } from "./personal.js";
import { compact, marketSymbol, money, PerplClient, scaled, type BookResponse, type Candle, type Market, type MarketState } from "./perpl.js";
import { PerplTradingStream } from "./live.js";
import { cancelOrder, closeOrder, closeSize, MIN_SCALED_ORDER_SIZE, openOrder, scaledOrderSize, triggerCloseOrder } from "./orders.js";
import { closedPositionNotional, freshEvents, settledPnl, mainMenu, orderRisk, positionCloseOrder, protectionKind } from "./ui.js";
import { candleChartPng } from "./chart.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");
const perpl = new PerplClient((process.env.PERPL_API_URL || "https://app.perpl.xyz/api").replace(/\/$/, ""));
const proxy = process.env.TELEGRAM_PROXY?.trim();
const bot = new Bot(token, proxy ? { client: { baseFetchConfig: { agent: new SocksProxyAgent(proxy) } } } : undefined);
const alerts = new AlertStore();
const users = new UserStore();
const brandingFile = path.resolve("data/branding.json");
let monadEmojiId = "";
let perplEmojiId = "";
let marketEmojiIds: Record<string, string> = {};
let menuEmojiIds: Record<string, string> = {};
let trendEmojiIds: Record<string, string> = {};
try { const branding = JSON.parse(readFileSync(brandingFile, "utf8")); monadEmojiId = String(branding?.monadEmojiId ?? ""); perplEmojiId = String(branding?.perplEmojiId ?? ""); marketEmojiIds = branding?.marketEmojiIds && typeof branding.marketEmojiIds === "object" ? branding.marketEmojiIds : {}; menuEmojiIds = branding?.menuEmojiIds && typeof branding.menuEmojiIds === "object" ? branding.menuEmojiIds : {}; trendEmojiIds = branding?.trendEmojiIds && typeof branding.trendEmojiIds === "object" ? branding.trendEmojiIds : {}; } catch {}
const menu = mainMenu(menuEmojiIds);
type TradeDraft = { marketId?: number; symbol?: string; side?: "long" | "short"; sizeUnit?: "usd" | "coin"; sizeUsd?: number; sizeCoin?: number; sizeDecimals?: number; minSizeUsd?: number; maxSizeUsd?: number; markPrice?: number; triggerMarkPrice?: number; limitPrice?: number; margin?: number; availableMargin?: number; leverage?: number; maxLeverage?: number; orderType?: "market" | "limit"; postOnly?: boolean; takeProfit?: number; stopLoss?: number; awaiting?: "size" | "margin" | "leverage" | "price" | "tp" | "sl"; chartTimeframe?: ChartTimeframe; menuMessageId?: number; reviewMessageId?: number; inputMessageId?: number; inputErrorMessageId?: number; liveBookActive?: boolean; reviewActive?: boolean; previewFee?: number };
const draftsFile = path.resolve("data/trade-drafts.json");
function loadDrafts() { try { return new Map<number, TradeDraft>((JSON.parse(readFileSync(draftsFile, "utf8")) as Array<[number, TradeDraft]>).map(([id, draft]) => [Number(id), draft])); } catch { return new Map<number, TradeDraft>(); } }
const drafts = loadDrafts();
function saveDrafts() { try { mkdirSync(path.dirname(draftsFile), { recursive: true }); const temporary = `${draftsFile}.tmp`; writeFileSync(temporary, JSON.stringify([...drafts]), { mode: 0o600 }); renameSync(temporary, draftsFile); } catch (error) { console.error("Could not save trade drafts", error); } }
const closeDrafts = new Map<number, { pid: number; messageId: number; size?: number; awaiting?: boolean }>();
const notifiedEvents = new Map<number, Set<string>>();
const notifiedOrders = new Map<number, Set<string>>();
const positionSnapshots = new Map<number, Map<number, Position>>();
function rememberPosition(chatId: number, position: Position) {
  if (position.s <= 0) return;
  const snapshots = positionSnapshots.get(chatId) ?? new Map<number, Position>();
  snapshots.set(position.pid, position);
  positionSnapshots.set(chatId, snapshots);
}
function positionWithSnapshot(chatId: number, position: Position) {
  const snapshot = positionSnapshots.get(chatId)?.get(position.pid);
  if (!snapshot) return position;
  return {
    ...snapshot,
    ...position,
    s: position.s || snapshot.s,
    c: Number(position.c) !== 0 ? position.c : snapshot.c,
    ep: position.ep || snapshot.ep,
    lv: position.lv || snapshot.lv,
    sd: position.sd || snapshot.sd,
    rq: position.rq ?? snapshot.rq,
  };
}
type ProtectionSnapshot = { key: string; kind: "TP" | "SL"; marketId: number; trigger: number; linkedPosition?: number; linkedRequest?: number };
const protectionSnapshots = new Map<number, Map<string, ProtectionSnapshot>>();
const portfolioHistoryCache = new Map<number, Position[]>();
const protectionDrafts = new Map<number, { source: "position" | "order"; id: number; kind: "tp" | "sl"; messageId: number }>();
const connectDrafts = new Map<number, { step: "key" | "secret"; apiKey?: string; messageId: number }>();
const ordersInFlight = new Set<number>();
const closesInFlight = new Set<string>();
const lastReplies = new Map<string, number>();
const livePositionViews = new Map<number, number>();
const chartTransitions = new Set<number>();
const liveBookInteractions = new Set<number>();
const chartLoads = new Set<number>();
const tradeInteractionPauseUntil = new Map<number, number>();
const knownMarkets = new Map<number, Market>();
bot.use(async (ctx, next) => {
  const data = ctx.callbackQuery?.data;
  if (data?.startsWith("trade:") || (ctx.message?.text && drafts.has(ctx.chat!.id))) {
    const chatId = ctx.chat!.id, view = liveBooks.get(chatId);
    tradeInteractionPauseUntil.set(chatId, Date.now() + 2_000);
    if (view) view.expiresAt = Date.now() + 5 * 60_000;
  }
  const started = Date.now();
  await next();
  const elapsed = Date.now() - started;
  if (elapsed >= 750) console.log("Slow Telegram update", data ?? ctx.message?.text?.split(/\s+/)[0] ?? "message", `${elapsed}ms`);
});
const tradeKey = (chatId: number) => { const draft = drafts.get(chatId) ?? {}; drafts.set(chatId, draft); return draft; };
const perplLabel = () => `${perplEmojiId ? `<tg-emoji emoji-id="${perplEmojiId}">🪙</tg-emoji> ` : ""}<b>TradePerpl</b>`;
const homeText = () => `${perplLabel()}\n\nPerpetuals on Monad.`;
async function edit(ctx: any, text: string, keyboard: InlineKeyboard) {
  saveDrafts();
  const currentMessageId = ctx.callbackQuery?.message?.message_id;
  if (livePositionViews.get(ctx.chat.id) === currentMessageId) livePositionViews.delete(ctx.chat.id);
  if (ctx.callbackQuery?.message?.photo) {
    const chatId = ctx.chat.id, oldMessageId = ctx.callbackQuery.message.message_id;
    let sent;
    for (let attempt = 0; ; attempt++) {
      try { sent = await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: keyboard }); break; }
      catch (error: any) {
        const retry = Number(error?.parameters?.retry_after ?? 0);
        if (!retry || attempt >= 1) throw error;
        await new Promise(resolve => setTimeout(resolve, retry * 1_000 + 250));
      }
    }
    try { await bot.api.deleteMessage(chatId, oldMessageId); } catch {}
    const draft = drafts.get(chatId); if (draft && draft.menuMessageId === oldMessageId) draft.menuMessageId = sent.message_id;
    const live = liveBooks.get(chatId); if (live && live.messageId === oldMessageId) live.messageId = sent.message_id;
    return sent.message_id;
  }
  try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }); }
  catch (e: any) {
    const message = String(e?.message ?? e);
    if (message.includes("message is not modified")) return currentMessageId;
    if (!message.includes("message to edit not found") && !message.includes("message can't be edited")) throw e;
    let sent;
    for (let attempt = 0; ; attempt++) {
      try { sent = await bot.api.sendMessage(ctx.chat.id, text, { parse_mode: "HTML", reply_markup: keyboard }); break; }
      catch (error: any) { const retry = Number(error?.parameters?.retry_after ?? 0); if (!retry || attempt >= 1) throw error; await new Promise(resolve => setTimeout(resolve, retry * 1_000 + 250)); }
    }
    const draft = drafts.get(ctx.chat.id); if (draft && draft.menuMessageId === currentMessageId) draft.menuMessageId = sent.message_id;
    const live = liveBooks.get(ctx.chat.id); if (live && live.messageId === currentMessageId) live.messageId = sent.message_id;
    return sent.message_id;
  }
  return ctx.callbackQuery?.message?.message_id as number | undefined;
}
const backHome = () => new InlineKeyboard().text({ text: "Back", style: "primary" }, "home");
const marketIcon = (symbol: string) => ({ BTC: "₿", ETH: "Ξ" } as Record<string, string>)[symbol] ?? "";
const marketFallback = (symbol: string) => ({ BTC: "🟠", ETH: "🔷", MON: "💜", SOL: "🌈", HYPE: "⚡", ZEC: "🟡", LIT: "💡", VVV: "🔵", PUMP: "🚀", NEAR: "⚫", UNI: "🦄" } as Record<string, string>)[symbol] ?? "🪙";
const marketEmoji = (symbol: string) => { const id = symbol === "MON" ? monadEmojiId : marketEmojiIds[symbol]; return id ? `<tg-emoji emoji-id="${id}">${marketFallback(symbol)}</tg-emoji>` : marketIcon(symbol); };
const trendEmoji = (change: number) => { const key = change >= 0 ? "up" : "down", fallback = change >= 0 ? "▲" : "▼", id = trendEmojiIds[key]; return id ? `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>` : fallback; };
const menuFallback = (key: string) => ({ positions: "📌", orders: "📋", portfolio: "💼", markets: "📊", alerts: "🔔", settings: "⚙️" } as Record<string, string>)[key] ?? "•";
const menuEmoji = (key: string) => menuEmojiIds[key] ? `<tg-emoji emoji-id="${menuEmojiIds[key]}">${menuFallback(key)}</tg-emoji>` : menuFallback(key);
const marketPriority = ["BTC", "ETH", "MON", "SOL"];
const maxLeverageOf = (market: Market) => Math.max(1, Math.floor((market.config.initial_margin ?? 10_000) / 100));
const maintenanceRateOf = (market: Market) => market.config.maintenance_margin > 0 ? 100 / market.config.maintenance_margin : 0.05;
function activeMarkets(markets: Market[]) { return markets.filter(x => x.config.is_open).sort((a, b) => { const volume = (m: Market) => scaled(m.state?.dva ?? 0, 6); const byVolume = volume(b) - volume(a); if (byVolume) return byVolume; const ai = marketPriority.indexOf(marketSymbol(a)), bi = marketPriority.indexOf(marketSymbol(b)); return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi); }); }
function marketPicker(markets: Market[]) { const kb = new InlineKeyboard(); activeMarkets(markets).slice(0, 18).forEach((m, i) => { const symbol = marketSymbol(m), icon = marketIcon(symbol), callback = `trade:market:${m.id}`, customEmojiId = symbol === "MON" ? monadEmojiId : marketEmojiIds[symbol]; if (customEmojiId) kb.text({ text: symbol, icon_custom_emoji_id: customEmojiId }, callback); else kb.text(`${icon ? `${icon} ` : ""}${symbol}`, callback); if (i % 3 === 2) kb.row(); }); return kb.row().text({ text: "Back", style: "primary" }, "home"); }
function orderSetupKeyboard(d: TradeDraft, steps?: number[], groupIndex = 0, bookHidden = false) {
  const noType = !d.orderType;
  const kb = new InlineKeyboard();
  kb.text(d.leverage ? `✅ ${d.leverage}x` : "❌ Lev", "trade:leverage")
    .text(d.sizeUsd ? `✅ ${usdRange(d.sizeUsd)}` : "❌ Size", "trade:custom:size")
    .text(d.orderType === "limit" ? (d.limitPrice ? `✅ Price ${money(d.limitPrice)}` : "❌ Price") : "Price Market", "trade:custom:price").row()
    .text(d.orderType === "market" ? "✅ Market" : noType ? "❌ Market" : "Market", "trade:type:market")
    .text(d.orderType === "limit" ? "✅ Limit" : noType ? "❌ Limit" : "Limit", "trade:type:limit")
    .text(d.postOnly ? "✅ Post-only" : "Post-only", "trade:post:toggle");
  kb.row().text(d.takeProfit ? `✅ TP ${money(d.takeProfit)}` : "TP", "trade:custom:tp").text(d.stopLoss ? `✅ SL ${money(d.stopLoss)}` : "SL", "trade:custom:sl").row();
  return kb.text({ text: "Confirm", style: "success" }, "trade:review").text({ text: "Clear all", style: "danger" }, "trade:clear").row().text({ text: "Back", style: "primary" }, "trade:close_setup").text({ text: "Menu", style: "primary" }, "home");
}
function orderSetupText(d: TradeDraft, prompt = "") {
  const margin = d.sizeUsd && d.leverage ? d.sizeUsd / d.leverage : undefined;
  const side = d.side === "long" ? "🟢 LONG" : "🔴 SHORT";
  const heading = d.postOnly ? "[POST-ONLY] New order" : d.orderType ? `[${d.orderType.toUpperCase()}] New order` : "New order";
  const summary = [side, d.symbol ? marketEmoji(d.symbol) : "", d.symbol ?? "", d.sizeUsd ? usdRange(d.sizeUsd) : "", d.leverage ? `${d.leverage}x` : ""].filter(Boolean).join(" ");
  const entry = d.markPrice;
  const coinSize = d.sizeUsd && entry ? d.sizeUsd / entry : 0;
  const direction = d.side === "long" ? 1 : -1;
  const tpPnl = d.takeProfit && entry ? (d.takeProfit - entry) * coinSize * direction : undefined;
  const slPnl = d.stopLoss && entry ? (d.stopLoss - entry) * coinSize * direction : undefined;
  return [
    `<b>${heading}</b>`, "", summary,
    margin ? `💰 Required margin: ${usdRange(margin)}` : undefined,
    d.availableMargin !== undefined ? `💵 Available margin: ${usdRange(d.availableMargin)}` : undefined,
    d.orderType === "limit" && d.limitPrice ? `📍 Limit price: ${money(d.limitPrice)}` : undefined,
    d.takeProfit ? `🎯 TP: ${money(d.takeProfit)}${tpPnl !== undefined ? ` (${signedSmallMoney(tpPnl)})` : ""}` : undefined,
    d.stopLoss ? `🛡 SL: ${money(d.stopLoss)}${slPnl !== undefined ? ` (${signedSmallMoney(slPnl)})` : ""}` : undefined,
    prompt ? `\n${prompt}` : undefined,
    !d.leverage || !d.sizeUsd || !d.orderType ? "\nChoose leverage, size and type." : undefined,
  ].filter(Boolean).join("\n");
}
const confirmationKeyboard = () => new InlineKeyboard().text({ text: "Yes", style: "success" }, "trade:confirm").text({ text: "No", style: "danger" }, "trade:review:cancel").row().text({ text: "Back", style: "primary" }, "trade:review:cancel").text({ text: "Menu", style: "primary" }, "home");
function confirmationText(d: TradeDraft, market: Market, marketPrice: number, markPrice: number) {
  const leverage = d.leverage!, margin = d.margin!, notional = margin * leverage;
  const entry = d.orderType === "market" ? marketPrice : d.limitPrice!;
  const size = notional / entry;
  const risk = orderRisk({ entry, size, margin, maintenanceMargin: maintenanceRateOf(market), side: d.side!, takeProfit: d.takeProfit, stopLoss: d.stopLoss });
  const type = `${d.orderType === "market" ? "Market" : "Limit"}${d.postOnly ? " · Post-only" : ""}`;
  return [
    "<b>Confirm order</b>", "",
    `${marketEmoji(d.symbol!)} <b>${d.symbol}</b>  ${d.side === "long" ? "🟢 <b>LONG</b>" : "🔴 <b>SHORT</b>"} ${leverage}x · ${usdRange(notional)}`, "",
    `<b>Type:</b> ${type}`,
    `<b>Entry:</b> ${money(entry)}`,
    `<b>Mark:</b> ${money(markPrice)}`,
    `<b>Margin:</b> ${usdRange(margin)}`,
    `<b>Liquidation:</b> ${money(risk.liquidation)}`,
    d.previewFee !== undefined ? `<b>Fee:</b> ${feeMoney(d.previewFee)}` : undefined,
    d.takeProfit ? `🎯 <b>TP:</b> ${money(d.takeProfit)} (${signedSmallMoney(risk.takeProfitPnl!)})` : undefined,
    d.stopLoss ? `🛡 <b>SL:</b> ${money(d.stopLoss)} (${signedSmallMoney(risk.stopLossPnl!)})` : undefined,
  ].filter(line => line !== undefined).join("\n");
}
async function showOrderSetup(ctx: any, prompt = "") { const chatId = ctx.chat!.id, d = tradeKey(chatId); if (!d.symbol || !d.side) return edit(ctx, "This order has expired. Open a market again.", new InlineKeyboard().text({ text: "Markets", style: "primary" }, "trade:start").row().text({ text: "Menu", style: "primary" }, "home")); d.menuMessageId = ctx.callbackQuery?.message?.message_id ?? d.menuMessageId; const view = liveBooks.get(chatId), card = view?.card; if (view && card && view.messageId === d.menuMessageId) { d.markPrice = card.price; d.triggerMarkPrice = card.mark; return edit(ctx, `${card.text}\n\n${orderSetupText(d, prompt)}`, orderSetupKeyboard(d, card.steps, card.groupIndex)); } return edit(ctx, orderSetupText(d, prompt), orderSetupKeyboard(d)); }
async function showOrderInput(ctx: any, d: TradeDraft) { const chatId = ctx.chat!.id; d.menuMessageId = ctx.callbackQuery?.message?.message_id ?? d.menuMessageId; const view = liveBooks.get(chatId), card = view?.card; if (view && card && d.symbol) { d.markPrice = card.price; d.triggerMarkPrice = card.mark; const showBook = d.awaiting === "price", messageId = await edit(ctx, showBook ? `${orderPanelText(d)}\n\n${card.text}` : orderPanelText(d), orderInputKeyboard(d)); if (messageId) activateLiveBook(chatId, { ...view, messageId, card }); return messageId; } return edit(ctx, orderPanelText(d), orderInputKeyboard(d)); }
function detachedInputText(d: TradeDraft) { if (d.awaiting === "size" || d.awaiting === "leverage") return `<b>${orderInputText(d, d.awaiting)}</b>`; if (d.awaiting === "price") return `<b>📍 [LIMIT] Send price</b>`; if (d.awaiting === "tp" || d.awaiting === "sl") return `<b>${d.awaiting === "tp" ? "🎯" : "🛡"} [${d.awaiting.toUpperCase()}] Send price</b>\n\n${d.symbol ? `${marketEmoji(d.symbol)} <b>${d.symbol}</b>  Mark ${money(d.triggerMarkPrice ?? 0)}` : ""}\nTriggers by Mark`; return "<b>Send value</b>"; }
async function clearInputError(chatId: number, d: TradeDraft) { if (!d.inputErrorMessageId) return; try { await bot.api.deleteMessage(chatId, d.inputErrorMessageId); } catch {} d.inputErrorMessageId = undefined; }
async function sendInputError(chatId: number, d: TradeDraft, error: string) { await clearInputError(chatId, d); const sent = await bot.api.sendMessage(chatId, `<b>${error}</b>`, { parse_mode: "HTML" }); d.inputErrorMessageId = sent.message_id; saveDrafts(); }
async function askOrderValue(ctx: any, d: TradeDraft) { await clearInputError(ctx.chat.id, d); if (d.inputMessageId) { try { await bot.api.deleteMessage(ctx.chat.id, d.inputMessageId); } catch {} } const sent = await ctx.reply(detachedInputText(d), { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }); d.inputMessageId = sent.message_id; saveDrafts(); }
async function refreshOrderInputMessage(chatId: number, d: TradeDraft, error: string) { if (!d.menuMessageId || !d.symbol) return; const view = liveBooks.get(chatId), card = view?.card; if (card) { d.markPrice = card.price; d.triggerMarkPrice = card.mark; } const showBook = Boolean(card && d.awaiting === "price"), text = `${orderPanelText(d)}\n\n<b>${error}</b>${showBook ? `\n\n${card!.text}` : ""}`; await bot.api.editMessageText(chatId, d.menuMessageId, text, { parse_mode: "HTML", reply_markup: orderInputKeyboard(d) }); }
async function restoreOrderSetup(chatId: number, d: TradeDraft) { if (!d.menuMessageId || !d.symbol) return; const view = liveBooks.get(chatId), card = view?.card; try { if (card) { d.markPrice = card.price; d.triggerMarkPrice = card.mark; } await bot.api.editMessageText(chatId, d.menuMessageId, card ? `${card.text}\n\n${orderSetupText(d)}` : orderSetupText(d), { parse_mode: "HTML", reply_markup: orderSetupKeyboard(d, card?.steps, card?.groupIndex ?? 0) }); } catch (error: any) { if (!String(error?.message).includes("message is not modified")) throw error; } }
function orderInputText(d: TradeDraft, kind: "size" | "leverage", error = "") { const coin = (d.sizeUnit ?? "usd") === "coin", unit = coin ? d.symbol : "USD", min = coin && d.markPrice ? coinAmount((d.minSizeUsd ?? 0) / d.markPrice, d.sizeDecimals) : usdRange(d.minSizeUsd ?? 0), max = d.maxSizeUsd === undefined ? "-" : coin && d.markPrice ? coinAmount(d.maxSizeUsd / d.markPrice, d.sizeDecimals) : usdRange(d.maxSizeUsd), prompt = kind === "leverage" ? `Send leverage 1-${d.maxLeverage ?? 1}` : `Send size in ${unit}\nMin ${min} | Max ${max}`; return `${error ? `${error}\n\n` : ""}${prompt}`; }
const orderInputKeyboard = (d?: TradeDraft) => { const kb = new InlineKeyboard(); if (d?.awaiting === "size") kb.text(d.sizeUnit !== "coin" ? "✅ USD" : "USD", "trade:sizeunit:usd").text(d.sizeUnit === "coin" ? `✅ ${d.symbol}` : `${d.symbol}`, "trade:sizeunit:coin").row(); return kb.text({ text: "Back", style: "primary" }, "trade:setup").text({ text: "Menu", style: "primary" }, "home"); };
function orderPanelText(d: TradeDraft) {
  const triggerInput = d.awaiting === "tp" || d.awaiting === "sl";
  const price = d.symbol && d.markPrice ? `${marketEmoji(d.symbol)} <b>${d.symbol}</b>  Book ${money(d.markPrice)}${triggerInput && d.triggerMarkPrice ? ` | Mark ${money(d.triggerMarkPrice)}` : ""}\n\n` : "";
  if (d.awaiting === "leverage" || d.awaiting === "size") return `<b>${orderInputText(d, d.awaiting)}</b>\n\n${price}`;
  if (d.awaiting === "price") return `<b>📍 [LIMIT] Set price</b>\n\n${price}Send limit price`;
  if (d.awaiting === "tp" || d.awaiting === "sl") return `<b>${d.awaiting === "tp" ? "🎯" : "🛡"} [${d.awaiting.toUpperCase()}] Set price</b>\n\n${price}Triggers by Mark\nSend ${d.awaiting === "tp" ? "take profit" : "stop loss"} price`;
  return orderSetupText(d);
}
const orderPanelKeyboard = (d: TradeDraft) => d.awaiting ? orderInputKeyboard(d) : orderSetupKeyboard(d);
function marketSelectionText(markets: Market[], states: Record<string, MarketState>) { const rows = activeMarkets(markets).map(market => { const state = states[String(market.id)] ?? market.state; if (!state) return ""; const symbol = marketSymbol(market), price = priceOf(market, state), previous = scaled(state.prv, market.config.price_decimals), change = previous ? (price - previous) / previous * 100 : 0; return `${marketEmoji(symbol)} <b>${symbol}</b>  ${money(price)}  ${trendEmoji(change)} ${Math.abs(change).toFixed(1)}%`; }).filter(Boolean); return `<b>New order</b>\n\n${rows.join("\n")}\n\nChoose a market:`; }

const argument = (text?: string) => (text ?? "").trim().split(/\s+/).slice(1).join(" ");
const signed = (n: number, d = 1) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
const escape = (v: unknown) => String(v).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const usd = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
const usdRange = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const feeMoney = (value: number) => value > 0 && value < 0.01 ? "&lt; $0.01" : usdRange(value);
const signedSmallMoney = (value: number) => value !== 0 && Math.abs(value) < 0.01 ? `${value > 0 ? "+" : "-"}&lt; $0.01` : `${value > 0 ? "+" : ""}${usdRange(value)}`;
const coinAmount = (value: number, decimals = 8) => value.toLocaleString("en-US", { useGrouping: false, minimumFractionDigits: 0, maximumFractionDigits: decimals });
const alertPrice = (value: number) => value >= 1_000 ? `$${compact(value)}` : money(value);
const statLine = (icon: string, label: string, value: string) => `${icon} <code>${label.padEnd(12)} ${value}</code>`;
const plainStatLine = (icon: string, label: string, value: string) => `${icon} <b>${label}:</b> ${value}`;
const priceOf = (m: Market, s: MarketState) => scaled(s.mrk || s.mid || s.lst, m.config.price_decimals);
function bookQuote(m: Market, book: BookResponse) { const pd = m.config.price_decimals, ask = Math.min(...book.ask.map(level => scaled(level.p, pd))), bid = Math.max(...book.bid.map(level => scaled(level.p, pd))); if (!Number.isFinite(ask) || !Number.isFinite(bid) || ask <= 0 || bid <= 0 || ask < bid) throw new Error("Order book quote is unavailable"); return { ask, bid, mid: (ask + bid) / 2 }; }

function fundingStats(m: Market) {
  const interval = m.funding_interval_sec / 3600;
  const rate = Number(m.funding?.rate ?? 0) / 1_000_000;
  return { interval, rate, apr: interval ? rate * (24 / interval) * 365 * 100 : 0 };
}
function fundingText(m: Market) {
  const f = fundingStats(m);
  const rate = Number(Math.abs(f.rate * 100).toFixed(4)).toString();
  const apr = Math.round(Math.abs(f.apr));
  const rateArrow = f.rate > 0 ? "▲" : f.rate < 0 ? "▼" : "•";
  const aprArrow = f.apr > 0 ? "▲" : f.apr < 0 ? "▼" : "•";
  return `${rateArrow} ${rate}% | APR ${aprArrow} ${apr}%`;
}
function positionFundingText(m: Market) {
  const funding = fundingStats(m);
  const signedPercent = (value: number, decimals: number) => `${value > 0 ? "+" : ""}${Number(value.toFixed(decimals))}%`;
  return `${signedPercent(funding.rate * 100, 4)} / ${signedPercent(funding.apr, 1)} APR`;
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
  return [`<b>${name}</b> - ${m.config.is_open ? "Open" : "Closed"}`, `Mark: ${money(price)} - ${signed(change)}`,
    `Bid / ask: ${money(bid)} / ${money(ask)} - ${spread.toFixed(1)} bps`, `24h volume: ${money(scaled(s.dva, 6))}`,
    `Open interest: ${compact(scaled(s.oi, m.config.size_decimals))} ${name}`, `Funding: ${fundingText(m)}`,
    `Points boost: ${((m.points_boost_bps ?? 10_000) / 10_000).toFixed(1)}x`, `\n/risk ${name} - /book ${name} - /alert ${name} ${price.toPrecision(6)}`].join("\n");
}

async function marketsCard() {
  const markets = (await perpl.markets()).filter(m => m.config.is_open), states = await perpl.tickers();
  const rows = markets.map(m => { const s = states[String(m.id)] ?? m.state!; const price = priceOf(m, s), prev = scaled(s.prv, m.config.price_decimals); return { m, price, change: prev ? ((price - prev) / prev) * 100 : 0, volume: scaled(s.dva, 6) }; }).sort((a, b) => b.volume - a.volume);
  return `📊 <b>PERPL MARKETS</b>\nPrice · 24h · Volume\n\n${rows.map(x => { const symbol = marketSymbol(x.m), icon = marketEmoji(symbol); return `${icon ? `${icon} ` : ""}<b>${symbol}</b>  ${money(x.price)}  ${trendEmoji(x.change)} ${Math.abs(x.change).toFixed(1)}%\nVol ${compact(x.volume)}`; }).join("\n\n")}\n\nChoose a market to trade:`;
}

type ChartTimeframe = "5m" | "30m" | "1h" | "4h" | "1d";
type LiveMarketCard = { text: string; steps: number[]; groupIndex: number; price: number; mark: number };
type LiveTradeView = { marketId: number; messageId: number; groupIndex: number; chartTimeframe?: ChartTimeframe; review?: boolean; card?: LiveMarketCard; expiresAt?: number };
const liveBooks = new Map<number, LiveTradeView>();
function activateLiveBook(chatId: number, view: LiveTradeView) { const previous = liveBooks.get(chatId); if (!view.card && previous?.marketId === view.marketId && previous.groupIndex === view.groupIndex) view.card = previous.card; view.expiresAt = Date.now() + 5 * 60_000; liveBooks.set(chatId, view); const draft = drafts.get(chatId); if (draft) { draft.liveBookActive = true; draft.reviewActive = Boolean(view.review); saveDrafts(); } }
function stopLiveBook(chatId: number) { liveBooks.delete(chatId); const draft = drafts.get(chatId); if (draft?.liveBookActive || draft?.reviewActive) { draft.liveBookActive = false; draft.reviewActive = false; saveDrafts(); } }
for (const [chatId, draft] of drafts) if (draft.liveBookActive && draft.marketId && draft.menuMessageId && draft.side) liveBooks.set(chatId, { marketId: draft.marketId, messageId: draft.menuMessageId, groupIndex: 0, review: draft.reviewActive, expiresAt: Date.now() + 5 * 60_000 });
async function cleanupTradeMessages(chatId: number, keepMessageId?: number) {
  const ids = new Set<number>();
  const book = liveBooks.get(chatId), draft = drafts.get(chatId);
  if (book) ids.add(book.messageId);
  if (draft?.menuMessageId) ids.add(draft.menuMessageId);
  if (draft?.reviewMessageId) ids.add(draft.reviewMessageId);
  if (draft?.inputMessageId) ids.add(draft.inputMessageId);
  if (draft?.inputErrorMessageId) ids.add(draft.inputErrorMessageId);
  stopLiveBook(chatId);
  for (const id of ids) if (id !== keepMessageId) { try { await bot.api.deleteMessage(chatId, id); } catch {} }
}
function bookSteps(price: number, tick: number) { if (price >= 10_000) return [tick, 1, 10, 100]; if (price >= 1_000) return [tick, 0.1, 1, 10]; if (price >= 100) return [tick, 0.01, 0.1, 1]; if (price >= 1) return [tick, 0.001, 0.01, 0.1]; if (price >= 0.01) return [tick, 0.00001, 0.0001, 0.001]; return [tick, 0.000001, 0.00001, 0.0001]; }
function stepLabel(step: number) { return `$${step >= 1 ? step.toFixed(0) : step.toFixed(Math.max(0, -Math.floor(Math.log10(step))))}`; }
function groupedPrice(price: number, step: number) { const digits = step >= 1 ? 0 : Math.max(0, -Math.floor(Math.log10(step))); return `$${price.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`; }
function bookUsd(value: number) { if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`; if (value >= 1_000) return `$${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`; if (value >= 10) return `$${value.toFixed(0)}`; return `$${value.toFixed(2).replace(/\.00$/, "")}`; }
function groupedBook(levels: Array<{ p: number; s: number; o: number }>, side: "bid" | "ask", step: number, pd: number, sd: number, depth = 6) {
  const groups = new Map<number, { size: number; orders: number }>();
  for (const level of levels) { const price = scaled(level.p, pd), bucket = (side === "ask" ? Math.ceil(price / step) : Math.floor(price / step)) * step, current = groups.get(bucket) ?? { size: 0, orders: 0 }; current.size += scaled(level.s, sd); current.orders += level.o; groups.set(bucket, current); }
  return [...groups].sort((a, b) => side === "ask" ? a[0] - b[0] : b[0] - a[0]).slice(0, depth);
}
function tradeMarketKeyboard(_steps: number[], _groupIndex: number, marketId: number) { return new InlineKeyboard().text({ text: "Long", style: "success" }, `trade:side:long:${marketId}`).text({ text: "Short", style: "danger" }, `trade:side:short:${marketId}`).row().text({ text: "Back", style: "primary" }, "trade:start").text({ text: "Menu", style: "primary" }, "home"); }
function tradeChartKeyboard(marketId: number, timeframe: ChartTimeframe) { const kb = new InlineKeyboard(); (["5m", "30m", "1h", "4h", "1d"] as ChartTimeframe[]).forEach((value, index) => { kb.text(value === timeframe ? `✅ ${value}` : value, `trade:chart:${marketId}:${value}`); if (index === 2) kb.row(); }); return kb.row().text({ text: "Long", style: "success" }, `trade:side:long:${marketId}`).text({ text: "Short", style: "danger" }, `trade:side:short:${marketId}`).row().text({ text: "Back", style: "primary" }, "trade:start").text({ text: "Menu", style: "primary" }, "home"); }
function aggregateCandles(candles: Candle[], seconds: number): Candle[] { const size = seconds * 1000, groups = new Map<number, Candle[]>(); for (const candle of candles) { const key = Math.floor(candle.t / size) * size, group = groups.get(key) ?? []; group.push(candle); groups.set(key, group); } return [...groups].sort((a, b) => a[0] - b[0]).map(([t, rows]) => { rows.sort((a, b) => a.t - b.t); return { t, o: rows[0].o, c: rows.at(-1)!.c, h: Math.max(...rows.map(x => x.h)), l: Math.min(...rows.map(x => x.l)), v: String(rows.reduce((sum, x) => sum + Number(x.v), 0)), n: rows.reduce((sum, x) => sum + x.n, 0) }; }); }
function pairCandles(candles: Candle[]): Candle[] { const rows = [...candles].sort((a, b) => a.t - b.t), result: Candle[] = []; for (let i = Math.max(0, rows.length % 2); i + 1 < rows.length; i += 2) { const a = rows[i], b = rows[i + 1]; result.push({ t: a.t, o: a.o, c: b.c, h: Math.max(a.h, b.h), l: Math.min(a.l, b.l), v: String(Number(a.v) + Number(b.v)), n: a.n + b.n }); } return result; }
function fillCandleGaps(candles: Candle[], seconds: number, points: number): Candle[] { if (!candles.length) return []; const step = seconds * 1000, end = Math.floor(Date.now() / step) * step, start = end - (points - 1) * step, byTime = new Map(candles.map(candle => [Math.floor(candle.t / step) * step, candle])); let previous = [...candles].sort((a, b) => a.t - b.t).filter(candle => candle.t <= start).at(-1)?.c ?? candles[0].o; const result: Candle[] = []; for (let t = start; t <= end; t += step) { const candle = byTime.get(t); if (candle) { result.push({ ...candle, t }); previous = candle.c; } else result.push({ t, o: previous, c: previous, h: previous, l: previous, v: "0", n: 0 }); } return result; }
async function chartCandles(market: Market, timeframe: ChartTimeframe) { if (timeframe === "1h") return pairCandles(await perpl.candles(market, 1800, 168)).slice(-72); if (timeframe === "4h") return fillCandleGaps(aggregateCandles(await perpl.candles(market, 3600, 288), 14_400), 14_400, 72); if (timeframe === "1d") return fillCandleGaps(aggregateCandles(await perpl.candles(market, 3600, 720), 86_400), 86_400, 30); const config = ({ "5m": [300, 8, 96], "30m": [1800, 48, 96] } as Record<Exclude<ChartTimeframe, "1h" | "4h" | "1d">, [number, number, number]>)[timeframe], candles = await perpl.candles(market, config[0], config[1]); return fillCandleGaps(candles, config[0], config[2]); }
async function marketChartView(m: Market, timeframe: ChartTimeframe = "1h") {
  const config = { label: `Chart: ${timeframe.toUpperCase()}` };
  const [book, candles] = await Promise.all([perpl.book(m, 20), chartCandles(m, timeframe)]), symbol = marketSymbol(m), pd = m.config.price_decimals, price = bookQuote(m, book).mid;
  const prices = candles.flatMap(candle => [scaled(candle.l, pd), scaled(candle.h, pd)]).filter(value => Number.isFinite(value) && value > 0);
  const low = prices.length ? Math.min(...prices) : price, high = prices.length ? Math.max(...prices) : price;
  const first = candles.length ? scaled(candles[0].o, pd) : price, change = first ? (price - first) / first * 100 : 0;
  return {
    png: candleChartPng(candles, pd, price),
    caption: `${marketEmoji(symbol)} <b>${symbol}</b> | ${money(price)} | ${trendEmoji(change)} ${Math.abs(change).toFixed(1)}%\n<b>${config.label}</b>\n\nChoose direction:`,
  };
}
async function showMarketChart(ctx: any, market: Market, timeframe: ChartTimeframe) {
  const chart = await marketChartView(market, timeframe), keyboard = tradeChartKeyboard(market.id, timeframe);
  const chatId = ctx.chat.id, oldMessageId = ctx.callbackQuery?.message?.message_id;
  if (ctx.callbackQuery?.message?.photo) {
    try { await ctx.editMessageMedia({ type: "photo", media: new InputFile(chart.png, "chart.png"), caption: chart.caption, parse_mode: "HTML" }, { reply_markup: keyboard }); }
    catch (error: any) { if (!String(error?.message ?? error).includes("message is not modified")) throw error; }
    return oldMessageId;
  }
  const sent = await bot.api.sendPhoto(chatId, new InputFile(chart.png, "chart.png"), { caption: chart.caption, parse_mode: "HTML", reply_markup: keyboard });
  if (oldMessageId) { try { await bot.api.deleteMessage(chatId, oldMessageId); } catch {} }
  return sent.message_id;
}
async function liveMarketView(m: Market, requestedIndex = 0, depth = 5) {
  const [state, book] = await Promise.all([perpl.ticker(m), perpl.book(m, 100)]), symbol = marketSymbol(m), quote = bookQuote(m, book), price = quote.mid, mark = scaled(state.mrk, m.config.price_decimals), volume = scaled(state.dva, 6), pd = m.config.price_decimals, sd = m.config.size_decimals, steps = bookSteps(price, 10 ** -pd), groupIndex = Math.min(steps.length - 1, Math.max(0, requestedIndex)), step = steps[groupIndex];
  const askLevels = groupedBook(book.ask, "ask", step, pd, sd, depth), bidLevels = groupedBook(book.bid, "bid", step, pd, sd, depth);
  let askTotal = 0; const asks = askLevels.map(([p, x]) => { const size = x.size * p; askTotal += size; return { p, size, total: askTotal }; }).reverse().map(x => `🔴 <code>${groupedPrice(x.p, step).padEnd(11)}${bookUsd(x.size).padEnd(7)}${bookUsd(x.total)}</code>`);
  let bidTotal = 0; const bids = bidLevels.map(([p, x]) => { const size = x.size * p; bidTotal += size; return `🟢 <code>${groupedPrice(p, step).padEnd(11)}${bookUsd(size).padEnd(7)}${bookUsd(bidTotal)}</code>`; });
  const rawBestAsk = quote.ask, rawBestBid = quote.bid, bookMid = quote.mid, spread = bookMid ? (rawBestAsk - rawBestBid) / bookMid * 100 : 0;
  const columns = `${"    "}${"Price".padEnd(10)}${"Size".padEnd(7)}Total`;
  const midpointText = `${money(bookMid)} | ${spread.toFixed(3)}%`, midpointPadding = Math.max(1, Math.floor((columns.length - midpointText.length) / 2));
  const midpoint = `<code>${"\u00a0".repeat(midpointPadding)}${midpointText}</code>`;
  const bookMarkup = `<code>${columns}</code>\n${asks.join("\n")}\n\n${midpoint}\n\n${bids.join("\n")}`;
  const text = `${marketEmoji(symbol)} <b>${symbol}</b>  Mark ${money(mark)}\nVol ${compact(volume)} | Funding ${fundingText(m)}\n\n<b>📖 ORDER BOOK</b>\n${bookMarkup}`;
  return { text, steps, groupIndex, price, mark };
}
let liveBookRefreshBusy = false;
const liveBookCooldowns = new Map<number, number>();
async function refreshLiveBooks() {
  if (liveBookRefreshBusy) return; liveBookRefreshBusy = true;
  try { const markets = await perpl.markets(), cards = new Map<string, Promise<Awaited<ReturnType<typeof liveMarketView>>>>();
  await Promise.all([...liveBooks].map(async ([chatId, view]) => {
    if (view.expiresAt && view.expiresAt <= Date.now()) {
      stopLiveBook(chatId); drafts.delete(chatId); saveDrafts();
      try { await bot.api.editMessageText(chatId, view.messageId, await dashboardCard(chatId), { parse_mode: "HTML", reply_markup: menu }); }
      catch { try { await bot.api.deleteMessage(chatId, view.messageId); } catch {} try { await sendMainMenu(chatId); } catch {} }
      return;
    }
    if ((liveBookCooldowns.get(chatId) ?? 0) > Date.now()) return;
    if ((tradeInteractionPauseUntil.get(chatId) ?? 0) > Date.now()) return;
    if (liveBookInteractions.has(chatId)) return;
    if (view.chartTimeframe) return;
    if (view.review || drafts.get(chatId)?.reviewActive) return;
    const market = markets.find(x => x.id === view.marketId); if (!market) return liveBooks.delete(chatId);
    try {
      const draft = drafts.get(chatId), orderMode = Boolean(draft?.side && draft.menuMessageId === view.messageId), inputMode = Boolean(orderMode && draft?.awaiting && !draft.inputMessageId);
      if (!orderMode) return;
      if (inputMode && draft!.awaiting !== "price") return;
      const depth = 5, key = `${market.id}:${view.groupIndex}:${depth}`, pending = cards.get(key) ?? liveMarketView(market, view.groupIndex, depth);
      cards.set(key, pending);
      const card = await pending;
      if (liveBooks.get(chatId)?.messageId !== view.messageId) return;
      view.card = card;
      if (draft) { draft.markPrice = card.price; draft.triggerMarkPrice = card.mark; }
      await bot.api.editMessageText(chatId, view.messageId, inputMode ? `${orderPanelText(draft!)}\n\n${card.text}` : `${card.text}\n\n${orderSetupText(draft!)}`, { parse_mode: "HTML", reply_markup: inputMode ? orderInputKeyboard(draft!) : orderSetupKeyboard(draft!, card.steps, card.groupIndex) });
    }
    catch (error: any) { const message = String(error?.message ?? error), retry = Number(error?.parameters?.retry_after ?? 0); if (retry > 0) liveBookCooldowns.set(chatId, Date.now() + retry * 1_000); if (!message.includes("message is not modified") && !message.includes("Too Many Requests")) console.error("Live order book failed", chatId, market.id, message); }
  })); } finally { liveBookRefreshBusy = false; }
}

async function riskCard(symbol: string) {
  const m = await perpl.market(symbol), x = await metrics(m);
  return [`🛡 <b>${marketSymbol(m)} RISK · ${x.score}/100</b>`, x.level, "", statLine("📈", "Volatility", `${x.sigma.toFixed(1)}%`), statLine("↕️", "24h range", `${x.range.toFixed(1)}%`), statLine("↔️", "Spread", `${x.spreadBps.toFixed(1)} bps`), statLine("📊", "Open int.", money(x.oiUsd)), statLine("💧", "TVL", money(x.tvl)), statLine("⚖️", "OI / TVL", `${x.utilization.toFixed(1)}x`), statLine("💸", "Funding", `${signed(x.apr)} APR`)].join("\n");
}

async function riskBoard() {
  const [marketList, states] = await Promise.all([perpl.markets(), perpl.tickers()]), markets = marketList.filter(m => m.config.is_open);
  const rows = await Promise.all(markets.map(async m => ({ m, x: await metrics(m, states[String(m.id)]) })));
  rows.sort((a, b) => b.x.score - a.x.score);
  return `<b>Perpl risk board</b>\n\n${rows.map(({ m, x }) => `${x.score >= 70 ? "🔴" : x.score >= 40 ? "🟠" : "🟢"} <b>${marketSymbol(m)}</b>  ${x.score}/100 - vol ${x.sigma.toFixed(1)}% - OI/TVL ${x.utilization.toFixed(1)}x`).join("\n")}`;
}

async function replaceReply(ctx: any, key: string, text: string, options: any = {}) { const id = `${ctx.chat.id}:${key}`, previous = lastReplies.get(id); if (previous) { try { await bot.api.deleteMessage(ctx.chat.id, previous); } catch {} } const sent = await ctx.reply(text, options); lastReplies.set(id, sent.message_id); return sent; }
async function safeReply(ctx: any, key: string, task: () => Promise<string>) {
  try { await replaceReply(ctx, key, await task(), { parse_mode: "HTML", reply_markup: menu }); }
  catch (error) { await replaceReply(ctx, key, `Could not load data: ${escape(error instanceof Error ? error.message : "Unknown error")}`); }
}
async function sendMainMenu(chatId: number) {
  try { await bot.api.sendMessage(chatId, await dashboardCard(chatId), { parse_mode: "HTML", reply_markup: menu }); }
  catch (error) {
    console.error("Could not send main menu", chatId, error);
    await bot.api.sendMessage(chatId, homeText(), { parse_mode: "HTML", reply_markup: menu });
  }
}

const accountClients = new Map<string, PerplAccountClient>();
const accountClient = (credentials: { apiKey: string; secret: string }) => {
  const key = `${credentials.apiKey}:${credentials.secret}`;
  let client = accountClients.get(key);
  if (!client) { client = new PerplAccountClient((process.env.PERPL_API_URL || "https://app.perpl.xyz/api").replace(/\/$/, ""), credentials); accountClients.set(key, client); }
  return client;
};
const liveStreams = new Map<number, PerplTradingStream>();
const accountAuthBlocked = new Set<number>();
const accountAuthNotified = new Set<number>();
function liveFor(chatId: number, credentials: { apiKey: string; secret: string }) {
  let stream = liveStreams.get(chatId);
  if (!stream) {
    stream = new PerplTradingStream(process.env.PERPL_WS_URL || "wss://app.perpl.xyz", credentials, message => {
      if (!Array.isArray(message.d)) return;
      void (async () => {
        const current = await users.get(chatId);
        if (!current?.row.alerts) return;
        if (message.mt === 27) {
          for (const position of message.d as Position[]) {
            rememberPosition(chatId, position);
            if ([17, 21].includes(position.sr)) continue;
            await notifyPosition(chatId, position);
          }
          return;
        }
        if (message.mt === 24) {
          for (const order of message.d as Order[]) {
            if (![4, 10].includes(order.st) || ![1, 2].includes(order.t)) continue;
            await notifyFilledOrder(chatId, order);
            await users.baselineOrder(chatId, orderEventId(order));
          }
        }
        return;
      })().catch(error => console.error("Live account update failed", chatId, error));
    });
    liveStreams.set(chatId, stream); stream.start();
  }
  return stream;
}
function isAccountAuthError(error: unknown) { return /rejected the API key or secret|unauthorized|\b401\b/i.test(error instanceof Error ? error.message : String(error)); }
async function handleAccountWatcherError(chatId: number, label: string, error: unknown) {
  if (!isAccountAuthError(error)) return console.error(`${label} watcher failed`, chatId, error);
  accountAuthBlocked.add(chatId);
  liveStreams.get(chatId)?.stop();
  liveStreams.delete(chatId);
  if (accountAuthNotified.has(chatId)) return;
  accountAuthNotified.add(chatId);
  try { await bot.api.sendMessage(chatId, "<b>Perpl connection expired</b>\n\nThe API key was rejected. Update the key to restore trading and live notifications.", { parse_mode: "HTML", reply_markup: new InlineKeyboard().text({ text: "Update Perpl key", style: "primary" }, "settings:replace").row().text({ text: "Settings", style: "primary" }, "settings") }); }
  catch (notifyError) { console.error("Could not report rejected Perpl key", chatId, notifyError); }
}

async function submitOrder(stream: PerplTradingStream, client: PerplAccountClient, order: OrderSpec): Promise<Order> {
  try { return await stream.submit(order) as Order; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/accepted but execution status timed out/i.test(message)) throw error;
    for (let attempt = 0; attempt < 10; attempt++) {
      const [active, history] = await Promise.all([client.orders(), client.orderHistory(40)]);
      const found = [...active, ...history].find(item => item.rq === order.rq);
      if (found?.st === 7) throw new Error(`Order failed (reason ${found.sr}${found.fr != null ? `, failure ${found.fr}` : ""})`);
      if (found) return found;
      if (attempt < 9) await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    throw new Error("Order was accepted but could not be found in active orders or history");
  }
}

async function submitProtection(stream: PerplTradingStream, client: PerplAccountClient, order: OrderSpec) {
  try { const placed = await submitOrder(stream, client, order); return { order: placed, pending: [1, 2, 3, 8, 9].includes(placed.st) }; }
  catch (error) {
    throw error;
  }
}
async function cancelProtection(stream: PerplTradingStream, client: PerplAccountClient, order: Order, request: OrderSpec) {
  try { await stream.submit(request); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/accepted but execution status timed out/i.test(message)) throw error;
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const active = await client.orders();
    if (!active.some(item => item.oid === order.oid && [1, 2, 3, 8, 9].includes(item.st))) return;
    if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error(`${protectionKind(order)} cancellation was not confirmed by Perpl`);
}
const eventName = (reason: number) => ({ 13: "Position closed", 14: "Position reduced", 15: "Position deleveraged", 17: "Position increased", 18: "Position inverted", 19: "Position liquidated", 21: "Position opened", 22: "Position unwound" } as Record<number, string>)[reason] ?? "Position updated";

async function filledOrderText(order: Order, protections: Order[] = []) {
  const market = (await perpl.markets()).find(item => item.id === order.mkt);
  const symbol = market ? marketSymbol(market) : `Market ${order.mkt}`;
  const sizeDecimals = market?.config.size_decimals ?? 0, priceDecimals = market?.config.price_decimals ?? 0;
  const size = scaled(order.fs || order.os, sizeDecimals), price = scaled(order.fp || order.p, priceDecimals), fee = amount(order.f);
  const side = order.t === 1 ? "LONG" : "SHORT", sideIcon = order.t === 1 ? "🟢" : "🔴", type = order.p ? "Limit" : "Market";
  const txid = order.at?.txid ? `0x${String(order.at.txid).replace(/^0x/, "")}` : "";
  const transaction = txid ? `<a href="https://monadscan.com/tx/${escape(txid)}">Transaction ↗</a>` : "";
  return [
    `<b>✅ [${type.toUpperCase()}] Position opened</b>`,
    "",
    `${sideIcon} ${side} ${market ? marketEmoji(symbol) : ""} ${symbol} ${usdRange(size * price)} ${order.lv / 100}x`,
    `🔹 Entry: ${money(price)}`,
    ...protections.sort((a, b) => protectionKind(a).localeCompare(protectionKind(b))).map(item => `${protectionKind(item) === "TP" ? "🎯" : "🛡"} ${protectionKind(item)}: ${money(scaled(item.tp!, priceDecimals))}`),
    fee ? `🧾 Fee: ${feeMoney(fee)}` : undefined,
    transaction,
  ].filter(Boolean).join("\n");
}

async function notifyFilledOrder(chatId: number, order: Order) {
  const id = orderEventId(order), seen = notifiedOrders.get(chatId) ?? new Set<string>();
  if (seen.has(id)) return;
  seen.add(id); notifiedOrders.set(chatId, seen);
  try {
    await new Promise(resolve => setTimeout(resolve, 1_200));
    const saved = await users.get(chatId);
    const protections = saved ? (await accountClient(saved.credentials).orders()).filter(item => item.tr === order.rq && item.tp && [1, 2, 3, 8, 9].includes(item.st)) : [];
    await bot.api.sendMessage(chatId, await filledOrderText(order, protections), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    await sendMainMenu(chatId);
  }
  catch (error) { seen.delete(id); throw error; }
  if (seen.size > 500) seen.delete(seen.values().next().value!);
}

async function positionText(position: Position, event = false, relatedOrder?: Order, protections: Order[] = []) {
  const [markets, states] = await Promise.all([perpl.markets(), perpl.tickers()]), market = markets.find(x => x.id === position.mkt);
  const name = market ? marketSymbol(market) : `Market ${position.mkt}`, pd = market?.config.price_decimals ?? 0, sd = market?.config.size_decimals ?? 0;
  const state = states[String(position.mkt)] ?? market?.state;
  const mark = market && state ? priceOf(market, state) : 0, entry = scaled(position.ep, pd), size = scaled(position.s, sd);
  const side = position.sd === 1 ? "LONG" : "SHORT", sideIcon = position.sd === 1 ? "🟢" : "🔴", direction = position.sd === 1 ? 1 : -1;
  const unrealized = mark ? (mark - entry) * size * direction : 0, collateral = amount(position.c), fees = amount(position.fee), funding = amount(position.fnd), eventPrice = position.xp ? scaled(position.xp, pd) : mark, notional = size * (eventPrice || entry);
  if (event) {
    const exit = position.xp !== undefined, pnl = settledPnl(position);
    const pnlText = signedSmallMoney(pnl);
    const value = closedPositionNotional({ positionSize: position.s, filledOrderSize: relatedOrder?.fs, orderSize: relatedOrder?.os, sizeDecimals: sd, exitPrice: eventPrice, entryPrice: entry, collateral, leverage: position.lv });
    const txid = position.at?.txid ? `0x${String(position.at.txid).replace(/^0x/, "")}` : "";
    const transaction = txid ? `<a href="https://monadscan.com/tx/${escape(txid)}">Transaction ↗</a>` : "";
    const closeType = relatedOrder?.p ? "Limit" : "Market";
    const closeTitle = position.sr === 19 ? "❌ [LIQUIDATION] Position closed ⚠️" : relatedOrder?.tp ? `❌ [${protectionKind(relatedOrder)}] Position closed ${protectionKind(relatedOrder) === "TP" ? "🎯" : "🛡"}` : `❌ [${closeType.toUpperCase()}] Position closed`;
    return [`<b>${closeTitle}</b>`,
      "",
      `${sideIcon} ${side} ${marketEmoji(name)} ${name} ${usdRange(value)} ${position.lv / 100}x`,
      exit ? `🔹 Entry: ${money(entry)}` : `🔹 Entry: ${money(entry)}`,
      exit ? `🔹 Exit: ${money(eventPrice)}` : "",
      exit ? `${pnl >= 0 ? "📈" : "📉"} PnL: ${pnlText}` : "",
      `Funding: ${signedSmallMoney(funding)}  Fee: ${feeMoney(fees)}`,
      transaction].filter(line => line !== undefined && line !== null).join("\n");
  }
  const roe = collateral ? unrealized / collateral * 100 : 0, maintenance = market ? maintenanceRateOf(market) : 0.05;
  const liqMove = notional ? Math.max(0, (collateral - notional * maintenance) / (size || 1)) : 0;
  const liquidation = position.sd === 1 ? Math.max(0, entry - liqMove) : entry + liqMove;
  const tp = protections.find(order => protectionKind(order) === "TP"), sl = protections.find(order => protectionKind(order) === "SL"), protectionLine = [tp ? `🎯 TP ${money(scaled(tp.tp!, pd))}` : "", sl ? `🛡 SL ${money(scaled(sl.tp!, pd))}` : ""].filter(Boolean).join(" · ");
  return [event ? `<b>${name} ${eventName(position.sr).toLowerCase()}</b>` : "", `${marketEmoji(name)} <b>${name}</b>  ${sideIcon} <b>${side}</b> ${position.lv / 100}x · ${money(notional)}`, protectionLine, `${unrealized >= 0 ? "🟢" : "🔴"} <b>PnL:</b> ${unrealized >= 0 ? "+" : ""}${money(unrealized)}  ${signed(roe)}`, `↳ <b>Entry:</b> ${money(entry)}`, `↳ <b>Mark:</b> ${money(mark)}`, `💰 <b>Margin:</b> ${money(Math.abs(collateral))}`, `⚠️ <b>Liq.:</b> ${money(liquidation)}`, market ? `💸 <b>Funding:</b> ${positionFundingText(market)}` : "", fees ? `🧾 <b>Fee:</b> ${money(fees)}` : ""].filter(Boolean).join("\n");
}

async function notifyPosition(chatId: number, position: Position) {
  const closed = position.xp !== undefined || [13, 14, 15, 19, 22].includes(position.sr);
  position = positionWithSnapshot(chatId, position);
  const id = eventId(position), seen = notifiedEvents.get(chatId) ?? new Set<string>();
  if (seen.has(id)) return;
  seen.add(id); notifiedEvents.set(chatId, seen);
  try {
    let relatedOrder: Order | undefined;
    const saved = await users.get(chatId);
    if (saved && [13, 14, 15, 19, 22].includes(position.sr)) {
      const client = accountClient(saved.credentials);
      const details = Promise.all([client.history(20), client.orderHistory(40)]).catch(() => undefined);
      const resolved = await Promise.race([details, new Promise<undefined>(resolve => setTimeout(resolve, 700))]);
      if (resolved) {
        const [history, orders] = resolved;
        for (const item of [...history].reverse()) rememberPosition(chatId, item);
        const complete = history.find(item => eventId(item) === id) ?? history.find(item => item.pid === position.pid && item.sr === position.sr);
        if (complete?.xp !== undefined) position = positionWithSnapshot(chatId, complete);
        if (position.xp !== undefined) relatedOrder = positionCloseOrder(position, orders);
      }
    }
    await bot.api.sendMessage(chatId, await positionText(position, true, relatedOrder), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    await sendMainMenu(chatId);
    if (closed) positionSnapshots.get(chatId)?.delete(position.pid);
  }
  catch (error) { seen.delete(id); throw error; }
  if (seen.size > 500) seen.delete(seen.values().next().value!);
}

async function portfolioCard(chatId: number) {
  const saved = await users.get(chatId);
  if (!saved) return `<b>Connect your Perpl account</b>\n\n1. Open Perpl and connect your wallet.\n2. Create a key with <b>Trading</b> access.\n3. Copy both values and send:\n<code>/connect API_KEY SECRET</code>\n\nThe message containing the key is deleted immediately. The key can trade but cannot withdraw funds.`;
  const client = accountClient(saved.credentials), historyRequest = client.history(100).then(history => { portfolioHistoryCache.set(chatId, history); return history; }).catch(() => portfolioHistoryCache.get(chatId) ?? []);
  const [wallet, positions, history] = await Promise.all([client.wallet(), client.positions(), Promise.race([historyRequest, new Promise<Position[]>(resolve => setTimeout(() => resolve(portfolioHistoryCache.get(chatId) ?? []), 700))])]);
  const accounts = wallet.as ?? [], stats = wallet.sts ?? [];
  const balance = accounts.reduce((sum, x) => sum + amount(x.b), 0), locked = accounts.reduce((sum, x) => sum + amount(x.lb), 0);
  const realized = stats.reduce((sum, x) => sum + amount(x.trp), 0), volume = stats.reduce((sum, x) => sum + amount(x.tv), 0), fees = stats.reduce((sum, x) => sum + amount(x.tf), 0);
  const fundingByPosition = new Map<number, number>();
  for (const position of [...positions, ...history]) if (!fundingByPosition.has(position.pid)) fundingByPosition.set(position.pid, amount(position.fnd));
  const funding = [...fundingByPosition.values()].reduce((sum, value) => sum + value, 0);
  const trades = stats.reduce((sum, x) => sum + Number(x.tt || 0), 0), winRate = trades ? stats.reduce((sum, x) => sum + Number(x.wr || 0) * Number(x.tt || 0), 0) / trades / 100 : 0;
  return [`${menuEmoji("portfolio")} <b>PORTFOLIO</b>`, `${wallet.addr.slice(0, 8)}…${wallet.addr.slice(-6)}`, "\n<b>Balance</b>", plainStatLine("💰", "Total", usd(balance)), plainStatLine("✅", "Available", usd(Math.max(0, balance - locked))), locked > 0 ? plainStatLine("🔒", "Locked", usd(locked)) : "", plainStatLine(realized >= 0 ? "🟢" : "🔴", "Realized", `${realized >= 0 ? "+" : ""}${usd(realized)}`), "\n<b>Statistics</b>", plainStatLine("📊", "Volume", usd(volume)), plainStatLine("🧾", "Fees", usd(fees)), plainStatLine(funding >= 0 ? "🟢" : "🔴", "Funding", signedSmallMoney(funding)), plainStatLine("🎯", "Win rate", `${winRate.toFixed(1)}%`), plainStatLine("🔁", "Trades", String(trades))].filter(Boolean).join("\n");
}

async function dashboardCard(chatId: number) {
  const saved = await users.get(chatId);
  if (!saved) return homeText();
  const client = accountClient(saved.credentials), [wallet, positions, markets, states] = await Promise.all([client.wallet(), client.positions(), perpl.markets(), perpl.tickers()]);
  const accounts = wallet.as ?? [], open = positions.filter(x => x.st === 1);
  const balance = accounts.reduce((sum, x) => sum + amount(x.b), 0), locked = accounts.reduce((sum, x) => sum + amount(x.lb), 0);
  let unrealized = 0;
  const positionData = open.map(position => { const market = markets.find(x => x.id === position.mkt), state = states[String(position.mkt)] ?? market?.state; if (!market || !state) return undefined; const mark = priceOf(market, state), entry = scaled(position.ep, market.config.price_decimals), size = scaled(position.s, market.config.size_decimals), pnl = (mark - entry) * size * (position.sd === 1 ? 1 : -1); unrealized += pnl; return { position, market, mark, size, pnl }; }).filter(Boolean) as Array<{ position: Position; market: Market; mark: number; size: number; pnl: number }>;
  const rows = positionData.slice(0, 4).map(({ position, market, pnl }) => { const symbol = marketSymbol(market); return `${marketEmoji(symbol)} <b>${symbol}</b> ${position.sd === 1 ? "🟢" : "🔴"} <b>${position.sd === 1 ? "LONG" : "SHORT"}</b> ${position.lv / 100}x · PnL ${signedSmallMoney(pnl)}`; });
  const funds = locked > 0 ? [`✅ Available: ${usd(Math.max(0, balance - locked))}`, `🔒 Locked margin: ${usd(locked)}`] : [];
  const positionsBlock = open.length ? ["", `${menuEmoji("positions")} <b>Positions - ${open.length} (PnL ${signedSmallMoney(unrealized)})</b>`, rows.join("\n"), open.length > 4 ? `+${open.length - 4} more` : ""] : [];
  const pulse = ["BTC", "ETH", "MON"].map(symbol => { const market = markets.find(x => marketSymbol(x) === symbol), state = market ? states[String(market.id)] ?? market.state : undefined; if (!market || !state) return ""; const price = priceOf(market, state), previous = scaled(state.prv, market.config.price_decimals), change = previous ? (price - previous) / previous * 100 : 0; return `${marketEmoji(symbol)} <b>${symbol}</b>  ${money(price)}  ${trendEmoji(change)} ${Math.abs(change).toFixed(1)}%`; }).filter(Boolean);
  return [perplLabel(), "", "👛 <b>Wallet</b>", `<code>${escape(wallet.addr)}</code>`, "", "💰 <b>Balance</b>", usd(balance), ...funds, ...positionsBlock, `\n<b>Markets</b>`, ...pulse].filter(line => line !== undefined && line !== null).join("\n");
}

async function positionsCard(chatId: number) {
  const saved = await users.get(chatId); if (!saved) return { text: "Connect your Perpl account first.", keyboard: backHome() };
  const client = accountClient(saved.credentials), [allPositions, allOrders, markets] = await Promise.all([client.positions(), client.orders(), perpl.markets()]);
  const positions = allPositions.filter(x => x.st === 1), activeOrders = allOrders.filter(o => [1, 2, 3, 8, 9].includes(o.st)), kb = new InlineKeyboard();
  positions.forEach(position => rememberPosition(chatId, position));
  if (!positions.length) return { text: `${menuEmoji("positions")} <b>POSITIONS</b>\n\nNo open positions.`, keyboard: new InlineKeyboard().text({ text: "Trade", style: "success" }, "trade:start").row().text({ text: "Back", style: "primary" }, "home") };
  const rows = await Promise.all(positions.map(async position => { const protections = activeOrders.filter(order => protectsPosition(order, position, positions) && order.tp); return positionText(position, false, undefined, protections); }));
  positions.forEach(p => { const symbol = marketSymbol(markets.find(m => m.id === p.mkt)!); const protections = activeOrders.filter(order => protectsPosition(order, p, positions) && order.tp), hasTp = protections.some(order => protectionKind(order) === "TP"), hasSl = protections.some(order => protectionKind(order) === "SL"); kb.text(hasTp ? "Edit TP" : "Add TP", `protect:position:${p.pid}:tp`).text(hasSl ? "Edit SL" : "Add SL", `protect:position:${p.pid}:sl`).text({ text: `Close ${symbol}`, style: "danger" }, `close:ask:${p.pid}`).row(); });
  kb.row().text({ text: "Close all", style: "danger" }, "close:all:ask").text({ text: "New trade", style: "success" }, "trade:start").row().text({ text: "Back", style: "primary" }, "home");
  return { text: `${menuEmoji("positions")} <b>OPEN POSITIONS - ${positions.length}</b>\n\n${rows.join("\n\n")}`, keyboard: kb };
}

let livePositionRefreshBusy = false;
async function refreshLivePositionViews() {
  if (livePositionRefreshBusy || !livePositionViews.size) return;
  livePositionRefreshBusy = true;
  try {
    await Promise.all([...livePositionViews].map(async ([chatId, messageId]) => {
      try { const card = await positionsCard(chatId); if (livePositionViews.get(chatId) !== messageId) return; await bot.api.editMessageText(chatId, messageId, card.text, { parse_mode: "HTML", reply_markup: card.keyboard }); }
      catch (error: any) { const message = String(error?.message ?? error); if (message.includes("message to edit not found") || message.includes("message can't be edited")) livePositionViews.delete(chatId); else if (!message.includes("message is not modified") && !message.includes("Too Many Requests")) console.error("Live positions failed", chatId, message); }
    }));
  } finally { livePositionRefreshBusy = false; }
}

const protectsPosition = (order: Order, position: Position, positions: Position[]) => order.lp === position.pid || (position.rq !== undefined && position.rq !== 0 && order.tr === position.rq) || (!order.lp && !order.tr && order.mkt === position.mkt && order.acc === position.acc && positions.filter(item => item.st === 1 && item.mkt === position.mkt && item.acc === position.acc).length === 1);
function matchingProtections(source: "position" | "order", id: number, kind: "tp" | "sl", positions: Position[], orders: Order[]) {
  const activePositions = positions.filter(position => position.st === 1);
  const activeProtections = orders.filter(order => order.tp && [1, 2, 3, 8, 9].includes(order.st) && protectionKind(order) === kind.toUpperCase());
  if (source === "position") {
    const position = activePositions.find(item => item.pid === id);
    if (!position) return [];
    const linked = activeProtections.filter(order => order.lp === position.pid || (position.rq !== undefined && position.rq !== 0 && order.tr === position.rq));
    if (linked.length) return linked;
    return activeProtections.filter(order => protectsPosition(order, position, activePositions));
  }
  const baseOrder = orders.find(order => order.oid === id && [1, 2, 3, 8, 9].includes(order.st));
  return baseOrder ? activeProtections.filter(order => order.tr === baseOrder.rq) : [];
}
const protectionSnapshot = (order: Order): ProtectionSnapshot => { const kind = protectionKind(order), key = `${order.lp ? `position:${order.lp}` : `request:${order.tr ?? order.rq}`}:${kind}`; return { key, kind, marketId: order.mkt, trigger: order.tp!, linkedPosition: order.lp, linkedRequest: order.tr }; };
async function baselineProtections(chatId: number, client: PerplAccountClient) { const orders = (await client.orders()).filter(order => order.tp && [1, 2, 3, 8, 9].includes(order.st)); protectionSnapshots.set(chatId, new Map(orders.map(order => { const item = protectionSnapshot(order); return [item.key, item]; }))); }

async function ordersCard(chatId: number) {
  const saved = await users.get(chatId); if (!saved) return "Connect your Perpl account first.";
  const client = accountClient(saved.credentials), [openOrders, positions, markets, states] = await Promise.all([client.orders(), client.positions(), perpl.markets(), perpl.tickers()]);
  const openPositionIds = new Set(positions.filter(position => position.st === 1).map(position => position.pid));
  const active = openOrders.filter(o => [1, 2, 3, 8, 9].includes(o.st) && (!o.lp || openPositionIds.has(o.lp)));
  if (!active.length) return `${menuEmoji("orders")} <b>ORDERS</b>\n\nNo active orders.`;
  return `${menuEmoji("orders")} <b>ACTIVE ORDERS - ${active.length}</b>\n\n${active.map(o => { const market = markets.find(m => m.id === o.mkt), symbol = market ? marketSymbol(market) : `#${o.mkt}`, size = market ? scaled(o.os, market.config.size_decimals) : o.os, rawPrice = market && o.p ? scaled(o.p, market.config.price_decimals) : 0, triggerPrice = market && o.tp ? scaled(o.tp, market.config.price_decimals) : 0, mark = market && states[String(market.id)] ? priceOf(market, states[String(market.id)]) : 0, price = rawPrice ? money(rawPrice) : "Market", trigger = triggerPrice ? money(triggerPrice) : "", side = o.t === 1 ? "🟢 LONG" : o.t === 2 ? "🔴 SHORT" : `${protectionKind(o) === "TP" ? "🎯" : "🛡"} ${protectionKind(o)}`; return `${market ? marketEmoji(symbol) : ""} <b>${symbol}</b>  ${side}\n📦 <b>Size:</b> ${usdRange(size * (rawPrice || triggerPrice || mark))}\n${trigger ? `${protectionKind(o) === "TP" ? "🎯" : "🛡"} <b>Trigger:</b> ${trigger}` : `💵 <b>Price:</b> ${price}`}`; }).join("\n\n")}`;
}

async function ordersView(chatId: number) {
  const saved = await users.get(chatId), kb = new InlineKeyboard();
  if (!saved) return { text: "Connect your Perpl account first.", keyboard: backHome() };
  const client = accountClient(saved.credentials), [allOrders, positions, markets] = await Promise.all([client.orders(), client.positions(), perpl.markets()]), openPositionIds = new Set(positions.filter(position => position.st === 1).map(position => position.pid)), active = allOrders.filter(o => [1, 2, 3, 8, 9].includes(o.st) && (!o.lp || openPositionIds.has(o.lp)));
  active.forEach(o => { const symbol = marketSymbol(markets.find(m => m.id === o.mkt)!); if ([1, 2].includes(o.t)) { const linked = active.filter(item => item.tr === o.rq && item.tp), hasTp = linked.some(item => protectionKind(item) === "TP"), hasSl = linked.some(item => protectionKind(item) === "SL"); kb.text(hasTp ? "Edit TP" : "Add TP", `protect:order:${o.oid}:tp`).text(hasSl ? "Edit SL" : "Add SL", `protect:order:${o.oid}:sl`); } kb.text({ text: `Cancel ${symbol}${o.tp ? ` ${protectionKind(o)}` : ""}`, style: "danger" }, `order:cancel:${o.oid}`).row(); });
  kb.text({ text: "Back", style: "primary" }, "home");
  return { text: await ordersCard(chatId), keyboard: kb };
}

async function alertsView(chatId: number) {
  const items = await alerts.list(chatId), kb = new InlineKeyboard();
  items.forEach(item => kb.text({ text: `Cancel ${item.symbol} ${item.direction === "above" ? "↑" : "↓"} ${alertPrice(item.price)}`, style: "danger" }, `alert:delete:${item.id}`).row());
  kb.text({ text: "Back", style: "primary" }, "home");
  const rows = items.map(item => `${item.direction === "above" ? "🟢" : "🔴"} <b>${item.symbol}</b>  ${item.direction === "above" ? "↑" : "↓"} ${alertPrice(item.price)}`);
  return { text: `${menuEmoji("alerts")} <b>PRICE ALERTS</b>\n\n${rows.length ? rows.join("\n") : "No active alerts."}\n\nCreate: /alert BTC 90000`, keyboard: kb };
}

const openMainMenu = async (ctx: any) => replaceReply(ctx, "main-menu", await dashboardCard(ctx.chat.id), { parse_mode: "HTML", reply_markup: menu });
bot.command("start", async ctx => {
  const saved = await users.get(ctx.chat.id);
  if (!saved) return replaceReply(ctx, "start", `<b>Connect Perpl</b>\n\nConnect a Trading API key to use TradePerpl. The key can trade but cannot withdraw funds.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text({ text: "Connect Perpl", style: "primary" }, "connect:start") });
  try { const wallet = await accountClient(saved.credentials).wallet(); return replaceReply(ctx, "start", `<b>Perpl connected ✅</b>\n\n👛 <code>${escape(wallet.addr)}</code>`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text({ text: "Menu", style: "primary" }, "home").text({ text: "Settings", style: "primary" }, "settings") }); }
  catch { return replaceReply(ctx, "start", "<b>Reconnect Perpl</b>\n\nThe saved connection could not be verified.", { parse_mode: "HTML", reply_markup: new InlineKeyboard().text({ text: "Replace API key", style: "primary" }, "settings:replace") }); }
});
bot.command("menu", openMainMenu);
bot.command("help", ctx => replaceReply(ctx, "help", ["<b>Commands</b>", "/menu", "/portfolio", "/connect API_KEY SECRET_HEX", "/disconnect", "/markets", "/price BTC", "/book ETH", "/funding MON", "/risk BTC", "/riskboard", "/alert BTC 90000", "/alerts", "/delalert 3"].join("\n"), { parse_mode: "HTML", reply_markup: menu }));
bot.command("portfolio", ctx => safeReply(ctx, "portfolio", () => portfolioCard(ctx.chat.id)));
bot.command("connect", async ctx => {
  if (ctx.chat.type !== "private") {
    try { await ctx.deleteMessage(); } catch {}
    return ctx.reply("Connect your account in a private chat with the bot. If your key message remains visible here, delete it and revoke that key on Perpl.");
  }
  const source = ctx.message?.text ?? ""; try { await ctx.deleteMessage(); } catch {}
  const [apiKey, secret] = argument(source).split(/\s+/);
  if (!apiKey || !secret) return ctx.reply("Create a Perpl API key at app.perpl.xyz/apikeys, then use: /connect API_KEY SECRET_HEX");
  try { const credentials = { apiKey, secret }; const wallet = await accountClient(credentials).wallet(); await users.connect(ctx.chat.id, credentials); accountAuthBlocked.delete(ctx.chat.id); accountAuthNotified.delete(ctx.chat.id); liveStreams.get(ctx.chat.id)?.stop(); liveStreams.delete(ctx.chat.id); liveFor(ctx.chat.id, credentials); await ctx.reply(`✅ Account connected\n<code>${escape(wallet.addr)}</code>\n\nLive position and order updates are enabled.`, { parse_mode: "HTML", reply_markup: menu }); }
  catch (error) { await ctx.reply(`Connection failed: ${escape(error instanceof Error ? error.message : error)}`, { parse_mode: "HTML" }); }
});
bot.command("disconnect", async ctx => { liveStreams.get(ctx.chat.id)?.stop(); liveStreams.delete(ctx.chat.id); await ctx.reply(await users.disconnect(ctx.chat.id) ? "Portfolio disconnected and stored credentials deleted." : "No portfolio is connected."); });
bot.command("markets", async ctx => { try { const markets = await perpl.markets(); await replaceReply(ctx, "markets", await marketsCard(), { parse_mode: "HTML", reply_markup: marketPicker(markets) }); } catch (error) { await replaceReply(ctx, "markets", `Could not load data: ${escape(error instanceof Error ? error.message : "Unknown error")}`); } });
bot.command("price", ctx => safeReply(ctx, "price", () => marketCard(argument(ctx.message?.text) || "BTC")));
bot.command("funding", ctx => safeReply(ctx, "funding", async () => { const m = await perpl.market(argument(ctx.message?.text) || "BTC"); return `<b>${marketSymbol(m)} funding</b>\n${fundingText(m)}`; }));
bot.command("book", ctx => safeReply(ctx, "book", async () => { const m = await perpl.market(argument(ctx.message?.text) || "BTC"); return (await liveMarketView(m)).text; }));
bot.command("risk", ctx => safeReply(ctx, "risk", () => riskCard(argument(ctx.message?.text) || "BTC")));
bot.command("riskboard", ctx => safeReply(ctx, "riskboard", riskBoard));
bot.command("alert", async ctx => {
  const [rawSymbol = "", rawPrice = ""] = argument(ctx.message?.text).split(/\s+/), symbol = rawSymbol.toUpperCase(), price = Number(rawPrice.replace(",", "."));
  if (!symbol || !Number.isFinite(price) || price <= 0) return ctx.reply("Use: /alert BTC 90000");
  try { const market = await perpl.market(symbol), state = await perpl.ticker(market), current = priceOf(market, state), direction = price >= current ? "above" : "below", item = await alerts.add(ctx.chat.id, symbol, direction, price); await ctx.reply(`<b>Alert #${item.id} set</b>\n${direction === "above" ? "🟢" : "🔴"} <b>${symbol}</b>  ${direction === "above" ? "↑" : "↓"} ${alertPrice(price)}\nCurrent ${alertPrice(current)}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text({ text: "Cancel alert", style: "danger" }, `alert:delete:${item.id}`).row().text({ text: "Alerts", style: "primary" }, "alerts:menu").text({ text: "Menu", style: "primary" }, "home") }); }
  catch (error) { await ctx.reply(`Could not create alert: ${escape(error instanceof Error ? error.message : error)}`); }
});
bot.command("alerts", async ctx => { const view = await alertsView(ctx.chat.id); await replaceReply(ctx, "alerts", view.text, { parse_mode: "HTML", reply_markup: view.keyboard }); });
bot.command("delalert", async ctx => { const id = Number(argument(ctx.message?.text)), removed = Number.isInteger(id) && await alerts.remove(ctx.chat.id, id); const view = await alertsView(ctx.chat.id); await replaceReply(ctx, "alerts", `${removed ? `Alert #${id} removed.\n\n` : "Alert not found.\n\n"}${view.text}`, { parse_mode: "HTML", reply_markup: view.keyboard }); });
bot.on("message:text", async ctx => {
  const closing = closeDrafts.get(ctx.chat.id);
  if (closing?.awaiting && !ctx.message.text.startsWith("/")) {
    try { await ctx.deleteMessage(); } catch {}
    const saved = await users.get(ctx.chat.id); if (!saved) return;
    const p = (await accountClient(saved.credentials).positions()).find(x => x.pid === closing.pid && x.st === 1);
    if (!p) { closeDrafts.delete(ctx.chat.id); return; }
    const m = (await perpl.markets()).find(x => x.id === p.mkt)!;
    const value = Number(ctx.message.text.trim().replace(",", ".")), size = Math.floor(value * 10 ** m.config.size_decimals + 1e-9);
    if (!Number.isFinite(value) || size < 1 || size > p.s) {
      await bot.api.editMessageText(ctx.chat.id, closing.messageId, `Send a valid size in ${marketSymbol(m)}\nMax ${coinAmount(scaled(p.s, m.config.size_decimals), m.config.size_decimals)}`, { reply_markup: new InlineKeyboard().text("Back", `close:ask:${p.pid}`) }); return;
    }
    closing.size = size; closing.awaiting = false;
    await bot.api.editMessageText(ctx.chat.id, closing.messageId, `<b>Close ${marketSymbol(m)}?</b>\n${coinAmount(scaled(size, m.config.size_decimals), m.config.size_decimals)} ${marketSymbol(m)}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Yes", `close:confirm:${p.pid}:custom`).text("No", `close:ask:${p.pid}`) });
    return;
  }
  const protection = protectionDrafts.get(ctx.chat.id);
  if (protection && !ctx.message.text.startsWith("/")) {
    const value = Number(ctx.message.text.trim().replace(",", "."));
    try { await ctx.deleteMessage(); } catch {}
    if (!Number.isFinite(value) || value <= 0) { await ctx.reply("<b>Enter a valid TP/SL price.</b>", { parse_mode: "HTML" }); return; }
    try {
      const saved = await users.get(ctx.chat.id); if (!saved) throw new Error("Account is not connected");
      const client = accountClient(saved.credentials), [wallet, markets, positions, orders] = await Promise.all([client.wallet(), perpl.markets(), client.positions(), client.orders()]);
      const position = protection.source === "position" ? positions.find(x => x.pid === protection.id && x.st === 1) : undefined;
      const order = protection.source === "order" ? orders.find(x => x.oid === protection.id && [1, 2, 3, 8, 9].includes(x.st)) : undefined;
      if (!position && !order) throw new Error(protection.source === "position" ? "Position is no longer open" : "Order is no longer active");
      const marketId = position?.mkt ?? order!.mkt, market = markets.find(x => x.id === marketId); if (!market) throw new Error("Market not found");
      const side: "long" | "short" = position ? (position.sd === 1 ? "long" : "short") : (order!.t === 1 ? "long" : "short");
      const mark = priceOf(market, await perpl.ticker(market));
      const validSide = protection.kind === "tp" ? (side === "long" ? value > mark : value < mark) : (side === "long" ? value < mark : value > mark);
      if (!validSide) throw new Error(`${protection.kind.toUpperCase()} must be ${side === "long" ? (protection.kind === "tp" ? "above" : "below") : (protection.kind === "tp" ? "below" : "above")} Mark ${money(mark)} for ${side.toUpperCase()}.`);
      const accountId = position?.acc ?? order!.acc, account = wallet.as?.find(x => x.id === accountId && x.fw); if (!account) throw new Error("Order forwarding is disabled");
      const size = position?.s ?? Math.max(0, order!.os - order!.fs), leverage = (position?.lv ?? order!.lv) / 100;
      const existingProtections = matchingProtections(protection.source, protection.id, protection.kind, positions, orders);
      let rq = Math.max(Date.now(), Number(account.lfr ?? 0) + 1);
      const stream = liveFor(ctx.chat.id, saved.credentials);
      for (const existing of existingProtections) await cancelProtection(stream, client, existing, cancelOrder(rq++, accountId, existing));
      const trigger = triggerCloseOrder({ rq, market: market.id, account: accountId, side, size, leverage, triggerPrice: Math.round(value * 10 ** market.config.price_decimals), kind: protection.kind, linkedPosition: position?.pid, linkedRequest: order?.rq });
      const placed = await submitProtection(stream, client, trigger); protectionDrafts.delete(ctx.chat.id);
      try { await baselineProtections(ctx.chat.id, client); } catch {}
      if (protection.source === "position") {
        const card = await positionsCard(ctx.chat.id);
        await bot.api.editMessageText(ctx.chat.id, protection.messageId, card.text, { parse_mode: "HTML", reply_markup: card.keyboard });
        livePositionViews.set(ctx.chat.id, protection.messageId);
      } else {
        const view = await ordersView(ctx.chat.id);
        await bot.api.editMessageText(ctx.chat.id, protection.messageId, view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
      }
    } catch (error) { const message = error instanceof Error ? error.message : String(error); if (/^(TP|SL) must be/i.test(message)) await ctx.reply(`<b>${escape(message)}</b>`, { parse_mode: "HTML" }); else await bot.api.editMessageText(ctx.chat.id, protection.messageId, `<b>Could not add ${protection.kind.toUpperCase()}</b>\n\n${escape(message)}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text({ text: "Back", style: "primary" }, protection.source === "position" ? "positions" : "orders").text({ text: "Menu", style: "primary" }, "home") }); }
    return;
  }
  const connecting = connectDrafts.get(ctx.chat.id);
  if (connecting && !ctx.message.text.startsWith("/")) {
    const value = ctx.message.text.trim();
    try { await ctx.deleteMessage(); } catch {}
    if (connecting.step === "key") {
      if (value.length < 12 || /\s/.test(value)) { await bot.api.editMessageText(ctx.chat.id, connecting.messageId, `<b>That does not look like an API Key</b>\n\nCopy the value labeled API Key on Perpl and send it here.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().url("Open Perpl", "https://app.perpl.xyz/apikeys").row().text({ text: "Cancel", style: "primary" }, "home") }); return; }
      connecting.apiKey = value; connecting.step = "secret";
      await bot.api.editMessageText(ctx.chat.id, connecting.messageId, `<b>Now send API Secret</b>\n\nIt is the long hex value that starts with <code>0x...</code>. Perpl shows it only once. This message will also be deleted immediately.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().url("Open Perpl", "https://app.perpl.xyz/apikeys").row().text({ text: "Cancel", style: "primary" }, "home") });
      return;
    }
    const cleanSecret = value.replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(cleanSecret)) { await bot.api.editMessageText(ctx.chat.id, connecting.messageId, `<b>That does not look like API Secret</b>\n\nSend the 64-character hex value shown by Perpl. It usually starts with <code>0x</code>.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().url("Open Perpl", "https://app.perpl.xyz/apikeys").row().text({ text: "Cancel", style: "primary" }, "home") }); return; }
    try {
      const credentials = { apiKey: connecting.apiKey!, secret: cleanSecret }, wallet = await accountClient(credentials).wallet();
      await users.connect(ctx.chat.id, credentials); accountAuthBlocked.delete(ctx.chat.id); accountAuthNotified.delete(ctx.chat.id); liveStreams.get(ctx.chat.id)?.stop(); liveStreams.delete(ctx.chat.id); liveFor(ctx.chat.id, credentials); connectDrafts.delete(ctx.chat.id);
      await bot.api.editMessageText(ctx.chat.id, connecting.messageId, `<b>Perpl connected ✅</b>\n\n<code>${escape(wallet.addr)}</code>\n\nTrading and live updates are ready.`, { parse_mode: "HTML", reply_markup: menu });
    } catch (error) { connectDrafts.delete(ctx.chat.id); await bot.api.editMessageText(ctx.chat.id, connecting.messageId, `<b>Could not connect Perpl</b>\n\n${escape(error instanceof Error ? error.message : error)}\n\nCreate a Trading key and try again.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text({ text: "Try again", style: "primary" }, "connect:start").row().text({ text: "Menu", style: "primary" }, "home") }); }
    return;
  }
  const d = drafts.get(ctx.chat.id); if (!d?.awaiting || ctx.message.text.startsWith("/")) return;
  const value = Number(ctx.message.text.trim().replace(",", "."));
  const candidateSizeUsd = d.awaiting === "size" ? ((d.sizeUnit ?? "usd") === "coin" ? value * (d.markPrice ?? 0) : value) : undefined;
  const valid = d.awaiting === "leverage" ? Number.isInteger(value) && value > 0 && value <= (d.maxLeverage ?? 100) : d.awaiting === "size" ? Number.isFinite(candidateSizeUsd) && candidateSizeUsd! >= (d.minSizeUsd ?? 0) && candidateSizeUsd! <= (d.maxSizeUsd ?? Number.MAX_VALUE) : Number.isFinite(value) && value > 0;
  try { await ctx.deleteMessage(); } catch {}
  if (!valid) {
    const error = d.awaiting === "size" ? "Size is outside the available range." : d.awaiting === "leverage" ? "Enter a valid leverage." : "Enter a valid price.";
    if (d.inputMessageId) await sendInputError(ctx.chat.id, d, error);
    else if (d.menuMessageId) await refreshOrderInputMessage(ctx.chat.id, d, error);
    return;
  }
  const awaiting = d.awaiting;
  if ((awaiting === "tp" || awaiting === "sl") && d.symbol && d.side) {
    try {
      const market = await perpl.market(d.symbol), protocolMark = priceOf(market, await perpl.ticker(market));
      d.triggerMarkPrice = protocolMark;
      const above = d.side === "long" ? awaiting === "tp" : awaiting === "sl";
      if (above ? value <= protocolMark : value >= protocolMark) {
        const error = `${awaiting.toUpperCase()} must be ${above ? "above" : "below"} Mark ${money(protocolMark)} for ${d.side.toUpperCase()}.`;
        if (d.inputMessageId) await sendInputError(ctx.chat.id, d, error); else await refreshOrderInputMessage(ctx.chat.id, d, error);
        return;
      }
    } catch (error) {
      await refreshOrderInputMessage(ctx.chat.id, d, `Could not verify Mark price: ${escape(error instanceof Error ? error.message : error)}`);
      return;
    }
  }
  if (awaiting === "size") { if ((d.sizeUnit ?? "usd") === "coin") { d.sizeCoin = value; d.sizeUsd = d.markPrice ? value * d.markPrice : undefined; } else { d.sizeUsd = value; d.sizeCoin = d.markPrice ? value / d.markPrice : undefined; } if (d.sizeUsd && d.leverage) d.margin = d.sizeUsd / d.leverage; } else if (awaiting === "margin") d.margin = value; else if (awaiting === "leverage") { d.leverage = value; if (d.sizeUsd) d.margin = d.sizeUsd / value; } else if (awaiting === "price") d.limitPrice = value; else if (awaiting === "tp") d.takeProfit = value; else d.stopLoss = value;
  if ((awaiting === "tp" || awaiting === "sl") && d.triggerMarkPrice) d.markPrice = d.triggerMarkPrice;
  if (d.inputMessageId) { try { await bot.api.deleteMessage(ctx.chat.id, d.inputMessageId); } catch {} d.inputMessageId = undefined; }
  await clearInputError(ctx.chat.id, d);
  d.awaiting = undefined;
  saveDrafts();
  await restoreOrderSetup(ctx.chat.id, d);
});
bot.callbackQuery("markets", async ctx => { await ctx.answerCallbackQuery(); try { const markets = await perpl.markets(); await edit(ctx, await marketsCard(), marketPicker(markets)); } catch (error) { await edit(ctx, `Could not load markets: ${escape(error instanceof Error ? error.message : error)}`, backHome()); } });
bot.callbackQuery("portfolio", async ctx => { await ctx.answerCallbackQuery(); const saved = await users.get(ctx.chat!.id); const kb = saved ? new InlineKeyboard().text({ text: "Trade", style: "success" }, "trade:start").text({ text: "Back", style: "primary" }, "home") : new InlineKeyboard().text({ text: "Connect Perpl", style: "primary" }, "connect:start").row().text({ text: "Back", style: "primary" }, "home"); try { await edit(ctx, await portfolioCard(ctx.chat!.id), kb); } catch (error) { await edit(ctx, `Could not load portfolio: ${escape(error instanceof Error ? error.message : error)}`, backHome()); } });
bot.callbackQuery("riskboard", async ctx => { await ctx.answerCallbackQuery(); await safeReply(ctx, "riskboard", riskBoard); });
bot.callbackQuery(/^market:(.+)$/, async ctx => { await ctx.answerCallbackQuery(); await safeReply(ctx, "market", () => marketCard(ctx.match[1])); });
bot.callbackQuery("home", async ctx => { await cleanupTradeMessages(ctx.chat!.id, ctx.callbackQuery.message?.message_id); drafts.delete(ctx.chat!.id); protectionDrafts.delete(ctx.chat!.id); connectDrafts.delete(ctx.chat!.id); await ctx.answerCallbackQuery(); await edit(ctx, await dashboardCard(ctx.chat!.id), menu); });
bot.callbackQuery("connect:start", async ctx => { await ctx.answerCallbackQuery(); const messageId = ctx.callbackQuery.message!.message_id; connectDrafts.set(ctx.chat!.id, { step: "key", messageId }); await edit(ctx, `<b>CONNECT PERPL</b>\n\n1. Open Perpl and create an API key with Trading access.\n2. Copy the value labeled API Key.\n3. Send it here.\n\nI will delete your message immediately.`, new InlineKeyboard().url("Open Perpl", "https://app.perpl.xyz/apikeys").row().text({ text: "Cancel", style: "primary" }, "home")); });
bot.callbackQuery("positions", async ctx => { protectionDrafts.delete(ctx.chat!.id); await ctx.answerCallbackQuery(); const card = await positionsCard(ctx.chat!.id), messageId = await edit(ctx, card.text, card.keyboard); if (messageId) livePositionViews.set(ctx.chat!.id, messageId); });
bot.callbackQuery("orders", async ctx => { protectionDrafts.delete(ctx.chat!.id); await ctx.answerCallbackQuery(); const view = await ordersView(ctx.chat!.id); await edit(ctx, view.text, view.keyboard); });
bot.callbackQuery(/^protect:(position|order):(\d+):(tp|sl)$/, async ctx => {
  await ctx.answerCallbackQuery();
  const source = ctx.match[1] as "position" | "order", kind = ctx.match[3] as "tp" | "sl", id = Number(ctx.match[2]);
  protectionDrafts.set(ctx.chat!.id, { source, id, kind, messageId: ctx.callbackQuery.message!.message_id });
  const keyboard = new InlineKeyboard();
  try {
    const saved = await users.get(ctx.chat!.id);
    if (saved) {
      const client = accountClient(saved.credentials), [positions, orders] = await Promise.all([client.positions(), client.orders()]);
      if (matchingProtections(source, id, kind, positions, orders).length) keyboard.text({ text: `Delete ${kind.toUpperCase()}`, style: "danger" }, `protect:delete:${source}:${id}:${kind}`).row();
    }
  } catch {}
  keyboard.text({ text: "Back", style: "primary" }, source === "position" ? "positions" : "orders").text({ text: "Menu", style: "primary" }, "home");
  await edit(ctx, `<b>${kind === "tp" ? "🎯" : "🛡"} [${kind.toUpperCase()}] Set price</b>\n\nSend ${kind === "tp" ? "take profit" : "stop loss"} price`, keyboard);
});
bot.callbackQuery(/^protect:delete:(position|order):(\d+):(tp|sl)$/, async ctx => {
  const chatId = ctx.chat!.id, source = ctx.match[1] as "position" | "order", id = Number(ctx.match[2]), kind = ctx.match[3] as "tp" | "sl";
  await ctx.answerCallbackQuery({ text: `Deleting ${kind.toUpperCase()}…` });
  const saved = await users.get(chatId);
  if (!saved) return edit(ctx, "Account is not connected.", backHome());
  try {
    const client = accountClient(saved.credentials), [wallet, positions, orders] = await Promise.all([client.wallet(), client.positions(), client.orders()]);
    const targets = matchingProtections(source, id, kind, positions, orders);
    if (!targets.length) throw new Error(`${kind.toUpperCase()} is already deleted`);
    const account = wallet.as?.find(item => item.id === targets[0].acc && item.fw);
    if (!account) throw new Error("Order forwarding is disabled");
    let rq = Math.max(Date.now(), Number(account.lfr ?? 0) + 1);
    const stream = liveFor(chatId, saved.credentials);
    for (const target of targets) await cancelProtection(stream, client, target, cancelOrder(rq++, account.id, target));
    protectionDrafts.delete(chatId);
    try { await baselineProtections(chatId, client); } catch {}
    if (source === "position") {
      const card = await positionsCard(chatId), messageId = await edit(ctx, card.text, card.keyboard);
      if (messageId) livePositionViews.set(chatId, messageId);
    } else {
      const view = await ordersView(chatId);
      await edit(ctx, view.text, view.keyboard);
    }
  } catch (error) {
    await edit(ctx, `<b>Could not delete ${kind.toUpperCase()}</b>\n\n${escape(error instanceof Error ? error.message : error)}`, new InlineKeyboard().text({ text: "Back", style: "primary" }, source === "position" ? "positions" : "orders"));
  }
});
bot.callbackQuery(/^order:cancel:(\d+)$/, async ctx => {
  const chatId = ctx.chat!.id, oid = Number(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: "Canceling…" });
  const saved = await users.get(chatId);
  if (!saved) return edit(ctx, "Account is not connected.", backHome());
  try {
    const client = accountClient(saved.credentials), [wallet, open] = await Promise.all([client.wallet(), client.orders()]);
    const existing = open.find(o => o.oid === oid), account = wallet.as?.find(a => a.id === existing?.acc);
    if (!existing || !account) throw new Error("Order is no longer open");
    const rq = Math.max(Date.now(), Number(account.lfr ?? 0) + 1);
    const cancel = cancelOrder(rq, account.id, existing);
    const outcome = await liveFor(chatId, saved.credentials).submit(cancel);
    const view = await ordersView(chatId);
    await edit(ctx, `<b>Order #${oid} canceled ✅</b>\n\nPerpl status ${outcome.st}.\n\n${view.text}`, view.keyboard);
  } catch (error) {
    await edit(ctx, `<b>Cancel was not confirmed</b>\n\n${escape(error instanceof Error ? error.message : error)}`, new InlineKeyboard().text("Orders", "orders").text({ text: "Menu", style: "primary" }, "home"));
  }
});
bot.callbackQuery(/^close:ask:(\d+)$/, async ctx => {
  await ctx.answerCallbackQuery(); const pid = Number(ctx.match[1]), saved = await users.get(ctx.chat!.id);
  if (!saved) return edit(ctx, "Account is not connected.", backHome());
  const p = (await accountClient(saved.credentials).positions()).find(x => x.pid === pid && x.st === 1);
  if (!p) return edit(ctx, "Position is already closed.", backHome());
  const m = (await perpl.markets()).find(x => x.id === p.mkt)!;
  closeDrafts.set(ctx.chat!.id, { pid, messageId: ctx.callbackQuery.message!.message_id });
  const kb = new InlineKeyboard();
  if (closeSize(p.s, 50) >= 1) kb.text("50%", `close:confirm:${pid}:50`);
  kb.text("100%", `close:confirm:${pid}:100`).text("Custom size", `close:custom:${pid}`).row().text("Back", "positions");
  await edit(ctx, `<b>Close ${marketSymbol(m)} ${p.sd === 1 ? "🟢 Long" : "🔴 Short"}</b>\nSize ${coinAmount(scaled(p.s, m.config.size_decimals), m.config.size_decimals)} ${marketSymbol(m)}\n\nChoose how much to close:`, kb);
});
bot.callbackQuery(/^close:custom:(\d+)$/, async ctx => {
  await ctx.answerCallbackQuery(); const saved = await users.get(ctx.chat!.id); if (!saved) return;
  const pid = Number(ctx.match[1]), p = (await accountClient(saved.credentials).positions()).find(x => x.pid === pid && x.st === 1); if (!p) return;
  const m = (await perpl.markets()).find(x => x.id === p.mkt)!;
  closeDrafts.set(ctx.chat!.id, { pid, messageId: ctx.callbackQuery.message!.message_id, awaiting: true });
  await edit(ctx, `Send size in ${marketSymbol(m)}\nMin ${coinAmount(10 ** -m.config.size_decimals, m.config.size_decimals)} · Max ${coinAmount(scaled(p.s, m.config.size_decimals), m.config.size_decimals)}`, new InlineKeyboard().text("Back", `close:ask:${pid}`));
});
bot.callbackQuery("close:all:ask", async ctx => { await ctx.answerCallbackQuery(); await edit(ctx, "<b>Close every open position?</b>\n\nEach position will be closed with a market order.", new InlineKeyboard().text({ text: "Close all", style: "danger" }, "close:all:confirm").text({ text: "Keep positions", style: "primary" }, "positions")); });
bot.callbackQuery("close:all:confirm", async ctx => {
  const chatId = ctx.chat!.id; await ctx.answerCallbackQuery({ text: "Closing positions…" });
  const saved = await users.get(chatId); if (!saved) return edit(ctx, "Account is not connected.", backHome());
  try {
    const client = accountClient(saved.credentials), [wallet, positions] = await Promise.all([client.wallet(), client.positions()]);
    const open = positions.filter(position => position.st === 1); if (!open.length) return edit(ctx, "No open positions.", backHome());
    let rq = Math.max(Date.now(), Math.max(0, ...(wallet.as ?? []).map(account => Number(account.lfr ?? 0) + 1)));
    for (const position of open) {
      const account = wallet.as?.find(item => item.id === position.acc && item.fw); if (!account) throw new Error(`Forwarding is disabled for account ${position.acc}`);
      await liveFor(chatId, saved.credentials).submit(closeOrder(rq++, account.id, position, 100));
    }
    const card = await positionsCard(chatId); await edit(ctx, `<b>All ${open.length} position(s) closed ✅</b>\n\n${card.text}`, card.keyboard);
  } catch (error) { await edit(ctx, `<b>Close all stopped</b>\n\n${escape(error instanceof Error ? error.message : error)}\n\nReview remaining positions before retrying.`, new InlineKeyboard().text("Positions", "positions").text({ text: "Menu", style: "primary" }, "home")); }
});
bot.callbackQuery(/^close:confirm:(\d+):(50|100|custom)$/, async ctx => {
  const chatId = ctx.chat!.id, positionId = Number(ctx.match[1]), percent = Number(ctx.match[2]), lock = `${chatId}:${positionId}`;
  if (closesInFlight.has(lock)) return ctx.answerCallbackQuery({ text: "Close already in progress" });
  await ctx.answerCallbackQuery({ text: "Closing…" });
  const saved = await users.get(chatId);
  if (!saved) return edit(ctx, "Account is not connected.", backHome());
  closesInFlight.add(lock);
  try {
    const client = accountClient(saved.credentials);
    const [wallet, positions] = await Promise.all([client.wallet(), client.positions()]);
    const position = positions.find(x => x.pid === positionId && x.st === 1);
    const account = wallet.as?.find(x => x.id === position?.acc);
    if (!position || !account) throw new Error("Position is already closed");
    if (!account.fw) throw new Error("Order forwarding is disabled for this account");
    const rq = Math.max(Date.now(), Number(account.lfr ?? 0) + 1);
    const order = closeOrder(rq, account.id, position, percent === 50 ? 50 : 100);
    if (ctx.match[2] === "custom") order.s = closeDrafts.get(chatId)?.size ?? 0;
    if (order.s > position.s) throw new Error("Size exceeds the current position");
    if (order.s < MIN_SCALED_ORDER_SIZE) throw new Error("This partial close is below the market lot size. Choose a larger percentage.");
    const outcome = await submitOrder(liveFor(chatId, saved.credentials), client, order);
    const filled = outcome.st === 4 || outcome.st === 10;
    closeDrafts.delete(chatId);
    await edit(ctx, filled ? "✅ Close filled" : "Close submitted", new InlineKeyboard());
  } catch (error) {
    await edit(ctx, `<b>Close was not confirmed</b>\n\n${escape(error instanceof Error ? error.message : error)}\n\nCheck Positions and Orders before retrying.`, new InlineKeyboard().text("Positions", "positions").text("Orders", "orders").row().text({ text: "Menu", style: "primary" }, "home"));
  } finally {
    closesInFlight.delete(lock);
  }
});
bot.callbackQuery("trade:start", async ctx => {
  await cleanupTradeMessages(ctx.chat!.id, ctx.callbackQuery.message?.message_id);
  await ctx.answerCallbackQuery();
  const saved = await users.get(ctx.chat!.id);
  if (!saved) return edit(ctx, "<b>Connect your Perpl account first</b>\n\nIt takes about a minute. The key can trade but cannot withdraw funds.", new InlineKeyboard().text({ text: "Connect Perpl", style: "primary" }, "connect:start").row().text({ text: "Menu", style: "primary" }, "home"));
  drafts.set(ctx.chat!.id, {});
  const [markets, states] = await Promise.all([perpl.markets(), perpl.tickers()]);
  for (const market of markets) knownMarkets.set(market.id, market);
  await edit(ctx, marketSelectionText(markets, states), marketPicker(markets));
});
bot.callbackQuery(/^trade:market:(\d+)$/, async ctx => {
  await ctx.answerCallbackQuery();
  const m = (await perpl.markets()).find(x => x.id === Number(ctx.match[1]));
  if (!m) return;
  knownMarkets.set(m.id, m);
  const d = tradeKey(ctx.chat!.id), symbol = marketSymbol(m);
  Object.assign(d, { marketId: m.id, symbol, sizeDecimals: m.config.size_decimals, maxLeverage: maxLeverageOf(m), menuMessageId: ctx.callbackQuery.message?.message_id });
  const timeframe: ChartTimeframe = "1h";
  d.chartTimeframe = timeframe;
  const messageId = await showMarketChart(ctx, m, timeframe); d.menuMessageId = messageId;
  if (messageId) liveBooks.set(ctx.chat!.id, { marketId: m.id, messageId, groupIndex: 0, chartTimeframe: timeframe, expiresAt: Date.now() + 5 * 60_000 });
});
bot.callbackQuery(/^trade:chart:(\d+):(5m|30m|1h|4h|1d)$/, async ctx => {
  const chatId = ctx.chat!.id, marketId = Number(ctx.match[1]), timeframe = ctx.match[2] as ChartTimeframe;
  const current = liveBooks.get(chatId);
  if (current?.marketId === marketId && current.chartTimeframe === timeframe) return ctx.answerCallbackQuery({ text: `${timeframe.toUpperCase()} is already open` });
  if (chartLoads.has(chatId)) return ctx.answerCallbackQuery({ text: "Chart is loading…" });
  await ctx.answerCallbackQuery({ text: "Loading chart…" });
  chartLoads.add(chatId);
  try {
    const market = (await perpl.markets()).find(item => item.id === marketId); if (!market) return;
    tradeKey(chatId).chartTimeframe = timeframe;
    const messageId = await showMarketChart(ctx, market, timeframe);
    if (messageId) liveBooks.set(chatId, { marketId: market.id, messageId, groupIndex: 0, chartTimeframe: timeframe, expiresAt: Date.now() + 5 * 60_000 });
  } finally { chartLoads.delete(chatId); }
});
bot.callbackQuery(/^trade:bookstep:(\d+):([0-3])$/, async ctx => {
  const chatId = ctx.chat!.id, requestedIndex = Number(ctx.match[2]), current = liveBooks.get(ctx.chat!.id);
  if (current?.groupIndex === requestedIndex && !current.chartTimeframe) return ctx.answerCallbackQuery();
  if (liveBookInteractions.has(chatId)) return ctx.answerCallbackQuery({ text: "Updating book…" });
  await ctx.answerCallbackQuery();
  liveBookInteractions.add(chatId);
  try {
    const d = tradeKey(chatId), market = (await perpl.markets()).find(x => x.id === Number(ctx.match[1])); if (!market) return;
    Object.assign(d, { marketId: market.id, symbol: marketSymbol(market), sizeDecimals: market.config.size_decimals, maxLeverage: maxLeverageOf(market) });
    const card = await liveMarketView(market, requestedIndex), messageId = ctx.callbackQuery.message?.message_id;
    d.markPrice = card.price; d.triggerMarkPrice = card.mark;
    if (!messageId) return;
    const text = d.side ? `${card.text}\n\n${orderSetupText(d)}` : card.text;
    const keyboard = d.side ? orderSetupKeyboard(d, card.steps, card.groupIndex) : tradeMarketKeyboard(card.steps, card.groupIndex, market.id);
    try { await bot.api.editMessageText(chatId, messageId, text, { parse_mode: "HTML", reply_markup: keyboard }); }
    catch (error: any) { if (!String(error?.message ?? error).includes("message is not modified")) throw error; }
    activateLiveBook(chatId, { marketId: market.id, messageId, groupIndex: card.groupIndex, card });
  } finally { liveBookInteractions.delete(chatId); }
});
bot.callbackQuery(/^trade:side:(long|short)(?::(\d+))?$/, async ctx => {
  const chatId = ctx.chat!.id;
  if (chartTransitions.has(chatId)) return ctx.answerCallbackQuery({ text: "Opening order…" });
  await ctx.answerCallbackQuery({ text: "Loading order book…" });
  const d = tradeKey(chatId);
  const marketId = Number(ctx.match[2] ?? d.marketId);
  const market = Number.isFinite(marketId) ? knownMarkets.get(marketId) ?? (await perpl.markets()).find(x => x.id === marketId) : undefined;
  if (!market) return edit(ctx, "This market view has expired. Open it again.", new InlineKeyboard().text({ text: "Markets", style: "primary" }, "trade:start").row().text({ text: "Menu", style: "primary" }, "home"));
  chartTransitions.add(chatId);
  try {
    const previousView = liveBooks.get(chatId);
    const groupIndex = previousView?.groupIndex ?? 0;
    const chartTimeframe = previousView?.chartTimeframe ?? d.chartTimeframe ?? "1h";
    stopLiveBook(chatId);
    Object.assign(d, { marketId: market.id, symbol: marketSymbol(market), sizeDecimals: market.config.size_decimals, maxLeverage: maxLeverageOf(market), chartTimeframe });
    d.side = ctx.match[1] as "long" | "short";
    d.sizeUnit = "usd"; d.sizeUsd = undefined; d.sizeCoin = undefined; d.margin = undefined; d.leverage = undefined; d.orderType = undefined; d.postOnly = false;
    d.limitPrice = undefined; d.takeProfit = undefined; d.stopLoss = undefined; d.awaiting = undefined; d.availableMargin = undefined;
    const messageId = ctx.callbackQuery.message?.message_id;
    d.menuMessageId = messageId;
    const saved = await users.get(chatId);
    const [card, wallet] = await Promise.all([
      liveMarketView(market, groupIndex),
      saved ? accountClient(saved.credentials).wallet().catch(() => undefined) : Promise.resolve(undefined),
    ]);
    d.markPrice = card.price; d.triggerMarkPrice = card.mark;
    if (wallet) { const account = wallet.as?.find(x => !x.fr) ?? wallet.as?.[0]; if (account) d.availableMargin = Math.max(0, amount(account.b) - amount(account.lb)); }
    const activeMessageId = await edit(ctx, `${card.text}\n\n${orderSetupText(d)}`, orderSetupKeyboard(d, card.steps, card.groupIndex));
    d.menuMessageId = activeMessageId;
    if (activeMessageId) activateLiveBook(chatId, { marketId: market.id, messageId: activeMessageId, groupIndex: card.groupIndex, card });
    saveDrafts();
  } catch (error: any) {
    console.error("Could not open order card", chatId, error);
    await edit(ctx, `<b>Could not load the order book</b>\n\n${escape(error instanceof Error ? error.message : error)}`, new InlineKeyboard().text({ text: "Back", style: "primary" }, `trade:market:${market.id}`).text({ text: "Menu", style: "primary" }, "home"));
  } finally { chartTransitions.delete(chatId); }
});
bot.callbackQuery("trade:close_setup", async ctx => {
  await ctx.answerCallbackQuery();
  const d = tradeKey(ctx.chat!.id), messageId = ctx.callbackQuery.message?.message_id, view = liveBooks.get(ctx.chat!.id);
  d.awaiting = undefined; d.side = undefined; d.sizeUsd = undefined; d.sizeCoin = undefined; d.margin = undefined; d.leverage = undefined; d.orderType = undefined; d.takeProfit = undefined; d.stopLoss = undefined; d.menuMessageId = messageId;
  if (!view || !d.marketId) return edit(ctx, "Order setup closed.", new InlineKeyboard().text({ text: "Trade", style: "success" }, "trade:start").text({ text: "Menu", style: "primary" }, "home"));
  const market = (await perpl.markets()).find(item => item.id === d.marketId); if (!market) return;
  stopLiveBook(ctx.chat!.id);
  const timeframe = d.chartTimeframe ?? "1h";
  const chartMessageId = await showMarketChart(ctx, market, timeframe);
  d.menuMessageId = chartMessageId;
  if (chartMessageId) activateLiveBook(ctx.chat!.id, { marketId: market.id, messageId: chartMessageId, groupIndex: view.groupIndex, chartTimeframe: timeframe });
  saveDrafts();
});
bot.callbackQuery(/^trade:type:(market|limit)$/, async ctx => {
  await ctx.answerCallbackQuery();
  const d = tradeKey(ctx.chat!.id), choice = ctx.match[1]; d.orderType = choice as TradeDraft["orderType"]; d.postOnly = false; d.menuMessageId = ctx.callbackQuery.message?.message_id;
  if (d.orderType === "market") { if (d.inputMessageId) { try { await bot.api.deleteMessage(ctx.chat!.id, d.inputMessageId); } catch {} d.inputMessageId = undefined; } d.limitPrice = undefined; d.awaiting = undefined; return showOrderSetup(ctx); }
  d.awaiting = undefined;
  await showOrderSetup(ctx);
});
bot.callbackQuery("trade:book:toggle", async ctx => { await ctx.answerCallbackQuery({ text: "Tap the order-book quote to expand or collapse it" }); const d = tradeKey(ctx.chat!.id); if (d.awaiting && !d.inputMessageId) await showOrderInput(ctx, d); else await showOrderSetup(ctx); });
bot.callbackQuery("trade:post:toggle", async ctx => { await ctx.answerCallbackQuery(); const d = tradeKey(ctx.chat!.id); d.menuMessageId = ctx.callbackQuery.message?.message_id; if (d.orderType !== "limit") { d.orderType = "limit"; d.postOnly = true; d.awaiting = undefined; await showOrderSetup(ctx); return; } d.postOnly = !d.postOnly; await showOrderSetup(ctx); });
bot.callbackQuery(/^trade:sizeunit:(usd|coin)$/, async ctx => { await ctx.answerCallbackQuery(); const d = tradeKey(ctx.chat!.id); d.sizeUnit = ctx.match[1] as "usd" | "coin"; if (d.awaiting === "size") return showOrderInput(ctx, d); await showOrderSetup(ctx); });
bot.callbackQuery("trade:setup", async ctx => { await ctx.answerCallbackQuery(); const d = tradeKey(ctx.chat!.id); if (d.inputMessageId) { try { await bot.api.deleteMessage(ctx.chat!.id, d.inputMessageId); } catch {} d.inputMessageId = undefined; } await clearInputError(ctx.chat!.id, d); d.awaiting = undefined; d.menuMessageId = ctx.callbackQuery.message?.message_id ?? d.menuMessageId; const view = liveBooks.get(ctx.chat!.id); if (view) activateLiveBook(ctx.chat!.id, { ...view, review: false }); await restoreOrderSetup(ctx.chat!.id, d); });
bot.callbackQuery("trade:clear", async ctx => { await ctx.answerCallbackQuery({ text: "Order fields cleared" }); const d = tradeKey(ctx.chat!.id); if (d.inputMessageId) { try { await bot.api.deleteMessage(ctx.chat!.id, d.inputMessageId); } catch {} } await clearInputError(ctx.chat!.id, d); Object.assign(d, { leverage: undefined, sizeUsd: undefined, sizeCoin: undefined, margin: undefined, orderType: undefined, postOnly: undefined, limitPrice: undefined, takeProfit: undefined, stopLoss: undefined, awaiting: undefined, inputMessageId: undefined, previewFee: undefined }); saveDrafts(); await showOrderSetup(ctx); });
bot.callbackQuery(/^trade:setmargin:(5|10|25|50|100)$/, async ctx => { await ctx.answerCallbackQuery(); const d = tradeKey(ctx.chat!.id); d.margin = Number(ctx.match[1]); d.awaiting = undefined; await showOrderSetup(ctx); });
bot.callbackQuery("trade:leverage", async ctx => { await ctx.answerCallbackQuery(); const d = tradeKey(ctx.chat!.id); if (!d.symbol || !d.side) return showOrderSetup(ctx); d.menuMessageId = ctx.callbackQuery.message?.message_id; if (d.leverage) { d.leverage = undefined; d.margin = undefined; d.awaiting = undefined; saveDrafts(); return showOrderSetup(ctx); } d.awaiting = "leverage"; await askOrderValue(ctx, d); });
bot.callbackQuery(/^trade:setlev:(\d+)$/, async ctx => { await ctx.answerCallbackQuery(); const d = tradeKey(ctx.chat!.id), leverage = Number(ctx.match[1]); if (leverage < 1 || leverage > (d.maxLeverage ?? 100)) return; d.leverage = leverage; if (d.sizeUsd) d.margin = d.sizeUsd / leverage; d.awaiting = undefined; await showOrderSetup(ctx); });
bot.callbackQuery("trade:max:size", async ctx => { await ctx.answerCallbackQuery({ text: "Calculating Max…" }); const d = tradeKey(ctx.chat!.id), saved = await users.get(ctx.chat!.id); if (!d.leverage) return showOrderSetup(ctx, "Choose leverage before using Max."); if (!saved || !d.symbol) return showOrderSetup(ctx, "Perpl account is not connected."); try { const [market, wallet] = await Promise.all([perpl.market(d.symbol), accountClient(saved.credentials).wallet()]), account = wallet.as?.find(x => !x.fr) ?? wallet.as?.[0]; if (!account) throw new Error("No active Perpl account found"); const available = Math.max(0, amount(account.b) - amount(account.lb)), maker = d.orderType === "limit" && d.postOnly === true, feeRate = ((maker ? market.config.maker_fees?.[account.ft] ?? market.config.maker_fee : market.config.taker_fees?.[account.ft] ?? market.config.taker_fee) ?? 0) / 1_000_000, size = Math.max(0, Math.floor(((available * 0.99) / (1 / d.leverage + feeRate)) * 100) / 100); d.availableMargin = available; d.sizeUsd = size; d.margin = size / d.leverage; await showOrderSetup(ctx, "Maximum size includes the Perpl reserve."); } catch (error) { await showOrderSetup(ctx, `Could not calculate Max: ${escape(error instanceof Error ? error.message : error)}`); } });
  bot.callbackQuery("trade:custom:size", async ctx => { await ctx.answerCallbackQuery(); const d = tradeKey(ctx.chat!.id); if (!d.symbol || !d.side) return showOrderSetup(ctx); d.menuMessageId = ctx.callbackQuery.message?.message_id; if (d.sizeUsd) { d.sizeUsd = undefined; d.sizeCoin = undefined; d.margin = undefined; d.awaiting = undefined; saveDrafts(); return showOrderSetup(ctx); } const saved = await users.get(ctx.chat!.id); if (!saved) return showOrderSetup(ctx, "Perpl account is not connected."); try { const market = await perpl.market(d.symbol), [wallet, book] = await Promise.all([accountClient(saved.credentials).wallet(), perpl.book(market, 20)]), account = wallet.as?.find(x => !x.fr) ?? wallet.as?.[0]; if (!account) throw new Error("No active Perpl account found"); const price = bookQuote(market, book).mid, available = Math.max(0, amount(account.b) - amount(account.lb)), maker = d.orderType === "limit" && d.postOnly === true, feeRate = ((maker ? market.config.maker_fees?.[account.ft] ?? market.config.maker_fee : market.config.taker_fees?.[account.ft] ?? market.config.taker_fee) ?? 0) / 1_000_000, protocolMin = (MIN_SCALED_ORDER_SIZE / 10 ** market.config.size_decimals) * price, leverageForRange = d.leverage ?? d.maxLeverage ?? 1, max = Math.max(0, Math.floor(((available * 0.99) / (1 / leverageForRange + feeRate)) * 100) / 100); d.markPrice = price; d.sizeDecimals = market.config.size_decimals; d.availableMargin = available; d.maxSizeUsd = max; d.minSizeUsd = Math.max(0.01, Math.ceil(protocolMin * 100) / 100); d.awaiting = "size"; await askOrderValue(ctx, d); } catch (error) { await showOrderSetup(ctx, `Could not calculate size range: ${escape(error instanceof Error ? error.message : error)}`); } });
bot.callbackQuery("trade:custom:price", async ctx => { const d = tradeKey(ctx.chat!.id); if (d.orderType !== "limit") { await ctx.answerCallbackQuery({ text: "Price is used for Limit orders" }); return; } await ctx.answerCallbackQuery(); if (!d.symbol || !d.side) return showOrderSetup(ctx); d.menuMessageId = ctx.callbackQuery.message?.message_id; d.awaiting = "price"; await askOrderValue(ctx, d); await showOrderSetup(ctx); });
bot.callbackQuery(/^trade:custom:(margin|leverage|tp|sl)$/, async ctx => { await ctx.answerCallbackQuery(); const d = tradeKey(ctx.chat!.id); if (!d.symbol || !d.side) return showOrderSetup(ctx); const field = ctx.match[1] as "margin" | "leverage" | "tp" | "sl"; d.menuMessageId = ctx.callbackQuery.message?.message_id; if ((field === "tp" && d.takeProfit) || (field === "sl" && d.stopLoss)) { if (field === "tp") d.takeProfit = undefined; else d.stopLoss = undefined; d.awaiting = undefined; saveDrafts(); return showOrderSetup(ctx); } d.awaiting = field; if (d.awaiting === "leverage" || d.awaiting === "tp" || d.awaiting === "sl") { if (d.symbol) { try { const market = await perpl.market(d.symbol); d.triggerMarkPrice = priceOf(market, await perpl.ticker(market)); } catch {} } return askOrderValue(ctx, d); } await showOrderSetup(ctx); });
bot.callbackQuery(/^trade:max:(margin|leverage|both)$/, async ctx => {
  await ctx.answerCallbackQuery({ text: "Calculating maximum…" });
  const d = tradeKey(ctx.chat!.id), saved = await users.get(ctx.chat!.id);
  if (!saved || !d.symbol) return edit(ctx, "Order session expired.", backHome());
  try {
    const [market, wallet] = await Promise.all([perpl.market(d.symbol), accountClient(saved.credentials).wallet()]), account = wallet.as?.find(x => !x.fr) ?? wallet.as?.[0];
    if (!account) throw new Error("No active Perpl account found");
    const mode = ctx.match[1], maxLeverage = maxLeverageOf(market);
    if (mode === "leverage" || mode === "both") d.leverage = maxLeverage;
    const maker = d.orderType === "limit" && d.postOnly === true, feeRate = ((maker ? market.config.maker_fees?.[account.ft] ?? market.config.maker_fee : market.config.taker_fees?.[account.ft] ?? market.config.taker_fee) ?? 0) / 1_000_000;
    const available = Math.max(0, amount(account.b) - amount(account.lb));
    if (mode === "margin" && !d.leverage) return showOrderSetup(ctx, "Enter leverage before using Max margin.");
    const leverage = d.leverage ?? maxLeverage;
    if (mode === "margin" || mode === "both") d.margin = Math.max(0, Math.floor((available / (1 + leverage * feeRate) - 0.01) * 100) / 100);
    d.awaiting = undefined;
    await showOrderSetup(ctx, mode === "leverage" ? `Market maximum: <b>${maxLeverage}x</b>` : `Using available balance: <b>${usd(available)}</b>`);
  } catch (error) { await showOrderSetup(ctx, `Could not calculate maximum: ${escape(error instanceof Error ? error.message : error)}`); }
});
bot.callbackQuery("trade:review", async ctx => {
  await ctx.answerCallbackQuery();
  const d = tradeKey(ctx.chat!.id);
  d.menuMessageId = ctx.callbackQuery.message?.message_id ?? d.menuMessageId;
  const sendReview = async (text: string, keyboard: InlineKeyboard, liveReview = false) => {
    if (d.reviewMessageId) { try { await bot.api.deleteMessage(ctx.chat!.id, d.reviewMessageId); } catch {} }
    const sent = await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    d.reviewMessageId = sent.message_id;
    d.reviewActive = liveReview;
    saveDrafts();
    return sent.message_id;
  };
  if (!d.sizeUsd) { d.awaiting = "size"; return askOrderValue(ctx, d); }
  if (!d.leverage) { d.awaiting = "leverage"; return askOrderValue(ctx, d); }
  d.margin = d.sizeUsd / d.leverage;
  if (!d.orderType) return ctx.reply("Choose Market or Limit in the order card.");
  if (d.orderType === "limit" && !d.limitPrice) return ctx.reply("<b>Set a limit price first</b>\n\nPress Price in the order card.", { parse_mode: "HTML" });
  const saved = await users.get(ctx.chat!.id);
  if (!saved) return sendReview("Account is not connected.", backHome());
  const m = await perpl.market(d.symbol!), [wallet, book, ticker] = await Promise.all([accountClient(saved.credentials).wallet(), perpl.book(m, 100), perpl.ticker(m)]), account = wallet.as?.find(x => !x.fr) ?? wallet.as?.[0];
  if (!account) return sendReview("No active Perpl account found.", backHome());
  const quote = bookQuote(m, book), mark = quote.mid, bid = quote.bid, ask = quote.ask, limitPrice = d.limitPrice!, notional = d.margin * d.leverage, size = notional / (d.orderType === "market" ? mark : limitPrice), spread = mark ? (ask - bid) / mark * 10_000 : 0, maxLev = maxLeverageOf(m), available = amount(account.b) - amount(account.lb), maker = d.orderType === "limit" && d.postOnly === true, feeRate = ((maker ? m.config.maker_fees?.[account.ft] ?? m.config.maker_fee : m.config.taker_fees?.[account.ft] ?? m.config.taker_fee) ?? 0) / 1_000_000, fee = notional * feeRate, required = d.margin + Math.max(0, fee);
  const back = new InlineKeyboard().text({ text: "Back", style: "primary" }, "trade:review:cancel").text({ text: "Menu", style: "primary" }, "home");
  if (d.leverage > maxLev) return sendReview(`Maximum leverage for ${d.symbol} is ${maxLev}x.`, back);
  if (required > available) return sendReview(`<b>Not enough available margin</b>\n\nRequired: ${usd(required)}\nAvailable: ${usd(available)}`, back);
  if (spread > 100) return sendReview(`<b>Spread is too wide</b>\n\nCurrent spread: ${spread.toFixed(1)} bps\nSafety limit: 100 bps`, back);
  if (d.postOnly && d.side === "long" && limitPrice >= ask) return sendReview(`<b>Post-only price would fill immediately</b>\n\nFor LONG, enter a price below the best ask ${money(ask)}.\nTry ${money(bid)} or lower.`, back);
  if (d.postOnly && d.side === "short" && limitPrice <= bid) return sendReview(`<b>Post-only price would fill immediately</b>\n\nFor SHORT, enter a price above the best bid ${money(bid)}.\nTry ${money(ask)} or higher.`, back);
  const reference = d.orderType === "market" ? mark : limitPrice;
  if (d.takeProfit && (d.side === "long" ? d.takeProfit <= reference : d.takeProfit >= reference)) return sendReview(`Take profit must be ${d.side === "long" ? "above" : "below"} the entry price.`, back);
  if (d.stopLoss && (d.side === "long" ? d.stopLoss >= reference : d.stopLoss <= reference)) return sendReview(`Stop loss must be ${d.side === "long" ? "below" : "above"} the entry price.`, back);
  d.previewFee = fee;
  d.markPrice = mark;
  d.triggerMarkPrice = priceOf(m, ticker);
  await sendReview(confirmationText(d, m, mark, d.triggerMarkPrice), confirmationKeyboard(), true);
});

bot.callbackQuery("trade:review:cancel", async ctx => {
  await ctx.answerCallbackQuery();
  const d = drafts.get(ctx.chat!.id);
  try { await ctx.deleteMessage(); } catch {}
  if (!d) return;
  d.reviewMessageId = undefined;
  d.reviewActive = false;
  saveDrafts();
  await restoreOrderSetup(ctx.chat!.id, d);
});

bot.callbackQuery("trade:confirm", async ctx => {
  const chatId = ctx.chat!.id;
  if (ordersInFlight.has(chatId)) return ctx.answerCallbackQuery({ text: "Order already in progress" });
  await ctx.answerCallbackQuery({ text: "Checking order…" });
  stopLiveBook(chatId);
  const d = drafts.get(chatId), saved = await users.get(chatId);
  if (!saved || !d?.symbol || !d.side || !d.margin || !d.leverage || !d.orderType) return edit(ctx, "Order session expired.", backHome());
  ordersInFlight.add(chatId);
  try {
    const client = accountClient(saved.credentials);
    const [wallet, market] = await Promise.all([client.wallet(), perpl.market(d.symbol)]);
    const account = wallet.as?.find(x => !x.fr && x.fw);
    if (!account) throw new Error("No active account with order forwarding enabled");
    if (!market.config.is_open) throw new Error("This market is closed");
    const [book, ticker] = await Promise.all([perpl.book(market, 100), perpl.ticker(market)]), quote = bookQuote(market, book);
    const mark = quote.mid;
    const protocolMark = priceOf(market, ticker);
    const bid = quote.bid;
    const ask = quote.ask;
    if (!Number.isFinite(mark) || mark <= 0 || bid <= 0 || ask <= 0 || ask < bid) throw new Error("Live quote is unavailable");
    const spreadBps = (ask - bid) / mark * 10_000;
    if (spreadBps > 100) throw new Error(`Spread is now ${spreadBps.toFixed(1)} bps; order cancelled`);
    const maxLeverage = maxLeverageOf(market);
    if (d.leverage > maxLeverage) throw new Error(`Maximum leverage is ${maxLeverage}x`);
    const notional = d.margin * d.leverage, maker = d.orderType === "limit" && d.postOnly === true;
    const feeRate = ((maker ? market.config.maker_fees?.[account.ft] ?? market.config.maker_fee : market.config.taker_fees?.[account.ft] ?? market.config.taker_fee) ?? 0) / 1_000_000;
    const available = amount(account.b) - amount(account.lb);
    if (d.margin + notional * feeRate > available) throw new Error("Available margin changed; review the order again");
    if (d.orderType === "limit" && !d.limitPrice) throw new Error("Limit price is missing");
    const rawPrice = d.orderType === "market" ? mark : d.limitPrice!;
    if (d.postOnly && d.side === "long" && rawPrice >= ask) throw new Error(`Post-only LONG must be below the best ask ${money(ask)}. Try ${money(bid)} or lower.`);
    if (d.postOnly && d.side === "short" && rawPrice <= bid) throw new Error(`Post-only SHORT must be above the best bid ${money(bid)}. Try ${money(ask)} or higher.`);
    const limitPrice = d.orderType === "market" ? 0 : Math.round(rawPrice * 10 ** market.config.price_decimals);
    const executionPrice = d.orderType === "market" ? mark : rawPrice;
    if (d.takeProfit && (d.side === "long" ? d.takeProfit <= protocolMark : d.takeProfit >= protocolMark)) throw new Error(`TP must be ${d.side === "long" ? "above" : "below"} Mark ${money(protocolMark)} for ${d.side.toUpperCase()}.`);
    if (d.stopLoss && (d.side === "long" ? d.stopLoss >= protocolMark : d.stopLoss <= protocolMark)) throw new Error(`SL must be ${d.side === "long" ? "below" : "above"} Mark ${money(protocolMark)} for ${d.side.toUpperCase()}.`);
    const size = scaledOrderSize(notional, executionPrice, market.config.size_decimals);
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Order size is invalid for this market");
    if (size < MIN_SCALED_ORDER_SIZE) throw new Error(`Order is below ${d.symbol}'s minimum size. Increase margin or leverage.`);
    const rq = Math.max(Date.now(), Number(account.lfr ?? 0) + 1);
    const order = openOrder({ rq, market: market.id, account: account.id, side: d.side, size, leverage: d.leverage, type: d.orderType, postOnly: d.postOnly, price: limitPrice });
    let outcome = await submitOrder(liveFor(chatId, saved.credentials), client, order);
    if (outcome.st === 2) {
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 750));
        const updates = await client.orderHistory(20);
        const update = updates.find(item => (outcome.oid && item.oid === outcome.oid) || item.rq === order.rq);
        if (!update) continue;
        outcome = update;
        if (outcome.st !== 2) break;
      }
    }
    const filled = outcome.st === 4 || outcome.st === 10;
    let linkedPosition: Position | undefined;
    if (filled) {
      linkedPosition = (await client.positions()).find(position => position.st === 1 && position.acc === account.id && position.mkt === market.id);
    }
    const protection: string[] = [];
    for (const [kind, trigger] of [["tp", d.takeProfit], ["sl", d.stopLoss]] as const) {
      if (!trigger) continue;
      const triggerOrder = triggerCloseOrder({ rq: rq + (kind === "tp" ? 1 : 2), market: market.id, account: account.id, side: d.side, size, leverage: d.leverage, triggerPrice: Math.round(trigger * 10 ** market.config.price_decimals), kind, linkedPosition: linkedPosition?.pid, linkedRequest: linkedPosition ? undefined : rq });
      try { const placed = await submitProtection(liveFor(chatId, saved.credentials), client, triggerOrder); protection.push(`${kind.toUpperCase()} ${money(trigger)} ${placed.pending ? "· Pending ✅" : "✅"}`); }
      catch (error) { protection.push(`${kind.toUpperCase()} ${money(trigger)} failed: ${escape(error instanceof Error ? error.message : error)}`); }
    }
    if (protection.length) { try { await baselineProtections(chatId, client); } catch {} }
    drafts.delete(chatId);
    try { await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }); } catch {}
    if (d.menuMessageId) { try { await bot.api.deleteMessage(chatId, d.menuMessageId); } catch {} }
    const protectionFailures = protection.filter(line => line.includes("failed:"));
    if (filled) {
      if (protectionFailures.length) await ctx.reply(`<b>Could not add protection</b>\n\n${protectionFailures.join("\n")}`, { parse_mode: "HTML" });
    } else {
      await ctx.reply(`<b>${outcome.st === 2 ? "Limit order placed ✅" : "Order update received"}</b>\n\n${d.side.toUpperCase()} ${d.symbol} - ${d.leverage}x - ${`${d.orderType.toUpperCase()}${d.postOnly ? " · POST-ONLY" : ""}`}\nStatus: ${outcome.st === 2 ? "Open" : `Perpl status ${outcome.st}`}${protection.length ? `\n${protection.join("\n")}` : ""}`, { parse_mode: "HTML" });
      await sendMainMenu(chatId);
    }
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error), message = d?.postOnly && /reason 13/i.test(rawMessage) ? "Post-only order would have filled immediately. Choose a price that stays in the order book, then try again." : rawMessage;
    drafts.delete(chatId);
    await edit(ctx, `<b>Order was not confirmed</b>\n\n${escape(message)}`, new InlineKeyboard().text({ text: "Trade", style: "success" }, "trade:start").row().text("📌 Positions", "positions").text("📋 Orders", "orders").row().text({ text: "Menu", style: "primary" }, "home"));
  } finally {
    stopLiveBook(chatId);
    if (d?.menuMessageId) { try { await bot.api.deleteMessage(chatId, d.menuMessageId); } catch {} }
    ordersInFlight.delete(chatId);
  }
});
bot.callbackQuery("alerts:menu", async ctx => { await ctx.answerCallbackQuery(); const view = await alertsView(ctx.chat!.id); await edit(ctx, view.text, view.keyboard); });
bot.callbackQuery(/^alert:delete:(\d+)$/, async ctx => { const id = Number(ctx.match[1]), removed = await alerts.remove(ctx.chat!.id, id); await ctx.answerCallbackQuery({ text: removed ? "Alert canceled" : "Alert is no longer active" }); const view = await alertsView(ctx.chat!.id); await edit(ctx, view.text, view.keyboard); });
bot.callbackQuery("settings", async ctx => {
  await ctx.answerCallbackQuery();
  const saved = await users.get(ctx.chat!.id), kb = new InlineKeyboard();
  if (!saved) return edit(ctx, `${menuEmoji("settings")} <b>SETTINGS</b>\n\nNo Perpl account connected.`, new InlineKeyboard().text({ text: "Connect Perpl", style: "primary" }, "connect:start").row().text({ text: "Back", style: "primary" }, "home"));
  try {
    const wallet = await accountClient(saved.credentials).wallet();
    kb.text("Replace API key", "settings:replace").row().text({ text: "Disconnect account", style: "danger" }, "settings:disconnect:ask").row().text({ text: "Back", style: "primary" }, "home");
    await edit(ctx, `${menuEmoji("settings")} <b>SETTINGS</b>\n\n👛 <b>Wallet</b>\n${escape(wallet.addr)}\n\n🔗 <b>API key:</b> Active`, kb);
  } catch (error) {
    await edit(ctx, `${menuEmoji("settings")} <b>SETTINGS</b>\n\nCould not load the connected wallet.\n${escape(error instanceof Error ? error.message : error)}`, new InlineKeyboard().text("Replace API key", "settings:replace").row().text({ text: "Disconnect account", style: "danger" }, "settings:disconnect:ask").row().text({ text: "Back", style: "primary" }, "home"));
  }
});
bot.callbackQuery("settings:replace", async ctx => { await ctx.answerCallbackQuery(); const messageId = ctx.callbackQuery.message!.message_id; connectDrafts.set(ctx.chat!.id, { step: "key", messageId }); await edit(ctx, `<b>REPLACE PERPL KEY</b>\n\nOpen Perpl, create a Trading key and send the value labeled API Key. Your message is deleted immediately.`, new InlineKeyboard().url("Open Perpl", "https://app.perpl.xyz/apikeys").row().text({ text: "Cancel", style: "primary" }, "settings")); });
bot.callbackQuery("settings:disconnect:ask", async ctx => { await ctx.answerCallbackQuery(); await edit(ctx, `<b>Disconnect this account?</b>\n\nThe encrypted API credentials will be deleted from the bot.`, new InlineKeyboard().text({ text: "Disconnect", style: "danger" }, "settings:disconnect:confirm").row().text({ text: "Back", style: "primary" }, "settings")); });
bot.callbackQuery("settings:disconnect:confirm", async ctx => { await ctx.answerCallbackQuery(); liveStreams.get(ctx.chat!.id)?.stop(); liveStreams.delete(ctx.chat!.id); await users.disconnect(ctx.chat!.id); await edit(ctx, `<b>Account disconnected</b>\n\nStored API credentials were deleted.`, backHome()); });

async function checkAlerts() {
  const all = await alerts.list(); if (!all.length) return;
  try { const markets = await perpl.markets(), states = await perpl.tickers(), fired = new Set<number>();
    for (const item of all) { const m = markets.find(x => marketSymbol(x) === item.symbol); if (!m) continue; const price = priceOf(m, states[String(m.id)] ?? m.state!);
      if ((item.direction === "above" && price >= item.price) || (item.direction === "below" && price <= item.price)) { try { await bot.api.sendMessage(item.chatId, `🔔 <b>${item.symbol}</b> is ${item.direction} ${money(item.price)}\nCurrent mark: ${money(price)}`, { parse_mode: "HTML" }); fired.add(item.id); } catch (e) { console.error("Could not send alert", item.id, e); } }
    } await alerts.consume(fired);
  } catch (e) { console.error("Alert check failed", e); }
}

async function checkPositionEvents() {
  for (const user of await users.all()) {
    if (accountAuthBlocked.has(user.row.chatId)) continue;
    if (!user.row.alerts) continue;
    try {
      const history = await accountClient(user.credentials).history(20);
      if (!history.length) continue;
      const newest = eventId(history[0]);
      if (!user.row.lastEvent) { await users.baseline(user.row.chatId, newest); continue; }
      const cursor = history.findIndex(event => eventId(event) === user.row.lastEvent);
      // A missing cursor must establish a new baseline, never replay old history.
      if (cursor < 0) { await users.baseline(user.row.chatId, newest); continue; }
      const fresh = freshEvents(history, user.row.lastEvent, eventId);
      for (const event of fresh) if (![17, 21].includes(event.sr)) await notifyPosition(user.row.chatId, event);
      if (fresh.length) await users.baseline(user.row.chatId, newest);
    } catch (error) { await handleAccountWatcherError(user.row.chatId, "Position", error); }
  }
}

async function checkFilledOrders() {
  for (const user of await users.all()) {
    if (accountAuthBlocked.has(user.row.chatId)) continue;
    if (!user.row.alerts) continue;
    try {
      const filled = (await accountClient(user.credentials).orderHistory(40)).filter(order => [4, 10].includes(order.st) && [1, 2].includes(order.t));
      if (!filled.length) continue;
      const newest = orderEventId(filled[0]);
      if (!user.row.lastOrderEvent) { await users.baselineOrder(user.row.chatId, newest); continue; }
      const cursor = filled.findIndex(order => orderEventId(order) === user.row.lastOrderEvent);
      if (cursor < 0) { await users.baselineOrder(user.row.chatId, newest); continue; }
      for (const order of filled.slice(0, cursor).reverse()) await notifyFilledOrder(user.row.chatId, order);
      if (cursor > 0) await users.baselineOrder(user.row.chatId, newest);
    } catch (error) { await handleAccountWatcherError(user.row.chatId, "Filled order", error); }
  }
}

async function checkProtectionChanges() {
  const markets = await perpl.markets();
  for (const user of await users.all()) {
    if (accountAuthBlocked.has(user.row.chatId)) continue;
    if (!user.row.alerts) continue;
    try {
      const client = accountClient(user.credentials), [orders, positions] = await Promise.all([client.orders(), client.positions()]);
      const activeOrders = orders.filter(order => [1, 2, 3, 8, 9].includes(order.st));
      const currentItems = activeOrders.filter(order => order.tp).map(protectionSnapshot);
      const current = new Map(currentItems.map(item => [item.key, item]));
      const previous = protectionSnapshots.get(user.row.chatId);
      if (!previous) { protectionSnapshots.set(user.row.chatId, current); continue; }
      const openPositionIds = new Set(positions.filter(position => position.st === 1).map(position => position.pid));
      const activeRequests = new Set(activeOrders.map(order => order.rq));
      for (const item of previous.values()) {
        if (current.has(item.key)) continue;
        const targetStillActive = item.linkedPosition ? openPositionIds.has(item.linkedPosition) : item.linkedRequest ? activeRequests.has(item.linkedRequest) : false;
        if (!targetStillActive) continue;
        const market = markets.find(value => value.id === item.marketId), symbol = market ? marketSymbol(market) : `Market ${item.marketId}`, price = market ? scaled(item.trigger, market.config.price_decimals) : item.trigger;
        await bot.api.sendMessage(user.row.chatId, `🗑 <b>${item.kind} canceled</b>\n\n${market ? marketEmoji(symbol) : ""} <b>${symbol}</b>  ${money(price)}`, { parse_mode: "HTML" });
      }
      protectionSnapshots.set(user.row.chatId, current);
    } catch (error) { await handleAccountWatcherError(user.row.chatId, "Protection", error); }
  }
}

bot.catch(error => console.error("Telegram update failed", error.error));
await alerts.load(); await users.load();
for (const user of await users.all()) {
  liveFor(user.row.chatId, user.credentials);
  void accountClient(user.credentials).positions().then(positions => positions.filter(position => position.st === 1).forEach(position => rememberPosition(user.row.chatId, position))).catch(() => {});
}
setInterval(() => void checkAlerts(), 10_000).unref();
setInterval(() => void refreshLiveBooks(), 2_000).unref();
setInterval(() => void refreshLivePositionViews(), 2_000).unref();
setInterval(() => void checkPositionEvents(), 30_000).unref();
setInterval(() => void checkFilledOrders(), 30_000).unref();
setInterval(() => void checkProtectionChanges(), 10_000).unref();
await bot.api.setMyCommands([{ command: "menu", description: "Open TradePerpl" }]);
await bot.start({ onStart: info => console.log(`@${info.username} started`) });

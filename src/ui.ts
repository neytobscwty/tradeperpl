import { InlineKeyboard } from "grammy";

export function mainMenu(icons: Record<string, string> = {}) {
  const button = (key: string, text: string, fallback: string) => icons[key] ? { text, icon_custom_emoji_id: icons[key] } : `${fallback} ${text}`;
  return new InlineKeyboard()
    .text({ text: "Trade", style: "success" }, "trade:start").row()
    .text(button("positions", "Positions", "📌"), "positions").text(button("orders", "Orders", "📋"), "orders").row()
    .text(button("portfolio", "Portfolio", "💼"), "portfolio").row()
    .text(button("alerts", "Alerts", "🔔"), "alerts:menu").text(button("settings", "Settings", "⚙"), "settings").row()
    .text({ text: "Refresh", style: "primary" }, "home");
}

export const isPositionExitEvent = (reason: number) => [13, 14, 22].includes(reason);

export const orderStatus = (status: number) => ({
  1: "Pending", 2: "Open", 3: "Partial", 4: "Filled", 5: "Canceled",
  6: "Expired", 7: "Failed", 10: "Executed",
} as Record<number, string>)[status] ?? `Status ${status}`;

export const orderSide = (type: number) => ({
  1: "Long", 2: "Short", 3: "Close long", 4: "Close short",
} as Record<number, string>)[type] ?? "Order";

export const protectionKind = (order: { t: number; tpc?: number }) => ((order.t === 3 && order.tpc === 3) || (order.t === 4 && order.tpc === 4)) ? "TP" : "SL";

export function positionCloseOrder<T extends { oid: number; lp?: number; tp?: number; st: number }>(position: { pid: number; oid?: number }, orders: T[]) {
  const direct = position.oid ? orders.find(order => order.oid === position.oid) : undefined;
  if (direct?.tp) return direct;
  return orders.find(order => order.lp === position.pid && order.tp && order.st === 10) ?? direct;
}

export function settledPnl(position: { dpnl?: string; fnd?: string; fee: string; xp?: number }) {
  return (Number(position.dpnl ?? 0) + Number(position.fnd ?? 0) - (position.xp !== undefined ? Number(position.fee) : 0)) / 1e6;
}

export function closedPositionNotional(input: { positionSize: number; filledOrderSize?: number; orderSize?: number; sizeDecimals: number; exitPrice: number; entryPrice: number; collateral: number; leverage: number }) {
  const scaledSize = [input.positionSize, input.filledOrderSize ?? 0, input.orderSize ?? 0].find(value => value > 0) ?? 0;
  const price = input.exitPrice || input.entryPrice;
  if (scaledSize > 0 && price > 0) return scaledSize / 10 ** input.sizeDecimals * price;
  return Math.abs(input.collateral) * Math.max(1, input.leverage / 100);
}

export function orderRisk(input: { entry: number; size: number; margin: number; maintenanceMargin: number; side: "long" | "short"; takeProfit?: number; stopLoss?: number }) {
  const direction = input.side === "long" ? 1 : -1;
  const notional = input.entry * input.size;
  const liquidationMove = input.size > 0 ? Math.max(0, input.margin - notional * input.maintenanceMargin) / input.size : 0;
  return {
    liquidation: input.side === "long" ? Math.max(0, input.entry - liquidationMove) : input.entry + liquidationMove,
    takeProfitPnl: input.takeProfit === undefined ? undefined : (input.takeProfit - input.entry) * input.size * direction,
    stopLossPnl: input.stopLoss === undefined ? undefined : (input.stopLoss - input.entry) * input.size * direction,
  };
}
export function freshEvents<T>(history: T[], cursor: string, id: (event: T) => string): T[] {
  const index = history.findIndex(event => id(event) === cursor);
  return index < 0 ? [] : history.slice(0, index).reverse();
}

import type { OrderSpec, Position } from "./personal.js";

export const MIN_SCALED_ORDER_SIZE = 1;
export const SCALED_ORDER_STEP = 1;

export function scaledOrderSize(notionalUsd: number, price: number, sizeDecimals: number) {
  const raw = Math.floor((notionalUsd / price) * 10 ** sizeDecimals);
  return Math.floor(raw / SCALED_ORDER_STEP) * SCALED_ORDER_STEP;
}

export function closeSize(positionSize: number, percent: 25 | 50 | 75 | 100) {
  if (percent === 100) return positionSize;
  return Math.floor((positionSize * percent / 100) / SCALED_ORDER_STEP) * SCALED_ORDER_STEP;
}

export function openOrder(input: { rq: number; market: number; account: number; side: "long" | "short"; size: number; leverage: number; type: "market" | "limit"; postOnly?: boolean; price?: number }): OrderSpec {
  return { rq: input.rq, mkt: input.market, acc: input.account, t: input.side === "long" ? 1 : 2, p: input.type === "market" ? 0 : input.price ?? 0, s: input.size, ms: input.type === "market" ? 100 : undefined, fl: input.type === "market" ? 4 : input.postOnly ? 1 : 0, lv: input.leverage * 100, lb: 0 };
}

export function closeOrder(rq: number, account: number, position: Position, percent: 25 | 50 | 75 | 100): OrderSpec {
  return { rq, mkt: position.mkt, acc: account, t: position.sd === 1 ? 3 : 4, p: 0, s: closeSize(position.s, percent), ms: 100, fl: 4, lv: position.lv, lp: position.pid, lb: 0 };
}

export function cancelOrder(rq: number, account: number, order: { oid: number; mkt: number; os: number; fl?: number; lv?: number; tp?: number; tpc?: number; lp?: number }): OrderSpec {
  return { rq, mkt: order.mkt, acc: account, oid: order.oid, t: 5, s: 0, fl: order.fl ?? 0, lv: order.lv ?? 0, tp: order.tp, tpc: order.tpc, lp: order.lp, lb: 0 };
}

export function triggerCloseOrder(input: { rq: number; market: number; account: number; side: "long" | "short"; size: number; leverage: number; triggerPrice: number; kind: "tp" | "sl"; linkedRequest?: number; linkedPosition?: number }): OrderSpec {
  const triggerAbove = input.side === "long" ? input.kind === "tp" : input.kind === "sl";
  return { rq: input.rq, mkt: input.market, acc: input.account, t: input.side === "long" ? 3 : 4, p: 0, s: input.size, ms: 100, fl: 4, tp: input.triggerPrice, tpc: triggerAbove ? 3 : 4, tr: input.linkedRequest, lp: input.linkedPosition, lv: input.leverage * 100, lb: 0 };
}

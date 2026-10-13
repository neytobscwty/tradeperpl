import assert from "node:assert/strict";
import test from "node:test";
import { cancelOrder, closeOrder, closeSize, openOrder, scaledOrderSize, triggerCloseOrder } from "../src/orders.js";
import type { Position } from "../src/personal.js";

test("builds market, limit and post-only orders with Perpl protocol flags", () => {
  const base = { rq: 10, market: 1, account: 2, side: "long" as const, size: 100, leverage: 5 };
  assert.deepEqual(openOrder({ ...base, type: "market" }), { rq: 10, mkt: 1, acc: 2, t: 1, p: 0, s: 100, ms: 100, fl: 4, lv: 500, lb: 0 });
  assert.deepEqual(openOrder({ ...base, side: "short", type: "limit", price: 830000 }), { rq: 10, mkt: 1, acc: 2, t: 2, p: 830000, s: 100, ms: undefined, fl: 0, lv: 500, lb: 0 });
  assert.equal(openOrder({ ...base, type: "limit", postOnly: true, price: 820000 }).fl, 1);
});

test("calculates every partial-close option without exceeding the position", () => {
  assert.deepEqual([25, 50, 75, 100].map(p => closeSize(800, p as 25 | 50 | 75 | 100)), [200, 400, 600, 800]);
});

test("builds linked close orders for long and short positions", () => {
  const position = { mkt: 1, pid: 9, sd: 1, s: 400, lv: 800 } as Position;
  assert.deepEqual(closeOrder(11, 2, position, 25), { rq: 11, mkt: 1, acc: 2, t: 3, p: 0, s: 100, ms: 100, fl: 4, lv: 800, lp: 9, lb: 0 });
  assert.equal(closeOrder(12, 2, { ...position, sd: 2 }, 100).t, 4);
});

test("builds cancellation against the exact existing order", () => {
  assert.deepEqual(cancelOrder(20, 2, { oid: 7, mkt: 1, os: 100 }), { rq: 20, mkt: 1, acc: 2, oid: 7, t: 5, s: 0, fl: 0, lv: 0, tp: undefined, tpc: undefined, lp: undefined, lb: 0 });
  assert.deepEqual(cancelOrder(21, 2, { oid: 288887342563343, mkt: 1, os: 1, fl: 4, lv: 500, tp: 825000, tpc: 4, lp: 7412161511424 }), { rq: 21, mkt: 1, acc: 2, oid: 288887342563343, t: 5, s: 0, fl: 4, lv: 500, tp: 825000, tpc: 4, lp: 7412161511424, lb: 0 });
});

test("builds mark-price TP and SL triggers", () => {
  const base = { rq: 20, market: 1, account: 2, side: "long" as const, size: 100, leverage: 5, triggerPrice: 900000, linkedPosition: 7 };
  assert.deepEqual(triggerCloseOrder({ ...base, kind: "tp" }), { rq: 20, mkt: 1, acc: 2, t: 3, p: 0, s: 100, ms: 100, fl: 4, tp: 900000, tpc: 3, tr: undefined, lp: 7, lv: 500, lb: 0 });
  assert.equal(triggerCloseOrder({ ...base, kind: "sl" }).tpc, 4);
  assert.equal(triggerCloseOrder({ ...base, side: "short", kind: "tp" }).tpc, 4);
});

test("floors scaled order size so it never spends above the preview", () => {
  assert.equal(scaledOrderSize(90, 83_000, 5), 108);
});

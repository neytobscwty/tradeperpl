import assert from "node:assert/strict";
import test from "node:test";
import { closedPositionNotional, freshEvents, settledPnl, isPositionExitEvent, mainMenu, orderRisk, orderSide, orderStatus, positionCloseOrder, protectionKind } from "../src/ui.js";

test("main menu highlights trade and refresh without duplicating the Perpl icon", () => {
  const buttons = mainMenu({ positions: "123456789" }).inline_keyboard.flat();
  assert.equal(buttons.find(button => "callback_data" in button && button.callback_data === "trade:start")?.style, "success");
  assert.equal(buttons.find(button => "callback_data" in button && button.callback_data === "trade:start")?.icon_custom_emoji_id, undefined);
  assert.equal(buttons.find(button => "callback_data" in button && button.callback_data === "positions")?.icon_custom_emoji_id, "123456789");
  assert.equal(buttons.find(button => "callback_data" in button && button.callback_data === "history"), undefined);
  assert.equal(buttons.find(button => "callback_data" in button && button.callback_data === "home")?.style, "primary");
});

test("position exits and order history labels are classified correctly", () => {
  assert.deepEqual([13, 14, 22].map(isPositionExitEvent), [true, true, true]);
  assert.equal(isPositionExitEvent(21), false);
  assert.equal(orderStatus(5), "Canceled");
  assert.equal(orderSide(3), "Close long");
  assert.equal(protectionKind({ t: 4, tpc: 4 }), "TP");
  assert.equal(protectionKind({ t: 4, tpc: 3 }), "SL");
  const child = { oid: 20, st: 4 };
  const trigger = { oid: 10, lp: 7, tp: 830000, st: 10 };
  assert.equal(positionCloseOrder({ pid: 7, oid: 20 }, [child, trigger]), trigger);
});

test("missing history cursor never replays old closed positions", () => {
  assert.deepEqual(freshEvents(["new", "old"], "missing", x => x), []);
  assert.deepEqual(freshEvents(["new2", "new1", "old"], "old", x => x), ["new1", "new2"]);
});
test("settled PnL matches Perpl history including funding and fees", () => {
  assert.equal(settledPnl({ dpnl: "10000", fnd: "-2000", fee: "1000", xp: 835958 }), 0.007);
  assert.equal(settledPnl({ dpnl: "0", fee: "500000" }), 0);
});

test("closed position value falls back to the filled close-order size", () => {
  const value = closedPositionNotional({ positionSize: 0, filledOrderSize: 10, orderSize: 10, sizeDecimals: 6, exitPrice: 83_332, entryPrice: 83_349, collateral: 0, leverage: 100 });
  assert.ok(Math.abs(value - 0.83332) < 1e-9);
});

test("order risk previews liquidation and TP/SL outcomes", () => {
  const long = orderRisk({ entry: 100, size: 1, margin: 10, maintenanceMargin: 0.05, side: "long", takeProfit: 110, stopLoss: 95 });
  assert.deepEqual(long, { liquidation: 95, takeProfitPnl: 10, stopLossPnl: -5 });
  const short = orderRisk({ entry: 100, size: 1, margin: 10, maintenanceMargin: 0.05, side: "short", takeProfit: 90, stopLoss: 105 });
  assert.deepEqual(short, { liquidation: 105, takeProfitPnl: 10, stopLossPnl: -5 });
});

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { PerplTradingStream } from "../src/live.js";
import type { OrderSpec } from "../src/personal.js";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: (event: { code: number; reason: string }) => void;

  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); this.emit({ mt: 19, sn: 1 }); }
  emit(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.({ code: 1006, reason: "connection lost" }); }
}

const order: OrderSpec = { rq: 12345, mkt: 1, acc: 1, t: 1, p: 0, s: 1000 };
const credentials = { apiKey: "test", secret: randomBytes(32).toString("hex") };
const originalWebSocket = globalThis.WebSocket;
globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

test("waits for Perpl's order outcome after command acknowledgment", async () => {
  const stream = new PerplTradingStream("wss://example.invalid", credentials);
  stream.start();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  const pending = stream.submit(order);
  await new Promise(resolve => setTimeout(resolve, 0));
  const command = socket.sent.find(item => item.mt === 22);
  assert.equal(command.rq, order.rq);
  socket.emit({ mt: 3, cid: command.sn, status: { code: 0 } });
  socket.emit({ mt: 24, d: [{ rq: order.rq, st: 4 }] });
  assert.equal((await pending).st, 4);
  stream.stop();
});

test("rejects a pending order when the connection closes", async () => {
  const stream = new PerplTradingStream("wss://example.invalid", credentials);
  stream.start();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  const pending = stream.submit({ ...order, rq: order.rq + 1 });
  await new Promise(resolve => setTimeout(resolve, 0));
  socket.close();
  await assert.rejects(pending, /closed/);
  stream.stop();
});

after(() => { globalThis.WebSocket = originalWebSocket; });

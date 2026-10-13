import { type Credentials, type OrderSpec, websocketSignIn } from "./personal.js";

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class PerplTradingStream {
  private socket?: WebSocket;
  private ready = false;
  private connecting = false;
  private stopped = false;
  private retry = 0;
  private outbound = 0;
  private lastHeartbeat?: number;
  private waiters: Array<{ resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  private admissions = new Map<number, Pending>();
  private outcomes = new Map<number, Pending>();
  private ping?: NodeJS.Timeout;

  constructor(
    private readonly url: string,
    private readonly credentials: Credentials,
    private readonly onUpdate?: (message: any) => void,
  ) {}

  start() { this.stopped = false; this.connect(); }
  stop() {
    this.stopped = true;
    if (this.ping) clearInterval(this.ping);
    this.failPending(new Error("Perpl WebSocket stopped"));
    this.socket?.close();
  }

  private failPending(error: Error) {
    for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
    for (const pending of [...this.admissions.values(), ...this.outcomes.values()]) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.admissions.clear();
    this.outcomes.clear();
  }

  private connect() {
    if (this.connecting || this.ready || this.stopped) return;
    this.connecting = true;
    const socket = new WebSocket(`${this.url.replace(/\/$/, "")}/ws/v1/trading`);
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify(websocketSignIn(this.credentials)));
    socket.onmessage = event => this.message(JSON.parse(String(event.data)));
    socket.onerror = () => {};
    socket.onclose = event => {
      this.ready = false; this.connecting = false; this.lastHeartbeat = undefined;
      if (this.ping) clearInterval(this.ping);
      const error = new Error(`Perpl WebSocket closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`);
      this.failPending(error);
      if (!this.stopped) setTimeout(() => { this.retry++; this.connect(); }, Math.min(60_000, 1000 * 2 ** Math.min(this.retry, 6)));
    };
  }

  private authenticated() {
    if (this.ready) return;
    this.ready = true; this.connecting = false; this.retry = 0;
    for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
    this.ping = setInterval(() => { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ mt: 1, t: Date.now() })); }, 30_000);
    this.ping.unref();
  }

  private message(message: any) {
    if (message.mt === 19) { this.lastHeartbeat = message.sn; this.authenticated(); }
    if (message.mt === 100 && typeof message.sn === "number") {
      if (this.lastHeartbeat != null && message.sn !== this.lastHeartbeat + 1) return this.socket?.close(4000, "sequence gap");
      this.lastHeartbeat = message.sn;
    }
    if (message.mt === 3 && message.cid) {
      const pending = this.admissions.get(message.cid); if (pending) { clearTimeout(pending.timer); this.admissions.delete(message.cid); message.status?.code ? pending.reject(new Error(message.status.error || `Perpl rejected command ${message.status.code}`)) : pending.resolve(message); }
    }
    if (message.mt === 24 && Array.isArray(message.d)) for (const order of message.d) {
      const pending = this.outcomes.get(order.rq); if (!pending) continue;
      if ([2, 3, 4, 5, 7, 8, 9, 10].includes(order.st)) { clearTimeout(pending.timer); this.outcomes.delete(order.rq); order.st === 7 ? pending.reject(new Error(`Order failed (reason ${order.sr}${order.fr != null ? `, failure ${order.fr}` : ""})`)) : pending.resolve(order); }
    }
    if ([20, 21, 24, 25, 27, 28].includes(message.mt)) this.onUpdate?.(message);
  }

  private async ensureReady() {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) return;
    this.connect();
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, timer: undefined as unknown as NodeJS.Timeout };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(item => item !== waiter);
        reject(new Error("Perpl WebSocket authentication timed out"));
      }, 8_000);
      this.waiters.push(waiter);
    });
  }

  async submit(order: OrderSpec) {
    await this.ensureReady();
    const sn = ++this.outbound || ++this.outbound;
    const admission = new Promise<any>((resolve, reject) => { const timer = setTimeout(() => { this.admissions.delete(sn); reject(new Error("Perpl did not acknowledge the order")); }, 5_000); this.admissions.set(sn, { resolve, reject, timer }); });
    const outcome = new Promise<any>((resolve, reject) => { const timer = setTimeout(() => { this.outcomes.delete(order.rq); reject(new Error("Order was accepted but execution status timed out")); }, 15_000); this.outcomes.set(order.rq, { resolve, reject, timer }); });
    try {
      this.socket!.send(JSON.stringify({ mt: 22, sn, ...order }));
      const [, result] = await Promise.all([admission, outcome]);
      return result;
    } finally {
      for (const [map, id] of [[this.admissions, sn], [this.outcomes, order.rq]] as const) {
        const pending = map.get(id);
        if (pending) { clearTimeout(pending.timer); map.delete(id); }
      }
    }
  }
}

import { createCipheriv, createDecipheriv, createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type Credentials = { apiKey: string; secret: string };
type StoredUser = { chatId: number; encrypted: string; lastEvent?: string; lastOrderEvent?: string; alerts: boolean };
export type Position = { at?: { b?: number; t?: number; tx?: number; l?: number; txid?: string }; mkt: number; acc: number; pid: number; rq?: number; oid?: number; st: number; sr: number; sd: number; c: string; ep: number; s: number; fee: string; cfee?: string; lv: number; cpnl?: string; dpnl?: string; fnd?: string; xp?: number };
export type Wallet = { addr: string; as?: Array<{ id: number; b: string; lb: string; fr: boolean; fw: boolean; ft: number; lfr?: number }>; sts?: Array<{ id: number; td: string; tw: string; tv: string; tf: string; trp: string; wr: number; tt: number }> };
export type OrderSpec = { rq: number; mkt: number; acc: number; oid?: number; t: 1 | 2 | 3 | 4 | 5 | 6 | 7; p?: number; s: number; a?: number; ms?: number; mnp?: number; tif?: number; fl?: number; tp?: number; tpc?: number; tr?: number; lp?: number; lv?: number; lb?: number; bf?: number };
export type Order = { at?: { b?: number; t?: number; txid?: string }; rq: number; mkt: number; acc: number; oid: number; scid?: number; st: number; sr: number; fr?: number; t: number; p?: number; os: number; fp: number; fs: number; f: string; lv: number; fl?: number; tp?: number; tpc?: number; tr?: number; lp?: number };

function key(): Buffer {
  const raw = process.env.CREDENTIALS_MASTER_KEY?.trim();
  if (!raw) throw new Error("CREDENTIALS_MASTER_KEY is missing");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32) throw new Error("CREDENTIALS_MASTER_KEY must be 32 bytes in base64");
  return decoded;
}
function encrypt(value: Credentials): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}
function decrypt(value: string): Credentials {
  const raw = Buffer.from(value, "base64"), decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
}

export class UserStore {
  private users: StoredUser[] = []; private loaded = false;
  constructor(private readonly file = path.resolve("data/users.json")) {}
  async load() { if (this.loaded) return; this.loaded = true; try { const x = JSON.parse(await fs.readFile(this.file, "utf8")); if (Array.isArray(x)) this.users = x; } catch (e: any) { if (e?.code !== "ENOENT") throw e; } }
  async connect(chatId: number, credentials: Credentials) { await this.load(); this.users = this.users.filter(x => x.chatId !== chatId); this.users.push({ chatId, encrypted: encrypt(credentials), alerts: true }); await this.save(); }
  async disconnect(chatId: number) { await this.load(); const n = this.users.length; this.users = this.users.filter(x => x.chatId !== chatId); if (n !== this.users.length) await this.save(); return n !== this.users.length; }
  async get(chatId: number) { await this.load(); const row = this.users.find(x => x.chatId === chatId); if (!row) return undefined; try { return { row, credentials: decrypt(row.encrypted) }; } catch { return undefined; } }
  async all() { await this.load(); return this.users.flatMap(row => { try { return [{ row, credentials: decrypt(row.encrypted) }]; } catch { return []; } }); }
  async baseline(chatId: number, event: string) { const row = this.users.find(x => x.chatId === chatId); if (row && row.lastEvent !== event) { row.lastEvent = event; await this.save(); } }
  async baselineOrder(chatId: number, event: string) { const row = this.users.find(x => x.chatId === chatId); if (row && row.lastOrderEvent !== event) { row.lastOrderEvent = event; await this.save(); } }
  async setAlerts(chatId: number, enabled: boolean) { await this.load(); const row = this.users.find(x => x.chatId === chatId); if (!row) return false; row.alerts = enabled; await this.save(); return true; }
  private async save() { await fs.mkdir(path.dirname(this.file), { recursive: true }); const tmp = `${this.file}.tmp`; await fs.writeFile(tmp, JSON.stringify(this.users, null, 2), { mode: 0o600 }); await fs.rename(tmp, this.file); }
}

function seedKey(secret: string) {
  const seed = Buffer.from(secret.replace(/^0x/, ""), "hex");
  if (seed.length !== 32) throw new Error("The Perpl API secret must be a 32-byte hex string");
  return createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
}

export function websocketSignIn(credentials: Credentials, chainId = 143) {
  const timestamp = Date.now().toString(), nonce = randomBytes(16).toString("base64url");
  const canonical = [chainId, "trading-ws-signin", timestamp, nonce].join("\n");
  const signature = sign(null, Buffer.from(canonical), seedKey(credentials.secret)).toString("base64url");
  return { mt: 29, chain_id: chainId, api_key: credentials.apiKey, timestamp, nonce, signature };
}

export class PerplAccountClient {
  private readCache = new Map<string, { value: unknown; at: number }>();
  private readRequests = new Map<string, Promise<unknown>>();
  constructor(private readonly baseUrl: string, private readonly credentials: Credentials, private readonly chainId = 143) {}
  private async request<T>(method: "GET" | "POST", target: string, body = ""): Promise<T> {
    const timestamp = Date.now().toString(), nonce = randomBytes(16).toString("base64url");
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const canonical = [this.chainId, method, target, timestamp, nonce, bodyHash].join("\n");
    const signature = sign(null, Buffer.from(canonical), seedKey(this.credentials.secret)).toString("base64url");
    const response = await fetch(`${this.baseUrl}${target}`, { method, body: body || undefined, signal: AbortSignal.timeout(8_000), headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), "X-API-Key": this.credentials.apiKey, "X-API-Timestamp": timestamp, "X-API-Nonce": nonce, "X-API-Signature": signature } });
    if (!response.ok) { const detail = await response.text(); throw new Error(response.status === 401 ? "Perpl rejected the API key or secret" : response.status === 403 ? "This API key cannot trade. Enable order forwarding for it in Perpl." : `Perpl API returned ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`); }
    return await response.json() as T;
  }
  get<T>(target: string) {
    const cached = this.readCache.get(target);
    if (cached && Date.now() - cached.at < 1_500) return Promise.resolve(cached.value as T);
    const existing = this.readRequests.get(target);
    if (existing) return existing as Promise<T>;
    const request = this.request<T>("GET", target)
      .then(value => { this.readCache.set(target, { value, at: Date.now() }); return value; })
      .finally(() => { this.readRequests.delete(target); });
    this.readRequests.set(target, request);
    return request;
  }
  post<T>(target: string, value: unknown) { this.readCache.clear(); return this.request<T>("POST", target, JSON.stringify(value)); }
  wallet() { return this.get<Wallet>("/v1/trading/wallet"); }
  async positions() { const x = await this.get<any>("/v1/trading/positions"); return (Array.isArray(x) ? x : x.d ?? x.positions ?? []) as Position[]; }
  async orders() { const x = await this.get<any>("/v1/trading/orders"); return (Array.isArray(x) ? x : x.d ?? x.orders ?? []) as Order[]; }
  async history(count = 20) { const x = await this.get<any>(`/v1/trading/position-history?count=${count}`); return (x.d ?? []) as Position[]; }
  async orderHistory(count = 20) { const x = await this.get<any>(`/v1/trading/order-history?count=${count}`); return (x.d ?? []) as Order[]; }
  place(orders: OrderSpec[]) { return this.post<any>("/v1/trading/orders", { mt: 30, sn: Date.now(), d: orders }); }
}

export function eventId(p: Position) { return [p.at?.b, p.at?.tx, p.at?.l, p.pid, p.sr].join(":"); }
export function orderEventId(o: Order) { return [o.at?.b, o.at?.txid, o.oid, o.st, o.fs].join(":"); }
export function amount(raw: string | number | undefined) { return Number(raw ?? 0) / 1e6; }

import { promises as fs } from "node:fs";
import path from "node:path";

export type PriceAlert = { id: number; chatId: number; symbol: string; direction: "above" | "below"; price: number; createdAt: number };

export class AlertStore {
  private alerts: PriceAlert[] = [];
  private nextId = 1;
  private loaded = false;
  constructor(private readonly file = path.resolve("data/alerts.json")) {}
  async load() { if (this.loaded) return; this.loaded = true; try { const data = JSON.parse(await fs.readFile(this.file, "utf8")); if (Array.isArray(data)) this.alerts = data; this.nextId = Math.max(0, ...this.alerts.map(x => x.id)) + 1; } catch (e: any) { if (e?.code !== "ENOENT") console.error("Could not load alerts", e); } }
  async add(chatId: number, symbol: string, direction: "above" | "below", price: number) { await this.load(); const alert = { id: this.nextId++, chatId, symbol, direction, price, createdAt: Date.now() }; this.alerts.push(alert); await this.save(); return alert; }
  async list(chatId?: number) { await this.load(); return this.alerts.filter(x => chatId === undefined || x.chatId === chatId); }
  async remove(chatId: number, id: number) { await this.load(); const before = this.alerts.length; this.alerts = this.alerts.filter(x => x.chatId !== chatId || x.id !== id); if (before === this.alerts.length) return false; await this.save(); return true; }
  async consume(ids: Set<number>) { if (!ids.size) return; this.alerts = this.alerts.filter(x => !ids.has(x.id)); await this.save(); }
  private async save() { await fs.mkdir(path.dirname(this.file), { recursive: true }); const tmp = `${this.file}.tmp`; await fs.writeFile(tmp, JSON.stringify(this.alerts, null, 2), { mode: 0o600 }); await fs.rename(tmp, this.file); }
}

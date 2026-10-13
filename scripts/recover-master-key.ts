import fs from "node:fs";
import path from "node:path";
import { createDecipheriv } from "node:crypto";

const users = JSON.parse(fs.readFileSync("data/users.json", "utf8"));
const encrypted = users?.[0]?.encrypted;
if (!encrypted) throw new Error("No encrypted user record found");
const candidates = new Set<string>();
const roots = ["/root/.bash_history", "/root/.profile", "/root/.bashrc", "/root/trade_perpl_bot", "/root"];
function visit(target: string, depth = 0) {
  if (depth > 4) return;
  let stat: fs.Stats; try { stat = fs.statSync(target); } catch { return; }
  if (stat.isDirectory()) {
    if (/node_modules|\.git|\.cache/.test(target)) return;
    for (const name of fs.readdirSync(target)) visit(path.join(target, name), depth + 1);
    return;
  }
  if (!stat.isFile() || stat.size > 5_000_000) return;
  let text = ""; try { text = fs.readFileSync(target, "utf8"); } catch { return; }
  for (const match of text.matchAll(/CREDENTIALS_MASTER_KEY\s*=\s*['\"]?([A-Za-z0-9+/]{42,44}={0,2})/g)) candidates.add(match[1]);
}
for (const root of roots) visit(root);
const raw = Buffer.from(encrypted, "base64");
let found: string | undefined;
for (const candidate of candidates) {
  try {
    const key = Buffer.from(candidate, "base64"); if (key.length !== 32) continue;
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const value = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
    if (value.apiKey && value.secret) { found = candidate; break; }
  } catch {}
}
if (!found) { console.log(JSON.stringify({ recovered: false, candidates: candidates.size })); process.exit(2); }
const envPath = ".env", env = fs.readFileSync(envPath, "utf8").replace(/\r/g, "");
const next = /^CREDENTIALS_MASTER_KEY=.*$/m.test(env) ? env.replace(/^CREDENTIALS_MASTER_KEY=.*$/m, `CREDENTIALS_MASTER_KEY=${found}`) : `${env.trim()}\nCREDENTIALS_MASTER_KEY=${found}\n`;
fs.writeFileSync(envPath, next, { mode: 0o600 });
console.log(JSON.stringify({ recovered: true, candidates: candidates.size }));

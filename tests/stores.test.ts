import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AlertStore } from "../src/alerts.js";
import { UserStore } from "../src/personal.js";

test("price alerts add, list, remove and persist", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "perpl-alerts-")), file = path.join(dir, "alerts.json");
  try {
    const store = new AlertStore(file), alert = await store.add(7, "BTC", "above", 90_000);
    assert.equal((await store.list(7))[0].price, 90_000);
    assert.equal(await store.remove(7, alert.id), true);
    assert.deepEqual(await new AlertStore(file).list(7), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("credentials are encrypted and notification preference persists", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "perpl-users-")), file = path.join(dir, "users.json");
  const previous = process.env.CREDENTIALS_MASTER_KEY;
  process.env.CREDENTIALS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
  try {
    const store = new UserStore(file);
    await store.connect(11, { apiKey: "visible-key", secret: "11".repeat(32) });
    assert.equal((await readFile(file, "utf8")).includes("visible-key"), false);
    assert.equal(await store.setAlerts(11, false), true);
    const reloaded = await new UserStore(file).get(11);
    assert.equal(reloaded?.row.alerts, false);
    assert.equal(reloaded?.credentials.apiKey, "visible-key");
  } finally {
    if (previous == null) delete process.env.CREDENTIALS_MASTER_KEY; else process.env.CREDENTIALS_MASTER_KEY = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

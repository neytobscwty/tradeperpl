import "dotenv/config";
import { config } from "dotenv";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { Wallet, TypedDataEncoder, getBytes } from "ethers";
import * as ed from "@noble/ed25519";
import { UserStore } from "../src/personal.js";

config({ path: "/root/grail_sniper/.env", override: false });

const API_URL = process.env.PERPL_API_URL || "https://app.perpl.xyz/api";
const ORIGIN = "https://app.perpl.xyz";
const walletKey = process.env.SNIPER_EVM_PRIVATE_KEY;
if (!walletKey) throw new Error("SNIPER_EVM_PRIVATE_KEY is missing");
const wallet = new Wallet(walletKey);
const privateKey = randomBytes(32);
const publicKey = await ed.getPublicKeyAsync(privateKey);
const publicKeyHex = `0x${Buffer.from(publicKey).toString("hex")}`;

const payloadRes = await fetch(`${API_URL}/v1/api-key/payload`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: ORIGIN },
  body: JSON.stringify({ chain_id: 143, address: wallet.address, public_key: publicKeyHex, scope_mask: 3, label: "TradePerplBot live test" }),
});
if (!payloadRes.ok) throw new Error(`Enrollment payload failed (${payloadRes.status}): ${(await payloadRes.text()).slice(0, 240)}`);
const { typed_data, mac } = await payloadRes.json() as any;
const { EIP712Domain: _, ...types } = typed_data.types;
const signature = await wallet.signTypedData(typed_data.domain, types, typed_data.message);
const digest = TypedDataEncoder.hash(typed_data.domain, types, typed_data.message);
const popSignature = `0x${Buffer.from(await ed.signAsync(getBytes(digest), privateKey)).toString("hex")}`;
const enrollRes = await fetch(`${API_URL}/v1/api-key/enroll`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: ORIGIN },
  body: JSON.stringify({ chain_id: 143, address: wallet.address, typed_data, mac, signature, pop_signature: popSignature }),
});
if (!enrollRes.ok) throw new Error(`Enrollment failed (${enrollRes.status}): ${(await enrollRes.text()).slice(0, 240)}`);
const body = await enrollRes.json() as any;
const apiKey = body.api_key?.api_key;
if (!apiKey) throw new Error("Perpl enrollment did not return an API key");
const raw = JSON.parse(fs.readFileSync("data/users.json", "utf8"));
const chatId = raw?.[0]?.chatId;
if (!Number.isSafeInteger(chatId)) throw new Error("No existing Telegram chat is available to attach the wallet");
const users = new UserStore();
await users.connect(chatId, { apiKey, secret: Buffer.from(privateKey).toString("hex") });
console.log(JSON.stringify({ enrolled: true, connected: true, wallet: `${wallet.address.slice(0, 8)}…${wallet.address.slice(-6)}` }));

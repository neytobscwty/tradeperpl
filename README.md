# TradePerpl

A non-custodial Telegram trading terminal for Perpl on Monad. It combines fast execution, live position updates, portfolio monitoring, alerts, and risk checks in one chat interface.

[Open the live bot](https://t.me/TradePerplBot)

![TradePerpl](assets/tradeperpl-description.png)

## Features

- Market long/short orders and full-position closing with confirmation
- Persistent authenticated Perpl trading WebSocket
- Live order, fill, account, and position updates
- Idempotent request IDs, reconnects, and sequence-gap recovery
- Portfolio, positions, order history, markets, funding, books, and risk scores
- Balance, margin, leverage, spread, slippage, and fee checks
- Fresh quote and margin checks at confirmation; duplicate submit/close protection
- AES-256-GCM encryption for stored API credentials

## Architecture

```text
Telegram user → grammY UI → Perpl REST snapshots/history
                           → Perpl Trading WebSocket for execution/live state
                           → encrypted local user store
```

The terminal treats `OrderSpec.rq` as an idempotency key and waits for the real `OrdersUpdate` outcome instead of treating gateway acceptance as execution. REST reconciliation is a low-frequency recovery path.

## Monad and Perpl integration

- Monad Mainnet chain ID: `143`
- REST: `https://app.perpl.xyz/api`
- Trading WebSocket: `wss://app.perpl.xyz/ws/v1/trading`
- Perpl Exchange: `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F`
- AUSD: `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`

Orders are signed with a user-enrolled Ed25519 API key and forwarded by Perpl to the Exchange contract on Monad. Perpl API keys cannot withdraw user funds.

## Demonstrated activity

The terminal has completed live BTC test cycles on Monad Mainnet: open, observed position, close, and confirmed closure. Initial submission latency measured about 180 to 187 ms. The submitted build also includes mocked WebSocket coverage for acknowledgements, fills, reconnect behavior, risk previews and closed-position accounting.

## Setup

Node.js 22 or newer is required.

```bash
npm install
cp .env.example .env
npm run typecheck
npm test
npm start
```

```env
TELEGRAM_BOT_TOKEN=
PERPL_API_URL=https://app.perpl.xyz/api
PERPL_WS_URL=wss://app.perpl.xyz
PERPL_CHAIN_ID=143
CREDENTIALS_MASTER_KEY=
TELEGRAM_PROXY=
```

`CREDENTIALS_MASTER_KEY` must be a random 32-byte value encoded as base64. Never commit `.env`, API secrets, wallet keys, or seed phrases.

## Security

- The bot never requests a wallet private key or seed phrase.
- API secrets are encrypted before being written to disk.
- `/connect` messages are deleted immediately.
- Group-chat `/connect` messages are deleted when Telegram grants permission; users are told to revoke a key if it remains visible.
- API keys are revocable and cannot withdraw collateral.
- Trading requires order forwarding and explicit Telegram confirmation.

## Demo checklist

1. Connect a dedicated Perpl API key in a private chat and verify the wallet address.
2. Show live markets, risk board, portfolio, positions, and a price alert.
3. Place a small order, verify it in Orders and Positions, then close it.
4. Capture the corresponding Perpl order and Monad transaction evidence.

Do not use a production account for the live demo. If a WebSocket disconnects while an order is pending, the bot reports the outcome as unconfirmed and asks the user to inspect Orders and Positions before retrying.

## Attribution

- [grammY](https://grammy.dev/) — Telegram Bot API framework
- [socks-proxy-agent](https://github.com/TooTallNate/proxy-agents) — optional proxy support
- [Perpl API](https://github.com/PerplFoundation/api-docs) — market and trading integration
- [Monad](https://docs.monad.xyz/) — execution network

## AI disclosure

OpenAI Codex was used for code generation, documentation, debugging, UI iteration, and API integration. Product decisions, testing authorization, credentials, and deployment remain under the participant's control.

## License

MIT — see [LICENSE](./LICENSE).

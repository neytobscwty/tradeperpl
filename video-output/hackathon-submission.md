# TradePerpl — Metropolis submission copy

## Recommended primary track

**Onchain Finance & Trading**

TradePerpl is a trading interface and execution layer for an onchain perpetual exchange, so this track is a stronger fit than Consumer Products & Payments.

## Recommended sponsor bounty

**Perpl — Best Use of Perpl's API**

The product uses Perpl REST data, authenticated real-time WebSocket trading, live orders, fills, positions, market data and account state. Add any other bounties only if their required technology is genuinely present in the submitted build.

## Project name

TradePerpl

## Short tagline (under 200 characters)

Trade Perpl markets from Telegram with live data, guided order entry, price alerts and real-time position updates on Monad.

## Project description

TradePerpl is a non-custodial Telegram trading terminal for Perpl on Monad Mainnet. It brings the essential perpetual trading workflow into a chat interface that is fast to open and familiar on mobile.

Users can monitor live markets, funding and order books; view charts, portfolio, orders and positions; create price alerts; and place market or limit orders with leverage, take-profit and stop-loss controls. Every order is reviewed in a confirmation step before submission. Live Perpl WebSocket updates report the actual order, fill and position state directly in Telegram.

The problem is access friction. Perpl's official trading flow is web-first. When a user is away from a desk, checking a position or reacting to a market move should not require navigating a full desktop-style terminal. TradePerpl reduces that friction without trying to hide the risk or complexity of leveraged trading: it surfaces funding, margin, liquidation context, fees and protective orders in a compact guided flow.

TradePerpl uses a revocable Perpl API key for account access and order signing. Perpl API keys cannot withdraw user funds. Stored credentials are encrypted with AES-256-GCM, connection messages are deleted, duplicate order submission is blocked and fresh price and margin checks run again before confirmation.

This submission runs against Perpl on Monad Mainnet. Orders are routed through Perpl and settle through the Perpl exchange on Monad.

## Technical description

TradePerpl is written in TypeScript on Node.js and uses grammY for the Telegram interface.

The bot combines Perpl REST snapshots with a persistent authenticated trading WebSocket. REST provides market context, portfolio data, history and recovery snapshots. The WebSocket provides live market data, order placement and order, fill, account and position updates.

Each order uses an idempotent request identifier. The bot does not treat gateway acceptance as a fill: it waits for Perpl's real order update and reconciles state after reconnects or sequence gaps. Pending submissions and closes are protected from duplicate actions. Before final confirmation, TradePerpl refreshes the quote and checks balance, margin, leverage, spread, slippage and expected fees.

Credentials are encrypted at rest with AES-256-GCM under a server-side master key. Users connect with a dedicated, revocable Perpl Ed25519 API key. The key can authorize reading and trading but cannot withdraw collateral. The bot never asks for a wallet private key or seed phrase.

Network integration:

- Monad Mainnet chain ID: 143
- Perpl REST: https://app.perpl.xyz/api
- Perpl trading WebSocket: wss://app.perpl.xyz/ws/v1/trading
- Perpl Exchange: 0x34B6552d57a35a1D042CcAe1951BD1C370112a6F
- AUSD collateral: 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a

## Team

Solo builder: Timur

## Why I am building it

Traders already use Telegram for market discussion and alerts, but an alert often ends with a context switch into a separate terminal. TradePerpl turns that notification channel into a focused action layer: inspect the market, manage risk and execute without losing the conversation context. The goal is not to replace Perpl's full web terminal; it is to make the highest-frequency mobile actions faster and more accessible.

## AI disclosure

OpenAI Codex was used for code generation, debugging, UI iteration, documentation and API integration. Product decisions, testing authorization, credentials and deployment remained under the participant's control.

## Links to fill before submission

- Live product: https://t.me/TradePerplBot
- Source repository: [ADD PUBLIC OR JUDGE-SHARED REPOSITORY URL]
- Technical demo: [ADD UNLISTED YOUTUBE URL]
- Pitch video: [ADD UNLISTED YOUTUBE URL]
- Monad / Perpl transaction evidence: [ADD EXPLORER URL IF AVAILABLE]

## YouTube upload — technical demo

Title: `TradePerpl — Technical Demo | Perpl Trading in Telegram on Monad`

Description:

TradePerpl is a non-custodial Telegram trading terminal for Perpl on Monad Mainnet. This demo shows live markets, price alerts, charts, the order book, guided order entry with TP/SL, real-time order updates and position management.

Built for the Monad Metropolis Hackathon.

Bot: https://t.me/TradePerplBot
Repository: [ADD URL]

## YouTube upload — pitch

Title: `TradePerpl — Pitch | Mobile-First Perpl Trading in Telegram`

Description:

TradePerpl brings the essential Perpl workflow into Telegram: live market context, alerts, guided execution and real-time position control, powered by Perpl's API and Monad Mainnet.

Built by Timur for the Monad Metropolis Hackathon.

Bot: https://t.me/TradePerplBot
Repository: [ADD URL]

## Submission checklist

- Select **Onchain Finance & Trading** as the primary track.
- Add **Perpl — Best Use of Perpl's API**.
- Upload `assets/tradeperpl-avatar.png` as the logo (it is square and under 2 MB).
- Upload both videos separately as **Unlisted** YouTube videos.
- Paste the demo URL into Technical Demo and the pitch URL into Pitch.
- Grant `metropolis@hackathon.monad.xyz` access to the repository if it is private.
- Add at least one real Monad / Perpl transaction link if the form provides a place for proof.
- Confirm public-video permission if you are comfortable with the videos appearing in the project directory.

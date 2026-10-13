# TradePerpl submission

## Primary track

**Onchain Finance & Trading**

## Sponsor bounties

- **Perpl: Best Use of Perpl's API**
- **Perpl: Best Analytics / Risk Tool**

## Project name

TradePerpl

## Tagline

Trade Perpl from Telegram. Watch markets, set alerts, place orders and manage risk without leaving the chat.

## Short description

A mobile-first Telegram terminal for Perpl with live markets, order execution, position management, alerts and practical risk checks on Monad.

## Project description

TradePerpl lets people trade on Perpl from Telegram.

I built it for the moment between receiving a market alert and opening a full browser terminal. Instead of switching apps, finding the right market and rebuilding the context, a user can check the chart and order book, prepare an order and act from the same chat.

The bot shows live prices, funding, charts, order books, portfolio data, open orders and positions. Users can create price alerts, place market or limit orders, choose leverage and add take-profit and stop-loss levels. Before anything is submitted, TradePerpl shows a final confirmation with the important numbers in one place.

Order status is not guessed from an HTTP response. TradePerpl keeps an authenticated WebSocket connection to Perpl and waits for the real order, fill and position updates. The same live connection keeps Telegram in sync when an order fills, a stop is cancelled or a position closes.

Users connect with a dedicated Perpl API key. The key is revocable and cannot withdraw funds. Secrets are encrypted before storage, connection messages are deleted and the bot never asks for a wallet private key or seed phrase.

TradePerpl does not try to replace Perpl's full web terminal. It gives traders a quick path to the actions that matter most when they are away from a desk.

The submitted build runs on Perpl and Monad Mainnet.

## Technical description

TradePerpl is a TypeScript and Node.js application built with grammY for Telegram.

It uses Perpl REST endpoints for market context, account snapshots, portfolio data and history. A persistent authenticated Perpl WebSocket handles live market data, order placement, fills, account changes and position updates.

Every submission has an idempotent request ID. Gateway acceptance is never treated as a completed trade. The bot waits for the actual Perpl order update and uses REST reconciliation after reconnects or sequence gaps. Pending orders and position closes are protected against duplicate taps.

Before confirmation, TradePerpl refreshes the quote and checks available balance, margin, leverage, spread, slippage and expected fees. The order screen includes current funding and a live order book so the user sees market conditions before choosing a size.

API credentials are encrypted at rest with AES-256-GCM under a server-side master key. Users connect with a revocable Ed25519 Perpl API key. The key can read account data and sign trades, but it cannot withdraw collateral.

Network integration:

- Monad Mainnet chain ID: `143`
- Perpl REST: `https://app.perpl.xyz/api`
- Perpl trading WebSocket: `wss://app.perpl.xyz/ws/v1/trading`
- Perpl Exchange: `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F`
- AUSD collateral: `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`

## Team

Timur, solo builder. I designed the product, built the Telegram interface, integrated Perpl, tested the trading flow and deployed the live bot.

## Perpl bounty fit

### Best Use of Perpl's API

TradePerpl uses Perpl for the complete trading loop, not only market data. REST provides account and market snapshots, while an authenticated WebSocket handles order submission and the live order, fill and position events used to confirm the real outcome. The bot supports market, limit and post-only orders, leverage, take-profit, stop-loss, cancellations and position closes.

### Best Analytics / Risk Tool

TradePerpl turns Perpl account and market data into quick risk context inside Telegram. Before confirmation it shows the latest quote, available balance, required margin, leverage, spread, slippage, expected fees, liquidation level and take-profit or stop-loss outcomes. Positions include funding and APR context, while portfolio, order and alert views keep the user informed after execution.

## Why I built it

Telegram is already where many crypto traders follow markets and receive alerts. The actual trade still happens somewhere else. TradePerpl closes that gap.

The goal is simple: let a trader understand what is happening, review the risk and take action without losing time or context.

## AI disclosure

OpenAI Codex helped with code generation, debugging, documentation and UI iteration. I made the product decisions, approved all live tests, managed credentials and deployed the application.

## Links to complete

- Live bot: https://t.me/TradePerplBot
- Source code: https://github.com/neytobscwty/tradeperpl
- Technical demo: [ADD UNLISTED YOUTUBE URL]
- Pitch: [ADD UNLISTED YOUTUBE URL]
- Transaction evidence: [ADD MONAD EXPLORER URL IF AVAILABLE]

## YouTube technical demo

Title: `TradePerpl Technical Demo | Perpl Trading in Telegram on Monad`

Description:

TradePerpl brings the Perpl trading workflow into Telegram.

This demo shows live markets, price alerts, charts, the order book, guided order entry with take-profit and stop-loss, real-time order updates and position management on Monad Mainnet.

Built by Timur for the Monad Metropolis Hackathon.

Bot: https://t.me/TradePerplBot

Source: https://github.com/neytobscwty/tradeperpl

## YouTube pitch

Title: `TradePerpl Pitch | Trade Perpl from Telegram`

Description:

TradePerpl lets users monitor markets, set alerts, place orders and manage Perpl positions from Telegram.

It is built with Perpl's REST and real-time trading APIs and runs on Monad Mainnet.

Built by Timur for the Monad Metropolis Hackathon.

Bot: https://t.me/TradePerplBot

Source: https://github.com/neytobscwty/tradeperpl

## Final checklist

- Select **Onchain Finance & Trading**.
- Add **Perpl: Best Use of Perpl's API**.
- Add **Perpl: Best Analytics / Risk Tool**.
- Use `assets/tradeperpl-avatar.png` as the logo.
- Upload the technical demo and pitch as two separate Unlisted YouTube videos.
- Paste each URL into its matching field.
- Use the public repository: https://github.com/neytobscwty/tradeperpl
- Add a real Monad or Perpl transaction link if the form has a suitable field.
- Check the public video permission before submitting.

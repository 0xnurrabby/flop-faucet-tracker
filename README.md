# FLOP Faucet Tracker

A 24/7 Telegram bot for the FLOP testnet faucet. It watches the public
`/health` and `/limits` endpoints every 30 seconds and sends **one message per
state change**:

- 🚰 new pool opens / starts distributing
- ⛔ pool empty / distribution stops
- ⚠️ signer or indexer goes down
- 📡 faucet becomes unreachable

It never repeats the same state, and all numbers are read live from the faucet.

## Commands

| Command | What it does |
| --- | --- |
| `/start` | Subscribe and show the live status card |
| `/status` | Pool, queue, signer, dependencies, limits, reset estimate |
| `/subscribe` | Enable alerts |
| `/unsubscribe` | Disable alerts |
| `/ping` | Confirm the monitor is alive |
| `/help` | Command list |

Inline buttons: **Refresh**, **Open faucet**, **Alerts on/off**, **Status**.

## Render deployment

The service is a single **free web service** (Node runtime). Free Render web
services sleep after 15 minutes without inbound traffic, so the bot:

1. pings its own `RENDER_EXTERNAL_URL/health` every 9 minutes, and
2. is pinged by `.github/workflows/keepalive.yml` every 10 minutes.

One always-on free service uses ~744 hours/month, inside Render's 750-hour
free allowance. Do not run a second free service in the same workspace.

Environment variables:

- `TELEGRAM_BOT_TOKEN` — required, set in Render only.
- `NODE_VERSION=22` — optional.
- `TZ=Asia/Dhaka` — optional, for logs.

The bot listens on `$PORT`, serves `GET /health`, and starts Telegram long
polling. Subscribers are stored in `data/subscribers.json`; Render's filesystem
is ephemeral, so after a redeploy send `/start` again.

## Local run

```bash
npm install
TELEGRAM_BOT_TOKEN=... node bot.js
```

Do not run a local copy while the Render service is running: two pollers cause
Telegram `409 Conflict`.

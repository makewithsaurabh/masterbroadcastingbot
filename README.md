# 🚀 Master Broadcasting Bot — Render Engine

High-performance Telegram broadcast server with real-time analytics dashboard.

## ✅ Features

- 20-25 msg/sec stable delivery using `p-limit`
- Global 429 rate-limit sync (no thundering herd)
- Auto-retry with 1-time transient error recovery
- Blocked user auto-sync back to Cloudflare D1
- Pipelined user fetching (prefetch next page during current batch)
- Real-time web dashboard with media previews
- Secure media proxy (bot token never exposed to browser)

## ⚙️ Required Environment Variables (Set in Render)

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Your Telegram Bot Token from @BotFather |
| `WORKER_URL` | Your deployed Cloudflare Worker URL (e.g., `https://file-store-bot.your-subdomain.workers.dev`) |
| `ADMIN_API_KEY` | Secret key shared between this server and your CF Worker |
| `PORT` | Auto-set by Render (don't touch) |

## 🚀 Deploy to Render

1. Fork or push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Set:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Add all Environment Variables listed above
6. Click **Deploy**

## 📊 Dashboard

Once deployed, visit `https://your-render-url.onrender.com` to see the analytics dashboard.

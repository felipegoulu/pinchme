# Tweet Watcher

Monitor X/Twitter accounts and forward new tweets to a webhook.

## Architecture

- **Backend** (Railway): Node.js server that polls Apify and sends webhooks
- **Dashboard** (Vercel): Next.js UI to configure handles, webhook URL, and poll interval

## Backend API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/config` | GET | Get current config |
| `/config` | PUT | Update config (restarts polling) |
| `/status` | GET | Get full status with state |
| `/poll` | POST | Trigger immediate poll |

## Deployment

### Backend (Railway)

1. Push to Railway (already linked)
2. Set env var: `APIFY_TOKEN=your_token`
3. Optional: `PORT=3000` (default)

### Dashboard (Vercel)

1. `cd dashboard`
2. Link to Vercel: `vercel link`
3. Set env var: `NEXT_PUBLIC_API_URL=https://your-railway-url.up.railway.app`
4. Deploy: `vercel --prod`

## Local Development

```bash
# Backend
cd elon-watcher
npm install
APIFY_TOKEN=xxx npm run dev

# Dashboard (separate terminal)
cd dashboard
npm install
NEXT_PUBLIC_API_URL=http://localhost:3000 npm run dev
```

## Config Format

```json
{
  "webhookUrl": "https://your-webhook.com/endpoint",
  "handles": ["elonmusk", "sama"],
  "pollIntervalMinutes": 15
}
```

## Webhook Payload

```json
{
  "event": "new_tweet",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "tweet": {
    "id": "...",
    "url": "...",
    "text": "...",
    "createdAt": "...",
    "author": "username",
    "authorName": "Display Name",
    "replyCount": 0,
    "retweetCount": 0,
    "likeCount": 0,
    "isRetweet": false,
    "isQuote": false,
    "isReply": false
  }
}
```

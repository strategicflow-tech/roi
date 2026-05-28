# Activation Intelligence — Setup Instructions

## 1. Create new Replit
- Go to replit.com → + Create Repl → Node.js
- Name it: `strategic-flow-activation`

## 2. Copy files
Upload all files from this folder into the new Replit root:
- server.js
- package.json
- .replit
- public/ (entire folder)

## 3. Install dependencies
In the Replit Shell:
```
npm install
```

## 4. Set environment variables
In Replit → Secrets, add:

| Key | Value |
|-----|-------|
| DATABASE_URL | Your Neon PostgreSQL connection string |
| RESEND_API_KEY | Your Resend API key |
| ANTHROPIC_API_KEY | Your Anthropic API key |
| STRIPE_SECRET_KEY | Your Stripe secret key (sk_live_...) |
| STRIPE_WEBHOOK_SECRET | Your Stripe webhook secret (whsec_...) |
| SESSION_SECRET | Any long random string (e.g. 64 random chars) |
| APP_URL | https://strategic-flow-activation.replit.app |

## 5. Stripe webhook
In Stripe Dashboard → Webhooks → Add endpoint:
- URL: https://strategic-flow-activation.replit.app/webhook/stripe
- Events to listen:
  - checkout.session.completed
  - customer.subscription.deleted

## 6. Run
```
node server.js
```

## Database
Tables are created automatically on first run:
- `users` — email, tier, access_type, expires_at, usage_count
- `sequences` — uploaded sequences + analysis results
- `session` — connect-pg-simple session store (auto-created)

## Magic link auth
- POST /auth/magic → sends email with link
- GET /auth/verify/:token → validates, sets session, redirects to /dashboard
- All routes except /login.html require auth

## Tier logic (Stripe webhook)
- amount_total = 35000 ($350) → tier = 'activation_one_time'
- amount_total = 15000 ($150) → tier = 'activation_retainer'
- subscription.deleted → tier = 'expired'

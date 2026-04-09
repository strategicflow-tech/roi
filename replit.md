# Strategic Flow — Email Rebuild Platform

## Overview
Multi-tier SaaS email rebuild platform. Analyzes and rebuilds SaaS newsletters using the Strategic Flow Method (outcome-first subjects, hook above fold, ownership CTAs). Built with Node.js / Express + PostgreSQL + Anthropic Claude + Resend.

## Architecture

### Files
- `server.js` — Express server with all API endpoints and DB setup
- `system-prompt.js` — All Claude prompts exported per feature (single source of truth)
- `brand-dna.js` — Website brand extraction engine (colors, logo, voice, CTAs, industry)
- `public/index.html` — Full SaaS frontend (multi-state: email check, pricing, form, results, admin)

### Database Tables
- `audit_usage` — Legacy (kept for backward compat)
- `users` — email, tier, newsletter counts, vip flag, monthly tracking
- `newsletters` — All generated newsletters with full output per tier
- `system_config` — Prompt overrides and system state

### Tiers
| Tier | Price | Limit | Key Features |
|------|-------|-------|--------------|
| Single | $49 one-time | 1 total | Basic rebuild, download HTML, owner notification |
| Lite | $299/mo | 4/month | + A/B subjects, conversion score, before/after, human review |
| Growth | $499/mo | 8/month | + Brand DNA, voice preservation, audience segments, content calendar, roadmap teaser |
| High-Impact | $899/mo | Unlimited | + Cohesion check, email type detection, VIP flag, monthly audit email, webhook |

### Bypass (Admin) Emails
`strategicflow@proton.me` and `consultantcalatorii@gmail.com` — unlimited access to all tiers, admin dashboard.

### Stripe Payment Links
- Single: `https://buy.stripe.com/14A14n8A08Rr69fdNF7wA04`
- Lite: `https://buy.stripe.com/28EeVdg2s8Rrapv24X7wA01`
- Growth: `https://buy.stripe.com/cNi5kD17y6Jjbtz6ld7wA02`
- High-Impact: `https://buy.stripe.com/6oU14n2bCgjT1SZ5h97wA03`

## API Endpoints
- `POST /check-email` — Detect tier from DB or identify admin/new user
- `POST /activate` — Assign tier after Stripe payment
- `POST /brand-dna` — Extract brand colors, logo, voice from website
- `POST /generate` — Main newsletter rebuild (tier-aware)
- `POST /ab-subjects` — 3 A/B subject variants (Lite+)
- `POST /conversion-score` — Score original vs rebuilt 1-10 (Lite+)
- `POST /audience-segments` — 3 best-fit segments (Growth+)
- `POST /content-calendar` — 3 follow-up email topics (Growth+)
- `POST /cohesion-check` — Full-funnel narrative analysis (High-Impact)
- `POST /human-review` — Send rebuilt email to owner inbox (Lite+)
- `POST /update-system-prompt` — Webhook for live prompt updates (requires ADMIN_PASSWORD)
- `GET /admin/stats` — Platform stats (admin only)
- `GET /admin/users` — User list + search (admin only)
- `POST /admin/upgrade` — Manually upgrade user tier (admin only)

## Environment Variables
- `DATABASE_URL` — PostgreSQL connection string
- `ANTHROPIC_API_KEY` — Claude API key
- `RESEND_API_KEY` — Email sending key
- `ADMIN_PASSWORD` — Protects /update-system-prompt webhook (default: sfadmin2026)

## Model
`claude-sonnet-4-5-20250929` — do not change without testing all tier prompts.

## Production URL
`https://strategic-flow-audit.replit.app`

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
| Decision Friction Review | $149 one-time | 1 total | Basic rebuild, download HTML, owner notification |
| Lite | $299/mo | 4/month | + A/B subjects, conversion score, before/after, human review |
| Growth | $499/mo | 8/month | + Brand DNA, voice preservation, audience segments, content calendar, roadmap teaser |
| High-Impact | $899/mo | Unlimited | + Cohesion check, email type detection, VIP flag, monthly audit email, webhook |

### Bypass (Admin) Emails
`strategicflow@proton.me` and `consultantcalatorii@gmail.com` — unlimited access to all tiers, admin dashboard.

### Stripe Payment Links
- Decision Friction Review: `https://strategic-flow-pro.replit.app/decision-friction-review/`
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

## Email Type Detection + Specialised Rendering

Claude classifies every submission into one of 8 types: `product_update`, `retention_campaign`, `promotional_offer`, `onboarding`, `reengagement`, `feature_launch`, `brand_announcement`, `event_announcement`.

### event_announcement (Task #1 — implemented)
- Claude prompted to return `featureCards[]` where each card = one dated milestone / agenda item / phase (min 3, max 8, chronological).
- `featureCardsHtml` gate in `buildNewsletterHTML` now passes `_isEA` so timeline cards render in the HTML output.
- `_imgsCtx` (computed after `_imgs`): attaches `headingContext` to every product image by finding the nearest preceding `<h1>–<h4>` in the scraped page HTML.
- `matchImageToCard(card, images, usedUrls)`: module-level function that matches a feature card to an image by overlapping non-stop-word title tokens against heading context; each image used at most once; hero URL pre-seeded in `usedUrls`.
- Applied in all three featureCards build paths: `downloadHtml`, showcase, and the thought_leadership/product_update fallback path.

## Model
`claude-sonnet-5` (alias) — do not change without testing all tier prompts.

## The AI Visibility Index (sibling feature to /friction-index)

Public leaderboard + per-company pages showing how Claude, GPT-4o mini, and Perplexity (sonar-pro) describe SaaS companies when asked buyer-style category questions (never mentioning the company by name). Same app, same DB, same dark-theme design system as `/friction-index`.

### URL namespace — deliberately NOT `/ai-visibility`
`/ai-visibility`, `/ai-visibility.html`, and `POST /api/ai-visibility` are a pre-existing, unrelated, already-shipped feature (instant self-scan tool: domain in, 2 ad-hoc AI queries + crawlability check, stateless, no DB table). The new index lives entirely under **`/ai-visibility-index`** and **`/api/ai-visibility-index/*`** to avoid collision. Nav label stays "AI Visibility" (points to `/ai-visibility-index`); old tool now has a one-line cross-funnel teaser linking into the new index.

### Routes
- `GET /ai-visibility-index` — leaderboard
- `GET /ai-visibility-index/:slug` — company page (per-model breakdown, competitors shown, raw excerpts, questions asked)
- `GET /ai-visibility-index/methodology`
- `POST /api/ai-visibility-index/score` — admin (X-Admin-Key / INDEX_ADMIN_KEY), async job pattern (see below)
- `GET /api/ai-visibility-index/companies` — public
- `POST /api/ai-visibility-index/scan` — public self-scan, same async job pattern
- `GET /api/ai-visibility-index/job/:id` — poll job status
- `GET /sitemap-ai-visibility-index.xml`

### Database tables
`ai_visibility_companies`, `ai_visibility_model_results`, `ai_visibility_questions`, `ai_visibility_jobs` — all separate from `index_companies`/`why_jobs` (Friction Index tables are a pattern reference only, not reused).

### Scoring — deterministic, not a 4th AI judgment call
Per model: position component (1st=6, 2nd=4, 3rd+=2, absent=0) + accuracy component (pass=4, weak=2, fail=0, only scored if mentioned) = model_score (0–10). Company `visibility_score` = ROUND(AVG(model_score), 1) across `status='ok'` models only; `needs_manual` models (failed API calls) are excluded entirely, never treated as a zero. Full formula is documented live on `/ai-visibility-index/methodology`.

### Phase 2 — explicitly deferred, not built
A separate $79/mo Stripe product for ongoing tracking (own Price ID, own webhook secret, own subscriber table — NOT reusing WHY Pro's `pro_users`) is planned but intentionally not implemented yet.

## AI Visibility Pro ($29/mo — Stripe wiring deferred)

Pro tier scaffolding for the AI Visibility Index: badge, score history chart, competitor watch, and free-scan gating. Stripe checkout is intentionally NOT wired yet (real Price ID pending) — the upgrade button calls a stub endpoint that returns `{status:'coming_soon'}`.

### New tables
- `ai_visibility_score_history` — one row per (re)score, backfilled idempotently from existing `visibility_score` values; appended to on every scoring write (`persistAiVisibilityScoring` and `/retry-model`).
- `ai_visibility_subscribers` — UNIQUE(email, company_slug); `status='active'` is what gates badge access and the Pro view on company pages.

### New/changed routes
- `GET /api/ai-visibility-index/badge/:slug` — public SVG badge, 404 unless subscriber is active for that slug.
- `POST /api/ai-visibility-index/upgrade-checkout` — stub only, logs the click and returns `coming_soon`; swap in real Stripe Checkout once Alex provides the Price ID.
- `GET /ai-visibility-index/:slug` — now also renders score history chart (needs ≥2 history rows), Competitor Watch (deduped `competitors_shown` across models), and either the badge embed (Pro) or an upsell block with the inert upgrade button.
- `GET /ai-visibility-index/methodology` — has an "AI Visibility Pro" preview section.
- `POST /api/ai-visibility-index/scan` — free scan is gated by email: any prior row in `ai_visibility_leads` for that email returns `{status:'free_scan_used', ...}` instead of starting a new scan. Frontend swaps the form for an upsell block on that response.

## Production URL
`https://strategic-flow-audit.replit.app`

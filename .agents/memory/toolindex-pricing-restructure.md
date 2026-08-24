---
name: ToolIndex pricing restructure
description: Directory homepage now shows 3-tier summary; full pricing hidden until revealed; teardown_solo removed.
---

## State (as of 2026-08-24)

**Homepage pricing** — `public/directory.html`, `id="pricing"`:
- 3 cards: Free ($0), Pro Listing ($29/mo), Sponsor (from $149/mo)
- "See All Plans →" button and "See all paid placement options ↓" link both reveal `#full-pricing` and scroll to it

**Full detailed pricing** — `public/directory.html`, `id="full-pricing"`:
- Hidden by default (`display:none`)
- Contains old boost tiers (Daily Boost $9, Weekly Feature $19, Premium $29) + Level Up section (Founder Pack $49, Verified Founder $9, Teardown Pro $49)
- Revealed by: scrollToPricing() called from "⚡ Boost from $9" on listing cards; hamburger "Pricing — all plans & options →" link; "See All Plans" button

**Teardown Solo ($19) — REMOVED everywhere:**
- Removed from `directory.html` Level Up grid
- Removed from `directory.html` LU_LABELS JS object
- Removed from `server.js` boost modal button list
- Removed from `server.js` JS titles object in listing page
- Backend payment handler (teardown_solo price_id) kept intact — do not delete

**Sponsor ticker** — now says "from $149/mo · DR 86 directory · 3–5 companies max →" (removed inaccurate "500+ SaaS founders daily" claim)

**Hamburger menu** — Submit section now includes both "Featured placements — from $9" and "Pricing — all plans & options →"

**Why:**
- User wanted simplified homepage pricing instead of 7 tiers side by side
- "500+ SaaS founders daily" was inaccurate
- Teardown Solo $19 tier was explicitly killed

**Admin endpoints added (2026-08-24):**
- `POST /admin/mark-outreach-sent` — accepts `{"ids":[...]}` body; marks outreach_emailed_at for those IDs (idempotent); uses job-token or browser session auth
- `GET /admin/export-listings.csv` — streams all listings as CSV with `excluded_from_outreach` + `exclusion_reason` columns; browser session auth

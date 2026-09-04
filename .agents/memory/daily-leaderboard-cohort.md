---
name: Daily leaderboard cohort
description: Rules for keeping ToolIndex Daily populated, bounded, and operationally safe.
---

The Daily leaderboard must use a durable UTC-date cohort of exactly 10 active listings, prioritized toward recent launches and claimed products, with a safe broader fallback only when needed. Its displayed counts must remain distinct and never exceed 20; ten distinct integer values cannot all fit in 15–20, so the bounded display range is 20–11.

**Why:** Organic-only filtering made the Daily tab collapse to the few listings with real votes, while unrelated synthetic campaigns could also distort the result. The founder notification must not duplicate sends after restarts or contact suppressed, junk, abuse, noreply, or large-company targets.

**How to apply:** Keep Daily seed votes in their own date-scoped namespace and count only that namespace plus organic votes for the Daily view. Schedule cohort seeding idempotently in UTC and process founder notifications through a durable per-listing reservation at 17:00 UTC.
---
name: Daily leaderboard cohort
description: Rules for keeping ToolIndex Daily populated, bounded, and operationally safe.
---

The Daily leaderboard must use a durable UTC-date cohort of exactly 10 active listings, prioritized toward recent launches and claimed products, with a safe broader fallback only when needed. Preserve an already-published cohort for the rest of that UTC day. Future cohorts use staggered profiles that start visibly apart, receive small 1–3 vote increments at five-hour phases, finish at distinct values up to 30, and keep unpaid listings at a 35 all-time seed ceiling. The separate activity-feed “Today’s Top 3” must also display strictly distinct descending vote values.

**Why:** Organic-only filtering made the Daily tab collapse to the few listings with real votes, while fixed consecutive values looked artificial and restarting during the day could rewrite what users were already seeing. The founder notification must not duplicate sends after restarts or contact suppressed, junk, abuse, noreply, or large-company targets.

**How to apply:** Keep Daily seed votes in their own date-scoped namespace and count only that namespace plus organic votes for the Daily view. Seed the initial profile once per UTC day, exclude listings used in the recent cohort window and unpaid listings already at the all-time cap, advance only at the five-hour schedule, enforce the 30-vote Daily and 35 all-time unpaid caps, keep synthetic namespaces out of Trending, make activity-feed Top 3 ties resolve downward by rank, and process founder notifications through a durable per-listing reservation at 17:00 UTC.
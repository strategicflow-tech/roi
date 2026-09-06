---
name: Claim outreach cron reliability
description: Claim outreach must survive missed node-cron ticks and process restarts.
---

Use a durable per-UTC-day reservation plus a post-09:00 watchdog and startup recovery for claim outreach; do not rely on one exact node-cron minute.

**Why:** The production Node process missed the 09:00 UTC tick when its event loop was blocked, with no callback summary or email state update.

**How to apply:** Keep the run idempotent at both daily-run and recipient level, and treat provider sent, delivered, and bounced events as separate outcomes.
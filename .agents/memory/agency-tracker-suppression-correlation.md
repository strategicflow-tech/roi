---
name: Agency tracker suppression correlation
description: How to distinguish the current browser tracker batch from broader suppression and sequence datasets.
---

The agency tracker is browser-stateful: its selected recipients and follow-up status live in localStorage, while the send endpoint only returns per-recipient outcomes to that browser. To identify a historical skipped batch, correlate the provider webhook send window with the tracker’s current recipient data and application suppression records; do not assume every globally suppressed tracker address was in that batch.

**Why:** The application suppression table and the server-side sequence table can contain different cohorts from the static tracker. A count from either table alone can identify the wrong recipients.

**How to apply:** First establish the exact send window from `resend_webhook_events`, then intersect the tracker email list with application suppressions and exclude recipients whose prior send history shows a different campaign or a later eligibility date. Preserve the suppression and webhook records when removing tracker rows.
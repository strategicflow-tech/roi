---
name: ToolIndex founders campaign
description: Safety and timing rules for the isolated ToolIndex-founders outreach cohort.
---

The ToolIndex-founders campaign is separate from the legacy outreach sequence. Its preparation flow uses two send gates, but approved fixed-date one-time jobs use a durable per-run ledger and self-destroying UTC cron tasks instead of the old recurring scheduler. Message templates store the exact campaign copy; the signed unsubscribe footer is appended only when rendering the outbound HTML/text.

**Why:** The campaign was prepared from a production audit cohort and needs explicit scheduling without allowing a recurring watchdog to send early. A real unsubscribe link must be present in every rendered email without changing the approved base copy.

**How to apply:** Keep initial sends and fixed-date follow-ups in the campaign-specific tables and audit log. Keep the shared outreach policy module as the single source for both runtime checks and regression tests. Run both `isBlockedOutreachTarget` and `isJunkEmail` before each send; placeholder addresses can pass the company blocklist alone. Recheck both `email_unsubscribes` and normalized Resend bounce events immediately before each send. `followup_due_at` is maintained by a trigger rather than a generated column because this PostgreSQL setup rejects `timestamptz + interval` generated expressions as non-immutable; fixed-date follow-up runs intentionally do not use that column.
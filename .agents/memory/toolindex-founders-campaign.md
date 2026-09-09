---
name: ToolIndex founders campaign
description: Safety and timing rules for the isolated ToolIndex-founders outreach cohort.
---

The ToolIndex-founders campaign is separate from the legacy outreach sequence and must remain behind two send gates: the campaign database row and the explicit environment flag. Message templates store the exact campaign copy; the signed unsubscribe footer is appended only when rendering the outbound HTML/text.

**Why:** The campaign was prepared from a production audit cohort but must not send until the owner explicitly approves it. A real unsubscribe link must be present in every rendered email without changing the approved base copy.

**How to apply:** Keep initial sends and +4-day follow-ups in the campaign-specific tables and audit log. `followup_due_at` is maintained by a trigger rather than a generated column because this PostgreSQL setup rejects `timestamptz + interval` generated expressions as non-immutable.
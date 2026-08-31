---
name: Tracker send verification
description: How to verify outreach tracker sends when the endpoint does not persist per-recipient results
---

Resend `email.sent` webhook events are the reliable provider-side evidence that a tracker email was accepted. `email.delivered` and `email.bounced` are later lifecycle outcomes, not HTTP request failures.

**Why:** The tracker send endpoint can return per-recipient results without persisting the batch or failed responses, so `global_email_log` cannot prove tracker sends and missing webhook rows cannot identify the exact failed request.

**How to apply:** For future investigations, correlate a narrow UTC time window, subject variants, recipient, and `email_id` from `resend_webhook_events`; treat an exact provider-event count as accepted sends, and do not infer a request failure list unless endpoint results or access logs were durably recorded.
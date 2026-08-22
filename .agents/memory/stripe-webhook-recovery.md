---
name: Stripe webhook recovery
description: Reliability rules for Stripe retries, concurrent deliveries, and payment-side effects.
---

Webhook ledger identity must include both the Stripe event ID and the receiving endpoint. A delivery that is currently being processed must receive a retryable response, not a duplicate-success response; only completed work may be acknowledged as a duplicate. Payment-side grants must be durable and idempotent on the payment session, with the grant record and balance mutation committed atomically.

**Why:** Stripe can deliver the same event to multiple endpoints and retry while an earlier handler is still working. Treating those cases as completed loses failed work or can duplicate effects such as credits and notifications.

**How to apply:** When adding a webhook endpoint or fulfillment effect, keep processing ownership exclusive until finalization, preserve retry behavior for work in progress, and use a unique durable effect key plus a transaction for any balance, entitlement, or credit change.
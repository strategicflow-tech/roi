---
name: Resend delivery verification
description: What can and cannot be confirmed when checking campaign delivery.
---

The application's global email log records successful send calls, not inbox delivery. The production database does not currently store Resend delivery webhooks, so “sent” must not be reported as “delivered.” In this workspace, the bound Resend connector can report an invalid key while the project secret used by the application is valid; direct provider verification with the project secret then works.

**Why:** A campaign can be accepted by Resend and later bounce, be rejected by a receiving server, or be filtered before reaching the inbox.

**How to apply:** For delivery/bounce/complaint counts, query Resend provider events with the connected Resend integration. If it returns an authentication error, have the user update the Resend API key through Replit's integration/secrets flow; never ask for or paste the key in chat.

Scheduled marketing sends should take a complete Resend suppression snapshot immediately before sending and fail closed if that lookup fails. Release any in-flight newsletter reservation so a later scheduled run can retry safely.

**Why:** A provider suppression can exist even when the application's local unsubscribe table has no matching row; sending without a successful snapshot risks re-contacting a bounced or complained-about address, while retaining a failed reservation silently loses the edition.

**How to apply:** Keep the suppression lookup outside the per-recipient send call but before the first send, paginate until Resend reports no more results, and treat incomplete pagination or provider errors as a retryable preflight failure.
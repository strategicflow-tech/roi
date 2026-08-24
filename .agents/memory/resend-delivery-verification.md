---
name: Resend delivery verification
description: What can and cannot be confirmed when checking campaign delivery.
---

The application's global email log records successful send calls, not inbox delivery. The production database does not currently store Resend delivery webhooks, so “sent” must not be reported as “delivered.”

**Why:** A campaign can be accepted by Resend and later bounce, be rejected by a receiving server, or be filtered before reaching the inbox.

**How to apply:** For delivery/bounce/complaint counts, query Resend provider events with the connected Resend integration. If it returns an authentication error, have the user update the Resend API key through Replit's integration/secrets flow; never ask for or paste the key in chat.
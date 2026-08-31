---
name: Outreach suppression enforcement
description: How to stop campaign recipients immediately when the deployed admin-token allowlist lags behind workspace code.
---

The public unsubscribe endpoint immediately writes the address to the global suppression table and sets `stop_sequence=true`; use it when production is still running an older admin route allowlist. The admin engagement route can add a human-readable reason after the updated build is published.

**Why:** Production may reject a newly authorized header-only admin route until the workspace is republished, but scheduled sends must still stop immediately.

**How to apply:** For a user-requested permanent stop, verify both the global unsubscribe record and sequence stop flag in production. Treat any prior send rows as history, not permission to send again.
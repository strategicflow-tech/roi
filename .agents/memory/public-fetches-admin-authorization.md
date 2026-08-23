---
name: Public fetches and admin authorization
description: Security boundary rules for server-side URL retrieval and ToolIndex/Strategic Flow administration.
---

Any server-side retrieval of a URL that can originate from a visitor, a submitted listing, a feed, or stored external data must go through the shared public URL fetch boundary. Browser-admin operations require the existing server-side admin session, and every state-changing request requires the session CSRF token. Credentials in URLs are rejected.

**Why:** Public URL retrieval otherwise enables internal-network access and unbounded responses. Query credentials leak to browser history, referrers, logs, and shared links; GET mutations also permit accidental activation.

**How to apply:** Before adding a new URL-consuming endpoint or enrichment job, use the shared safe fetch/validation helpers rather than native fetch. Put new browser admin routes behind the central admin guard and send CSRF on unsafe methods. Reserve the header-only job token for documented non-browser maintenance work, never for page URLs.

**Manual listing inserts — dev vs production:** Dev and production use **separate databases**. Any listing inserted directly into dev via `pool.query` or `node -e` does NOT appear in production. Always insert manual listings via a one-time `/admin/insert-*` endpoint called on the production URL after deploy. These endpoints must be in `ADMIN_MUTATING_GET_PATHS` and called via `curl -X POST -H "x-admin-job-token: $WHY_ADMIN_KEY" https://strategic-flow-audit.replit.app/admin/insert-*` — never via `?key=` (blocked). The middleware converts POST→GET and injects the key for the handler.
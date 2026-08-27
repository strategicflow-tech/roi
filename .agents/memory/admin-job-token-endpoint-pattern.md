---
name: Admin job-token endpoint pattern
description: Secure patterns for maintenance endpoints that use the internal admin job token.
---

Admin maintenance endpoints that must be called without a browser session need a header-only job-token path; URL query credentials are rejected. Keep POST endpoints in a separate allowlist from GET endpoints, because the GET allowlist rewrites authorized POST requests to GET for legacy handlers.

**Why:** A POST endpoint placed in the GET allowlist can authenticate successfully and still become `Cannot GET` before its handler runs, while query-string keys are intentionally rejected to avoid credential leakage.

**How to apply:** Use `x-admin-job-token` from a shell environment variable, add POST handlers to a dedicated POST allowlist, and only rewrite methods for legacy routes that are actually implemented as GET.
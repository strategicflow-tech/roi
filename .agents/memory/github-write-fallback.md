---
name: GitHub write fallback
description: Reliable fallback when GitHub integration write requests are blocked by the Replit proxy
---

When a healthy GitHub connection can read a repository and reports push permission but `proxyFetch` or the native REST client receives a Cloudflare 403 on writes, use the already authenticated GitHub CLI for the repository operation. Do not expose or print token values.

**Why:** The connector's read path and push permission can be healthy while the Replit proxy blocks GitHub write requests at Cloudflare, so retrying the same REST method does not make progress.

**How to apply:** Verify the repository HEAD before editing, work in a temporary clone, validate the complete diff, and push through the authenticated CLI. Keep workspace files untouched when the target repository is external.
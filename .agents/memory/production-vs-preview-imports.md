---
name: Production versus preview imports
description: Admin data imports must target the published deployment when the user asks for production changes.
---

The workspace preview and the published deployment can point at different PostgreSQL environments. A successful admin response from the preview can therefore mutate development while appearing identical to a production import.

**Why:** A batch import through the preview created low-ID development rows, while the same route through the published URL created the intended high-ID production rows.

**How to apply:** Resolve the published `primaryUrl` before production mutations, call the admin route there with the job token, and verify the resulting rows against the production database. Remove accidental preview writes before reporting completion.
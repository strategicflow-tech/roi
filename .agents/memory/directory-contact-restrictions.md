---
name: Directory contact restrictions
description: Durable rules for blocking hostile directory contacts and preventing re-import or claim bypasses.
---

Permanent directory contact restrictions must be enforced centrally before outreach and independently at every user-controlled entry point that can create, claim, edit, or monetize a listing. A tracker-side filter is useful defense in depth, but must never be the only gate.

**Why:** A blocked contact can reappear through a new import, a different listing state, or a non-outreach flow; relying only on the outreach queue leaves claim, checkout, and publication paths open.

**How to apply:** Keep the exact email and domain restriction in the server-side blocklist, reject public submit/claim/checkout and admin claim/import/activation paths, preserve an admin-only audit note before hard deletion, and require a republish before expecting production to enforce code changes.
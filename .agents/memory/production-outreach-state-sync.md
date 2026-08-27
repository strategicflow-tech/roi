---
name: Production outreach state sync
description: Preserve outreach history and A/B assignments when moving a contact sequence between development and production.
---

The contact migration must carry prior step timestamps, stop state, and A/B assignment; importing only email/name fields makes already-contacted recipients look new and can trigger duplicate messages or the wrong template.

**Why:** The production importer can be older than the workspace code after a publish, and a successful row count alone does not prove that sequence state was preserved.

**How to apply:** Before any production send, confirm the live importer supports state-preserving upserts, re-import if needed, and query production for step counts and variant counts before scheduling or sending.
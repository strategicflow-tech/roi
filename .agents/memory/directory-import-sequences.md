---
name: Directory import sequences
description: Why directory listing imports need a sequence repair during startup.
---

When a directory database has historical rows inserted with explicit IDs, the `directory_listings.id` SERIAL sequence can lag behind `MAX(id)` and make otherwise valid imports fail with a primary-key collision. Repair the sequence from the current maximum before accepting new rows.

**Why:** The development database contained high-ID listings while its sequence still pointed near the original seed rows, so the first smoke import received an existing primary key.

**How to apply:** Keep the startup repair idempotent and non-destructive: set the sequence to `MAX(id)` with `is_called=true`, or to `1` with `is_called=false` when the table is empty. Do not rewrite listing IDs.
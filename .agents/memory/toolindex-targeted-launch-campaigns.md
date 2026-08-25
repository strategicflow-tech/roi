---
name: ToolIndex targeted launch campaigns
description: Safety and durability rules for one-time, listing-specific vote campaigns.
---

Targeted launch campaigns must use a fixed listing ID plus an exact-name guard, finite batch counts, and a unique `dir_votes` hash namespace. Treat the first campaign vote timestamp as the durable schedule anchor so restarts cannot duplicate or reset the hourly cadence.

**Why:** Generic vote-growth paths intentionally exclude protected owned listings and must not be broadened for one-off, explicitly authorized launch support.

**How to apply:** Keep the campaign separate from generic seeding, check the listing is active and matches the expected name, insert with conflict-safe hashes, and increment `vote_count` only by rows actually inserted.
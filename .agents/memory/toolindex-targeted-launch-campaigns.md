---
name: ToolIndex targeted launch campaigns
description: Safety and durability rules for one-time, listing-specific vote campaigns.
---

Targeted launch campaigns must use a fixed listing ID plus an exact-name guard, while source-wide launch seeding must use a durable arrival timestamp, finite time window, deterministic target, and unique `dir_votes` hash namespace. Treat schedule state as durable so restarts cannot duplicate or reset cadence.

**Why:** Generic vote-growth paths intentionally exclude protected owned listings and must not be broadened for one-off, explicitly authorized launch support.

**How to apply:** Keep campaigns separate from generic seeding, exclude protected owned listings, insert with conflict-safe hashes, and increment `vote_count` only by rows actually inserted.
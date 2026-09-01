---
name: Replit shared database migration quirk
description: Removing DATABASE_URL can switch development to a different, incomplete database while production still retains the legacy data.
---

Treat the Replit Database pane as potentially backed by the legacy shared database while `DATABASE_URL` exists. Removing that secret can switch development to a different database with fewer rows, even though production still has the complete legacy dataset.

**Why:** A September 1, 2026 migration attempt showed development changing from 1,367 listings and 74 claims to 764 listings and 4 claims after `DATABASE_URL` was removed; production remained complete.

**How to apply:** Export or otherwise preserve the legacy dataset before removing `DATABASE_URL`. After removal, compare representative row counts and IDs in both environments before any Republish or overwrite-data action.
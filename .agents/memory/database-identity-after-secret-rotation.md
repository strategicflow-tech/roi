---
name: Database identity after secret rotation
description: Verify the database backing the app before operational sends when connection secrets change.
---

After an automatic database-secret change, the app can start against a different database even when the schema is healthy. Compare a harmless identity signal (for example row count and maximum listing ID) between the app and the intended workspace data before sending or recreating records.

**Why:** A restart after new database connection variables were added returned `not_found` for previously verified listing IDs, while both development and production queries showed a smaller, different dataset.

**How to apply:** Stop operational sends when expected rows disappear after a secret change. Restore the original database connection through workspace secret management, then re-check the exact IDs, statuses, suppression state, and send timestamps before retrying.
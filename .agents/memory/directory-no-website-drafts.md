---
name: No-website directory drafts
description: Durable constraint for importing private directory drafts before founders supply product URLs
---

Manual directory imports can contain legitimate products whose website is not yet known. Treat an empty product URL as an intentional incomplete state, not as permission to guess a substitute or as an import failure. Storage and duplicate rules must allow more than one such draft.

**Why:** The directory supports private claim pages before publication, and different founders can independently need URL follow-up. A single-value URL uniqueness assumption breaks the second valid no-website draft.

**How to apply:** Keep these rows hidden and out of claim-email drafts until a real product URL is supplied; preserve the empty state across development and production schema changes.
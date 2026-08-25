---
name: Minified static page edits
description: Safely editing minified static HTML that is stored as a single long line.
---

When a static page is minified into one long HTML line, a partial line patch cannot reliably locate a targeted fragment. Build and validate an exact whole-line substitution that changes only the intended phrase before applying it.

**Why:** Line-oriented patching cannot match an interior substring of a single physical line, and reformatting the document would create unrelated changes.

**How to apply:** Verify the target phrase occurs exactly once, generate the replacement from the original content, then confirm the post-edit diff contains only the intended sentence.
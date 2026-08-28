---
name: ToolIndex outreach export sources
description: Distinguishes the directory claim queue from the separate general outreach sequence when building contact exports.
---

The directory claim queue and the general Campaign 3 sequence are separate contact sources. A claim-only export can therefore undercount the real outreach audience even when the admin panel is working correctly. Combined exports should retain a source label, exclude recipients marked `stop_sequence`, and preserve the distinction between `invited`, `claimed`, and sequence contacts.

**Why:** The claim queue contains listing-linked contact emails, while `outreach_seq_contacts` contains a separate imported campaign audience with no overlap. Treating one as the complete outreach pipeline produces a misleadingly small export.

**How to apply:** When asked for all ToolIndex outreach contacts, query both sources, validate stored email shapes, exclude blocked/stopped contacts, deduplicate only exact company-email pairs, and report both row count and distinct-email count.
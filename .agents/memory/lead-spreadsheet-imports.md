---
name: Lead spreadsheet imports
description: Durable handling of lightweight aggregator lead spreadsheets before ToolIndex draft import
---

Aggregator lead spreadsheets may contain only app name, public email, application URL, source, dates, and verification fields rather than the directory draft-import schema.

**Why:** The import endpoint requires normalized listing columns and a launch batch, while the source spreadsheet often lacks descriptions, categories, founder names, and images. Product content should not be invented just to satisfy the file shape.

**How to apply:** Map only factual source fields, use a factual discovery/source description when needed, leave category/founder/image blank for downstream inference/backfill, include one valid launch batch ID, and rely on root-domain deduplication. Report created and duplicate-skipped rows separately.
---
name: Strategic Flow chat initialization
description: Reliability rules for the static chat widget served on strategicflow.tech.
---

The Strategic Flow GitHub Pages widget must attach its handlers only after `DOMContentLoaded`, and it must route questions through the Strategic Flow server-side chat endpoint rather than calling an LLM provider from the browser.

**Why:** The widget is embedded unusually early in the static document. Immediate initialization can fail on browsers that have not completed parsing the widget DOM. A direct browser call to an LLM provider has no safely available credential and degrades into a misleading human-contact fallback.

**How to apply:** Keep a defensive initializer that checks every widget element, registers the open/close handlers after DOM readiness, and sends questions to the existing `/api/widget-chat` backend. Reserve direct escalation for an explicit backend response, not transport failures.
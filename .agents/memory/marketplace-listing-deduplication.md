---
name: Marketplace listing deduplication
description: Deduplication rules for directories where many products share one marketplace host
---

Shared marketplace hosts such as Chrome Web Store can contain many unrelated products under different paths. Do not treat the host's root domain as a globally unique product key for these hosts; use a path-aware identity or an explicit marketplace exception.

**Why:** A batch import was prevented from creating a legitimate Chrome extension listing because another unrelated extension already used the same host.

**How to apply:** Keep normal root-domain deduplication for ordinary product websites, but maintain an explicit allowlist of shared marketplace hosts and validate their full product URLs separately.
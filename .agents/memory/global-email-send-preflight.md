---
name: Global email send preflight
description: The project-wide safety rule for validating outbound email before provider delivery.
---

Every outbound email must pass a read-only preflight immediately before the provider call. The gate validates the normalized payload and, for non-transactional recipients, rechecks unsubscribe and cooldown state. It must fail closed when validation or the safety queries fail.

**Why:** The user explicitly requires the dry-run protection to run before any future email send, not only before one campaign. A campaign-level check alone can be bypassed by another sender.

**How to apply:** Keep all provider delivery behind the shared Resend wrapper. Campaign-specific checks, such as draft-page availability, remain additional guards rather than replacements for the global preflight.
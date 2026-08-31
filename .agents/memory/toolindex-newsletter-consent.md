---
name: ToolIndex newsletter consent
description: Consent boundary between founder marketing and operational listing-owner email.
---

Historical rule (superseded on 2026-08-31): ToolIndex promotional founder emails require explicit consent followed by email confirmation. Never infer marketing consent from a claim, submission, extracted contact address, or verified ownership alone.

**Why:** The earlier rule was based on the distinction between ownership verification and marketing permission.

**Superseding business rule (effective 2026-08-31):** An OTP-verified ToolIndex claim (`dir_claims.is_verified=TRUE`) is sufficient basis for platform-related notifications, including the Strategic Flow newsletter, provided every email (1) clearly says the recipient is receiving it because they have a claimed ToolIndex listing, (2) includes a functional unsubscribe mechanism by replying `unsubscribe` or contacting Alex directly, and (3) automatically excludes addresses already unsubscribed or present in the Resend suppression list. This does not apply to listings marked claimed but not OTP-verified; those remain excluded.

**Why:** Alex explicitly chose to treat verified ownership as sufficient for this platform-related communication, similar to the stated practice of platforms such as PeerPush.

**How to apply:** Build the newsletter cohort from OTP-verified claims only, deduplicate by normalized owner email, exclude Alex's internal addresses, and enforce unsubscribe/suppression checks immediately before every send. Keep the claim/listing explanation and unsubscribe line in every message.
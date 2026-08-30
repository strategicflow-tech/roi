---
name: ToolIndex sponsor category slots
description: The concurrency and compatibility rule for category-scoped ToolIndex sponsor inventory.
---

Category-scoped sponsor inventory must be checked under a category-specific database lock both when creating checkout sessions and when fulfilling a paid Stripe webhook. Legacy sponsors without a category remain global placements and count against every category's visible cap.

**Why:** A checkout availability check alone cannot prevent two simultaneous paid sessions from exceeding the three-placement limit, while ignoring legacy global rows would overfill listing sidebars or change existing sponsor visibility.

**How to apply:** Keep the category validation sourced from active directory categories, use the same lock key for checkout and fulfillment, and handle a payment that arrives after the cap with a refund or explicit operational review rather than activating it.
---
name: ToolIndex scheduled publishing reliability
description: How to keep ToolIndex’s in-process scheduled jobs dependable in production.
---

ToolIndex’s blog publishing and newsletter jobs are scheduled with `node-cron`, so they need a continuously running Node process. Autoscaling/idle shutdown or a busy event loop can miss a scheduled tick; a production log recorded a missed 08:00 UTC execution for that reason.

**Why:** A missed in-process timer is not replayed automatically. Startup recovery and a later watchdog reduce the impact, but neither runs while the service is stopped.

**How to apply:** Use an always-on deployment or an external scheduler for any production job that must run at a specific time. Keep daily idempotency checks, startup recovery, and a same-day watchdog as defense in depth.
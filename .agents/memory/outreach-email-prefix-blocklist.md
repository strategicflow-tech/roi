---
name: Outreach email prefix blocklist
description: Email prefix rules for outreach; founder-facing role inboxes are allowed while automated, compliance, and bounce prefixes remain blocked.
---

# Outreach email prefix blocklist

**Rule:** Allow `support@`, `hello@`, `info@`, `contact@`, `care@`, `team@`, `dev-support@`, and `admin@` as eligible outreach targets. Continue blocking clearly automated, compliance, and bounce addresses.

**Why:** The user explicitly chose to keep these founder-facing inboxes eligible; the remaining blocked prefixes are still poor or unsafe outreach targets.

**Blocked prefixes (in isBlockedOutreachTarget in server.js):**
privacy, legal, abuse, press, dpo, eudatarep, gdpr, compliance, security, service, noreply, no-reply, donotreply, do-not-reply, billing, notifications, newsletter, mailer, bounce, postmaster, webmaster

**How to apply:**
- The filter lives in `isBlockedOutreachTarget()` in server.js — all outreach paths (server routes + campaign scripts) must call this function before sending.
- Any standalone campaign script (scripts/*.js) must duplicate or import the same prefix list if it doesn't call isBlockedOutreachTarget directly.
- When writing new campaign scripts, always grep for the current prefix list in server.js and copy it into the script.

---
name: Outreach email prefix blocklist
description: Role-based/generic email prefixes that must never receive outreach emails — user explicitly required this after support@ addresses sent auto-replies.
---

# Outreach email prefix blocklist

**Rule:** Never send outreach or campaign emails to role-based / generic email prefixes.

**Why:** Sending to support@, help@, etc. triggers automated out-of-office / "not interested" auto-replies, wastes sends, and upsets the user.

**Blocked prefixes (in isBlockedOutreachTarget in server.js):**
privacy, legal, abuse, press, dpo, eudatarep, gdpr, compliance, security, **support, help, noreply, no-reply, donotreply, do-not-reply, billing, notifications, newsletter, mailer, bounce, postmaster, webmaster, admin**

**How to apply:**
- The filter lives in `isBlockedOutreachTarget()` in server.js — all outreach paths (server routes + campaign scripts) must call this function before sending.
- Any standalone campaign script (scripts/*.js) must duplicate or import the same prefix list if it doesn't call isBlockedOutreachTarget directly.
- When writing new campaign scripts, always grep for the current prefix list in server.js and copy it into the script.

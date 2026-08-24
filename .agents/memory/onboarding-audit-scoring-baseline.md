---
name: Onboarding audit scoring baseline
description: Live test results confirming the honest scoring engine returns variable scores across content quality levels (run 2026-08-24)
---

## Test run — 2026-08-24

Ran three inputs against the live `/onboarding-audit` endpoint using `claude-sonnet-5`.

### Input A — Deliberately weak onboarding
- Generic 9-step sequence, feature-list, "Welcome aboard!", no consequence framing
- **bugs_found: 7 | original_score: 1 | rebuilt_score: 8**

### Input B — Well-structured onboarding
- Consequence-first subject, single Day-1 action, ownership CTA ("Connect my first source — 47 seconds"), timeline social proof
- **bugs_found: 1 | original_score: 8 | rebuilt_score: 9**

### Input C — Strategic Flow's own audit delivery email
- Outcome-led subject, concrete bug list with named fixes, score disclosure, clear ownership CTA
- **bugs_found: 3 | original_score: 5.8 | rebuilt_score: 8.5**

## Verdict
**PASS.** Scores span 1–8 across inputs. No clustering. The honest scoring rules in `ONBOARDING_AUDIT_SYSTEM_PROMPT` are working correctly.

Note on Input A: task plan expected score 2–4 for 7 bugs. Engine returned score 1, which is correct per the prompt calibration table ("1–2: all 7 checkpoints fail"). This is not a defect — it's tighter calibration than the estimate predicted.

## What NOT to change
The prompt already has explicit score-band anchors (lines 22052–22057 of server.js). Do not add redundant calibration examples unless a future test shows regression back to clustering.

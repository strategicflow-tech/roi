---
name: HTML tag audits: avoid single-line regex false positives
description: Why bash/grep-based checks for <title>, <h1>, meta tags can wrongly report them as missing, and what to use instead.
---
When auditing many HTML pages for SEO (missing <title>, <h1>, meta description, schema), a quick `grep -oE "<title>.*</title>"` or bare `<h1[^>]*>.*?</h1>` pattern will falsely report a tag as missing if:
- the tag has attributes (`<title data-i18n="...">`) and the regex expects the exact literal `<title>`
- the tag's content spans multiple lines (grep is line-based by default; ERE `.*?` doesn't behave as non-greedy)

**Why:** This happened during a full-site SEO audit — several pages were reported as "missing H1" or "missing title" and fixes were drafted/applied before re-verification caught that the tags existed all along, causing duplicate tags that had to be reverted.

**How to apply:** Before concluding a tag is missing (and before committing any fix), re-check with a proper parse: `python3 -c "import re; content=open(f).read(); re.findall(r'<title[^>]*>.*?</title>', content, re.S)"` (note `[^>]*` for attributes and `re.S` for multiline). Only trust the negative result once confirmed this way.

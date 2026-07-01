---
name: claude-sonnet-5 adaptive thinking
description: Non-obvious behavior of claude-sonnet-5 SDK responses — multiple content blocks, minimum token budget.
---

## Rule
When using `claude-sonnet-5`, always:
1. Use `max_tokens: 16000` (not 4096) — the model allocates tokens for adaptive thinking internally; 4096 is too small and leaves no room for the text response.
2. Extract text with `response.content.find(b => b.type === 'text')?.text` — NOT `response.content[0].text`, because block 0 is a `thinking` block (type: 'thinking', no `.text` field) and block 1 is the actual text.

**Why:** `claude-sonnet-5` uses adaptive thinking by default. With `max_tokens: 4096`, the thinking budget consumes all tokens and the text response is empty string. With `response.content[0].text` you always get `undefined` since block 0 is the thinking block.

**How to apply:** Any new Claude API call using `claude-sonnet-5` (the MODEL constant) must set `max_tokens: 16000` and use `.find(b => b.type === 'text')?.text` to extract the response. `max_tokens: 100` works for simple outputs (score-subject) only because thinking is skipped at very low budgets.

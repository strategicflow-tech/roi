const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// API endpoint - cheia sta pe server, niciodata in browser
app.post('/audit', async (req, res) => {
  const { company, name, email, goal, subject, body } = req.body;

  if (!company || !name || !email || !subject || !body) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const prompt = `You are the Strategic Flow audit engine. Analyze this SaaS email using the exact Strategic Flow Method — the same used for Cato Networks, Revolut, Uber Rentals, Wizz Air, HeyGen, and Memrise.

Company: ${company}
Contact: ${name} (${email})
Goal: ${goal || 'General conversion improvement'}
Subject Line: "${subject}"
Email Body:
---
${body}
---

Return ONLY valid JSON. No markdown fences, no explanation outside the JSON.

{
  "diagnosis": "2-3 sentences. Name the exact failure pattern — e.g. Feature-First Bias, Filing Label Subject, Consequence-After-Caveat, Missing Hierarchy, Zero Social Proof. Be specific to THIS email.",

  "issues": [
    {
      "title": "Name of the issue",
      "description": "2-3 sentences. WHY this kills conversion. Reference specific lines from the email.",
      "before": "The actual problematic line from the email — quote it directly",
      "after": "The Strategic Flow rewrite — specific, outcome-first, concrete"
    },
    { "title": "...", "description": "...", "before": "...", "after": "..." },
    { "title": "...", "description": "...", "before": "...", "after": "..." }
  ],

  "upgrades": [
    {
      "title": "Subject line: curiosity gap over filing label",
      "description": "Specific diagnosis of this email subject line + Strategic Flow principle + exact rewrite."
    },
    {
      "title": "Lead: consequence before caveat",
      "description": "Does this email open with a disclaimer or context? Name it. Rewrite to open with the reader outcome."
    },
    {
      "title": "Feature-to-outcome translation",
      "description": "Identify the worst feature-dump. Apply: [Technical fact] → [What the team no longer has to do]. Give exact before/after."
    },
    {
      "title": "Visual hierarchy: major announcement leads",
      "description": "Does the email treat everything as equal weight? Name the most important item and how to make it lead."
    },
    {
      "title": "Before/after contrast: make it the story",
      "description": "Is the old-state/new-state contrast visible or buried? Explain where it is missing and how to surface it."
    },
    {
      "title": "Social proof: third-party voice",
      "description": "Is there a named customer quote? What would the ideal role-specific, outcome-specific quote look like for this email?"
    },
    {
      "title": "CTA: ownership language over guest language",
      "description": "How many CTAs exist? What language is used? Rewrite using ownership language (Claim / Start my / See what changed in my account)."
    }
  ]
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', err);
      return res.status(500).json({ error: 'Audit engine error. Please try again.' });
    }

    const data = await response.json();
    const raw = data.content.map(b => b.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    res.json(parsed);

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Toate celelalte rute -> index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Strategic Flow Audit running on port ${PORT}`);
});
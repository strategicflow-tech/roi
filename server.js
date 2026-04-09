const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_usage (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      audit_count INTEGER NOT NULL DEFAULT 0,
      first_audit_at TIMESTAMP DEFAULT NOW(),
      last_audit_at TIMESTAMP DEFAULT NOW()
    )
  `);
}
ensureTable().catch(err => console.error('DB init error:', err.message));

// API endpoint - cheia sta pe server, niciodata in browser
app.post('/audit', async (req, res) => {
  const { company, name, email, goal, subject, body } = req.body;

  if (!company || !name || !email || !subject || !body) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    // Check usage
    const usageResult = await pool.query(
      'SELECT audit_count FROM audit_usage WHERE email = $1',
      [normalizedEmail]
    );

    if (usageResult.rows.length > 0 && usageResult.rows[0].audit_count >= 1) {
      return res.status(403).json({
        limitReached: true,
        message: "You've used your free audit. Book a paid session at strategicflow.carrd.co"
      });
    }
  } catch (dbErr) {
    console.error('DB check error:', dbErr.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.', detail: dbErr.message });
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

  let raw = '';
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    console.log(`[audit] calling Anthropic for ${normalizedEmail}, prompt length: ${prompt.length}`);

    let message;
    try {
      message = await client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      });
    } catch (apiErr) {
      const status = apiErr.status || apiErr.statusCode || 'unknown';
      const detail = apiErr.message || String(apiErr);
      console.error(`[audit] Anthropic API error — status: ${status}, message: ${detail}`);
      if (apiErr.error) console.error('[audit] Anthropic error body:', JSON.stringify(apiErr.error));
      return res.status(502).json({
        error: 'Anthropic API call failed.',
        status,
        detail
      });
    }

    raw = message.content.map(b => b.text || '').join('');
    console.log(`[audit] raw response length: ${raw.length}, stop_reason: ${message.stop_reason}`);

    // Robustly extract the JSON object — find the outermost { ... }
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.error('[audit] No JSON found in model response. Raw output:', raw.slice(0, 500));
      return res.status(500).json({
        error: 'Model did not return valid JSON.',
        raw: raw.slice(0, 500)
      });
    }
    const clean = raw.slice(start, end + 1);

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      console.error('[audit] JSON parse failed:', parseErr.message);
      console.error('[audit] Attempted to parse:', clean.slice(0, 500));
      return res.status(500).json({
        error: 'Failed to parse model response as JSON.',
        detail: parseErr.message,
        raw: clean.slice(0, 500)
      });
    }

    // Record usage — insert or increment
    await pool.query(`
      INSERT INTO audit_usage (email, audit_count, first_audit_at, last_audit_at)
      VALUES ($1, 1, NOW(), NOW())
      ON CONFLICT (email) DO UPDATE
        SET audit_count = audit_usage.audit_count + 1,
            last_audit_at = NOW()
    `, [normalizedEmail]);

    console.log(`[audit] success for ${normalizedEmail}`);
    res.json(parsed);

  } catch (err) {
    console.error('[audit] unexpected error:', err.message || err);
    res.status(500).json({ error: 'Something went wrong. Please try again.', detail: err.message });
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

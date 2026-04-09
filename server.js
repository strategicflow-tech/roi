const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.query(`
  CREATE TABLE IF NOT EXISTS audit_usage (
    email VARCHAR(255) PRIMARY KEY,
    audit_count INTEGER NOT NULL DEFAULT 0,
    first_audit_at TIMESTAMP DEFAULT NOW(),
    last_audit_at TIMESTAMP DEFAULT NOW()
  )
`).catch(err => console.error('DB init error:', err.message));

app.post('/audit', async (req, res) => {
  try {
    const { company, name, email, goal, subject, body } = req.body;
    const normalizedEmail = (email || '').trim().toLowerCase();

    // Check usage limit
    const { rows } = await pool.query(
      'SELECT audit_count FROM audit_usage WHERE email = $1',
      [normalizedEmail]
    );
    if (rows.length > 0 && rows[0].audit_count >= 1) {
      return res.status(403).json({ limitReached: true });
    }

    // Call Anthropic
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4000,
      messages: [{ role: 'user', content: `You are the Strategic Flow audit engine. Analyze this SaaS email and return ONLY valid JSON with keys: diagnosis (string), issues (array of {title,description,before,after}), upgrades (array of {title,description}).\n\nCompany: ${company}\nContact: ${name} (${email})\nGoal: ${goal || 'General conversion improvement'}\nSubject: "${subject}"\nBody:\n${body}` }]
    });
    const raw = message.content.map(b => b.text || '').join('');
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));

    // Record usage
    await pool.query(`
      INSERT INTO audit_usage (email, audit_count) VALUES ($1, 1)
      ON CONFLICT (email) DO UPDATE
        SET audit_count = audit_usage.audit_count + 1, last_audit_at = NOW()
    `, [normalizedEmail]);

    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message, status: err.status || null, body: err.error || null });
  }
});

app.post('/debug', async (req, res) => {
  const { company, name, email, goal, subject, body } = req.body;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 4000,
    messages: [{ role: 'user', content: `You are the Strategic Flow audit engine. Analyze this SaaS email and return ONLY valid JSON with keys: diagnosis (string), issues (array of {title,description,before,after}), upgrades (array of {title,description}).\n\nCompany: ${company}\nContact: ${name} (${email})\nGoal: ${goal || 'General conversion improvement'}\nSubject: "${subject}"\nBody:\n${body}` }]
  });
  res.type('text/plain').send(JSON.stringify(message, null, 2));
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});

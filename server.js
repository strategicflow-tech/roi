const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const { Resend } = require('resend');

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

async function getResendClient() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? 'depl ' + process.env.WEB_REPL_RENEWAL
    : null;

  if (!xReplitToken || !hostname) {
    throw new Error('Resend connector credentials not available');
  }

  const data = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=resend',
    {
      headers: {
        'Accept': 'application/json',
        'X-Replit-Token': xReplitToken
      }
    }
  ).then(res => res.json());

  const settings = data.items?.[0]?.settings;
  if (!settings?.api_key) throw new Error('Resend not connected');

  return { client: new Resend(settings.api_key), fromEmail: settings.from_email };
}

function buildEmailHtml(company, parsed) {
  const issuesHtml = (parsed.issues || []).map((issue, i) => `
    <div style="margin-bottom:24px;padding:16px;background:#f9f9f9;border-left:4px solid #00d4c8;border-radius:4px;">
      <h3 style="margin:0 0 8px;color:#111;font-size:15px;">Issue ${i + 1}: ${issue.title}</h3>
      <p style="margin:0 0 12px;color:#444;font-size:14px;line-height:1.6;">${issue.description}</p>
      <div style="margin-bottom:8px;">
        <strong style="color:#c0392b;font-size:12px;text-transform:uppercase;">Before</strong>
        <p style="margin:4px 0 0;padding:10px;background:#fff5f5;border-radius:4px;font-size:13px;color:#555;font-style:italic;">"${issue.before}"</p>
      </div>
      <div>
        <strong style="color:#27ae60;font-size:12px;text-transform:uppercase;">After</strong>
        <p style="margin:4px 0 0;padding:10px;background:#f0fff4;border-radius:4px;font-size:13px;color:#555;font-style:italic;">"${issue.after}"</p>
      </div>
    </div>
  `).join('');

  const upgradesHtml = (parsed.upgrades || []).map((upgrade, i) => `
    <div style="margin-bottom:16px;padding:14px;background:#f9f9f9;border-radius:4px;">
      <h4 style="margin:0 0 6px;color:#111;font-size:14px;">Upgrade ${i + 1}: ${upgrade.title}</h4>
      <p style="margin:0;color:#444;font-size:13px;line-height:1.6;">${upgrade.description}</p>
    </div>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:#0a0e1a;padding:28px 32px;">
      <p style="margin:0;color:#00d4c8;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Strategic Flow</p>
      <h1 style="margin:8px 0 0;color:#fff;font-size:22px;font-weight:800;">Your Email Audit Results</h1>
      <p style="margin:6px 0 0;color:#8899aa;font-size:13px;">${company}</p>
    </div>

    <div style="padding:32px;">
      <h2 style="margin:0 0 12px;color:#111;font-size:17px;">The Diagnosis</h2>
      <p style="margin:0 0 32px;color:#444;font-size:14px;line-height:1.7;padding:16px;background:#f0f8ff;border-radius:6px;">${parsed.diagnosis}</p>

      <h2 style="margin:0 0 16px;color:#111;font-size:17px;">Issues Found</h2>
      ${issuesHtml}

      <h2 style="margin:24px 0 16px;color:#111;font-size:17px;">The 7 Strategic Flow Upgrades</h2>
      ${upgradesHtml}

      <div style="margin-top:32px;padding:20px;background:#0a0e1a;border-radius:8px;text-align:center;">
        <p style="margin:0 0 4px;color:#fff;font-size:14px;font-weight:700;">Want the full rebuild?</p>
        <p style="margin:0 0 12px;color:#8899aa;font-size:13px;">Reply to this email to get started.</p>
        <a href="mailto:strategicflow@proton.me?subject=Strategic%20Flow%20Audit%20Request" style="display:inline-block;background:#00d4c8;color:#0a0e1a;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:700;font-size:14px;">Get Your Full Rebuild</a>
      </div>
    </div>

    <div style="padding:16px 32px;border-top:1px solid #eee;background:#fafafa;">
      <p style="margin:0;color:#999;font-size:11px;text-align:center;">
        Strategic Flow &nbsp;|&nbsp;
        <a href="mailto:strategicflow@proton.me" style="color:#00d4c8;text-decoration:none;">strategicflow@proton.me</a> &nbsp;|&nbsp;
        <a href="https://strategicflow.carrd.co" style="color:#00d4c8;text-decoration:none;">strategicflow.carrd.co</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

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

    // Send email with results (non-blocking — don't fail the response if email fails)
    try {
      const { client: resend, fromEmail } = await getResendClient();
      await resend.emails.send({
        from: fromEmail || 'Strategic Flow <onboarding@resend.dev>',
        to: [email],
        subject: `Your Strategic Flow Audit — ${company}`,
        html: buildEmailHtml(company, parsed)
      });
    } catch (emailErr) {
      console.error('Email send failed:', emailErr.message);
    }

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

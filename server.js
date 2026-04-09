const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const { Resend } = require('resend');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const WHITELISTED_EMAILS = ['strategicflow@proton.me'];

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

// Standalone HTML attachment — dark-themed, mirrors the live results page
function buildAuditAttachmentHtml(company, name, email, parsed) {
  const issuesHtml = (parsed.issues || []).map((issue, i) => `
    <div style="background:#111d35;border:1px solid #1e2f50;border-left:3px solid #ff4455;border-radius:12px;padding:20px 24px;margin-bottom:12px;">
      <div style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#ff4455;margin-bottom:6px;">Issue ${i + 1} of ${(parsed.issues || []).length}</div>
      <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:700;margin-bottom:8px;">⚠ ${issue.title || ''}</div>
      <div style="font-size:12px;color:#6b7fa3;line-height:1.7;margin-bottom:12px;">${issue.description || ''}</div>
      ${issue.before && issue.after ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px;">
        <div style="background:rgba(255,68,85,0.07);border:1px solid rgba(255,68,85,0.25);border-radius:8px;padding:12px;">
          <div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;font-weight:600;color:#ff4455;margin-bottom:6px;">❌ Before</div>
          <div style="font-size:12px;line-height:1.6;color:#e8edf5;">${issue.before}</div>
        </div>
        <div style="background:rgba(0,212,200,0.07);border:1px solid rgba(0,212,200,0.25);border-radius:8px;padding:12px;">
          <div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;font-weight:600;color:#00d4c8;margin-bottom:6px;">✅ After — Strategic Flow</div>
          <div style="font-size:12px;line-height:1.6;color:#e8edf5;">${issue.after}</div>
        </div>
      </div>` : ''}
    </div>`).join('');

  const upgradesHtml = (parsed.upgrades || []).map((upg, i) => `
    <div style="padding:20px 24px;border-bottom:1px solid #1e2f50;display:flex;gap:16px;align-items:flex-start;">
      <div style="width:28px;height:28px;background:rgba(0,212,200,0.1);border:1px solid rgba(0,212,200,0.3);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#00d4c8;flex-shrink:0;line-height:28px;text-align:center;">${i + 1}</div>
      <div>
        <div style="font-family:'Syne',sans-serif;font-size:13px;font-weight:700;margin-bottom:4px;">${upg.title || ''}</div>
        <div style="font-size:12px;color:#6b7fa3;line-height:1.65;">${upg.description || ''}</div>
      </div>
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Strategic Flow Audit — ${company}</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:ital,wght@0,300;0,400;1,300&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{background:#070d1a;color:#e8edf5;font-family:'DM Mono',monospace;min-height:100vh;padding:40px 20px 80px;}
  body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(0,212,200,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,200,0.03) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0;}
  .wrap{max-width:820px;margin:0 auto;position:relative;z-index:1;}
  .badge{display:inline-block;background:rgba(0,212,200,0.1);border:1px solid #00d4c8;border-radius:100px;padding:6px 16px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#00d4c8;margin-bottom:16px;}
  h2{font-family:'Syne',sans-serif;font-size:clamp(22px,4vw,32px);font-weight:800;margin-bottom:8px;}
  .sub{color:#6b7fa3;font-size:13px;margin-bottom:32px;}
  .card{background:#111d35;border:1px solid #1e2f50;border-radius:16px;overflow:hidden;margin-bottom:16px;}
  .card-hdr{background:#0d1628;border-bottom:1px solid #1e2f50;padding:14px 24px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#00d4c8;display:flex;align-items:center;gap:10px;}
  .card-body{padding:24px;font-size:13px;line-height:1.8;}
  .diag{color:#e8edf5;font-style:italic;border-left:3px solid #00d4c8;padding-left:16px;}
  .offer{background:linear-gradient(135deg,rgba(0,212,200,0.1),rgba(0,212,200,0.03));border:1px solid rgba(0,212,200,0.4);border-radius:12px;padding:20px 24px;text-align:center;margin-bottom:16px;}
  .offer p{font-size:13px;line-height:1.8;}
  .offer strong,.offer a{color:#00d4c8;}
  .offer a{text-decoration:none;}
  .footer{text-align:center;color:#6b7fa3;font-size:11px;margin-top:32px;padding-top:16px;border-top:1px solid #1e2f50;}
  .footer a{color:#00d4c8;text-decoration:none;}
</style>
</head>
<body>
<div class="wrap">
  <div style="text-align:center;margin-bottom:32px;">
    <div style="display:inline-flex;align-items:center;gap:10px;background:#111d35;border:1px solid #1e2f50;border-radius:100px;padding:8px 18px;margin-bottom:20px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#00d4c8;">
      <div style="width:7px;height:7px;background:#00d4c8;border-radius:50%;"></div>Strategic Flow · Audit Report
    </div>
    <div class="badge">✓ Audit Complete</div>
    <h2>Your Strategic Flow Breakdown</h2>
    <p class="sub">${company} &nbsp;·&nbsp; ${name} &lt;${email}&gt;</p>
  </div>

  <div class="card">
    <div class="card-hdr"><span>⚡</span> The Diagnosis</div>
    <div class="card-body"><p class="diag">${parsed.diagnosis || ''}</p></div>
  </div>

  <div style="display:grid;gap:12px;margin-bottom:16px;">${issuesHtml}</div>

  <div class="card">
    <div class="card-hdr"><span>🔧</span> The 7 Strategic Flow Upgrades</div>
    <div>${upgradesHtml}</div>
  </div>

  <div class="offer" style="margin-top:16px;">
    <p>Want <strong>8 emails like this every month?</strong><br>
    Contact <a href="mailto:strategicflow@proton.me">strategicflow@proton.me</a> — mention your audit and get <strong>20% off your first month.</strong></p>
  </div>

  <div class="footer">
    Strategic Flow &nbsp;|&nbsp;
    <a href="mailto:strategicflow@proton.me">strategicflow@proton.me</a> &nbsp;|&nbsp;
    <a href="https://strategicflow.carrd.co">strategicflow.carrd.co</a>
  </div>
</div>
</body>
</html>`;
}

// Email notification body (plain email, light-themed for inbox)
function buildEmailHtml(company, name, email, parsed) {
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
    </div>`).join('');

  const upgradesHtml = (parsed.upgrades || []).map((upgrade, i) => `
    <div style="margin-bottom:16px;padding:14px;background:#f9f9f9;border-radius:4px;">
      <h4 style="margin:0 0 6px;color:#111;font-size:14px;">Upgrade ${i + 1}: ${upgrade.title}</h4>
      <p style="margin:0;color:#444;font-size:13px;line-height:1.6;">${upgrade.description}</p>
    </div>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:#0a0e1a;padding:28px 32px;">
      <p style="margin:0;color:#00d4c8;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Strategic Flow</p>
      <h1 style="margin:8px 0 0;color:#fff;font-size:22px;font-weight:800;">New Audit Submitted</h1>
      <p style="margin:6px 0 0;color:#8899aa;font-size:13px;">${company} &nbsp;·&nbsp; ${name} &lt;${email}&gt;</p>
    </div>
    <div style="padding:32px;">
      <p style="color:#444;font-size:14px;margin-bottom:24px;">Full audit attached as <strong>StrategicFlow-Audit-${company}.html</strong>. Open it in any browser to view the styled results.</p>

      <h2 style="margin:0 0 12px;color:#111;font-size:17px;">The Diagnosis</h2>
      <p style="margin:0 0 32px;color:#444;font-size:14px;line-height:1.7;padding:16px;background:#f0f8ff;border-radius:6px;">${parsed.diagnosis}</p>

      <h2 style="margin:0 0 16px;color:#111;font-size:17px;">Issues Found</h2>
      ${issuesHtml}

      <h2 style="margin:24px 0 16px;color:#111;font-size:17px;">The 7 Strategic Flow Upgrades</h2>
      ${upgradesHtml}

      <div style="margin-top:32px;padding:20px;background:#fff8e1;border:1px solid #ffc107;border-radius:8px;text-align:center;">
        <p style="margin:0 0 4px;color:#111;font-size:15px;font-weight:700;">Want 8 emails like this every month?</p>
        <p style="margin:0 0 12px;color:#555;font-size:13px;">Reply to this email or contact <a href="mailto:strategicflow@proton.me" style="color:#00a89e;">strategicflow@proton.me</a> — mention your audit and get <strong>20% off your first month.</strong></p>
        <a href="mailto:strategicflow@proton.me?subject=Strategic%20Flow%20Audit%20Request" style="display:inline-block;background:#00d4c8;color:#0a0e1a;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:700;font-size:14px;">Claim My 20% Off →</a>
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
    const isWhitelisted = WHITELISTED_EMAILS.includes(normalizedEmail);

    // Check usage limit (skip for whitelisted emails)
    if (!isWhitelisted) {
      const { rows } = await pool.query(
        'SELECT audit_count FROM audit_usage WHERE email = $1',
        [normalizedEmail]
      );
      if (rows.length > 0 && rows[0].audit_count >= 1) {
        return res.status(403).json({ limitReached: true });
      }
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

    // Record usage (skip for whitelisted emails)
    if (!isWhitelisted) {
      await pool.query(`
        INSERT INTO audit_usage (email, audit_count) VALUES ($1, 1)
        ON CONFLICT (email) DO UPDATE
          SET audit_count = audit_usage.audit_count + 1, last_audit_at = NOW()
      `, [normalizedEmail]);
    }

    // Build styled HTML attachment
    const attachmentHtml = buildAuditAttachmentHtml(company, name, email, parsed);
    const safeCompany = company.replace(/[^a-zA-Z0-9-_]/g, '-');

    // Send notification email with attachment (non-blocking)
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'onboarding@resend.dev',
        to: ['consultantcalatorii@gmail.com'],
        subject: `New Audit — ${company} (${email})`,
        html: buildEmailHtml(company, name, email, parsed),
        attachments: [{
          filename: `StrategicFlow-Audit-${safeCompany}.html`,
          content: Buffer.from(attachmentHtml, 'utf-8').toString('base64')
        }]
      });
    } catch (emailErr) {
      console.error('Email send failed:', emailErr.message);
    }

    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message, status: err.status || null, body: err.error || null });
  }
});

app.post('/rewrite', async (req, res) => {
  try {
    const { company, subject, body } = req.body;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2000,
      messages: [{ role: 'user', content: `You are the Strategic Flow rewrite engine. Rewrite this SaaS email completely using the Strategic Flow Method:\n\n- Outcome-first subject line: curiosity gap, specific result or number, no filing-label titles\n- Lead with consequence before caveat: open with the reader's outcome, not a disclaimer or context\n- Translate features to outcomes: [Technical fact] → [What the team no longer has to do]\n- Human, direct tone — no corporate speak, no passive voice\n- Ownership CTA language: "Claim / Start my / See what changed" — not guest language like "Book / Try / Learn more"\n\nCompany: ${company}\nOriginal Subject: "${subject}"\nOriginal Body:\n${body}\n\nReturn ONLY valid JSON with exactly two keys:\n{"subject":"rewritten subject line","body":"full rewritten email body"}` }]
    });
    const raw = message.content.map(b => b.text || '').join('');
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
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

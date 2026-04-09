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

function robustJsonParse(raw) {
  let text = raw;

  // Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Find the outermost JSON object
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('No JSON object found in response');
  text = text.slice(start, end + 1);

  // First attempt: direct parse
  try { return JSON.parse(text); } catch (_) {}

  // Second attempt: fix common AI JSON mistakes
  const fixed = text
    .replace(/,\s*([}\]])/g, '$1')          // trailing commas
    .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":') // unquoted keys
    .replace(/:\s*'([^']*)'/g, ': "$1"');   // single-quoted values

  return JSON.parse(fixed);
}

// ─── HTML ATTACHMENT ──────────────────────────────────────────────────────────
function buildAuditAttachmentHtml(company, name, email, originalSubject, originalBody, parsed, rewrite) {
  const issues = parsed.issues || [];
  const upgrades = parsed.upgrades || [];

  const issueAmberList = issues.map(iss =>
    `<div class="issue-item"><span>⚠</span> ${iss.title}: ${iss.description}</div>`
  ).join('');

  const notesGrid = issues.slice(0, 1).map(iss => `
    <div class="note-card bad">
      <div class="note-label bad">Before</div>
      <p><strong>Subject:</strong> ${originalSubject}<br><br>${iss.before || ''}</p>
    </div>
    <div class="note-card good">
      <div class="note-label good">After</div>
      <p><strong>Subject:</strong> ${rewrite ? rewrite.subject : '—'}<br><br>${iss.after || ''}</p>
    </div>`).join('');

  const upgradeItems = upgrades.map((upg, i) => `
    <div class="upgrade-item">
      <div class="upgrade-head">${i + 1} · ${upg.title}</div>
      <div class="upgrade-desc">${upg.description}</div>
    </div>`).join('');

  const rewriteBodyFormatted = rewrite
    ? rewrite.body.replace(/\n/g, '<br>')
    : '<em style="color:#6b6b66">Rewrite unavailable.</em>';

  const originalBodyFormatted = (originalBody || '').replace(/\n/g, '<br>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Strategic Flow Audit — ${company}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@400;500&family=Figtree:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg-primary:#ffffff;--bg-secondary:#f5f5f3;--bg-tertiary:#efefec;
  --text-primary:#1a1a18;--text-secondary:#6b6b66;
  --border-light:rgba(0,0,0,0.1);--border-mid:rgba(0,0,0,0.18);
  --green:#1D9E75;--green-light:#E1F5EE;--green-dark:#085041;--green-mid:#0F6E56;--green-pale:#9FE1CB;
  --red-light:#F7C1C1;--red-dark:#791F1F;--amber-bg:#fff8f0;--amber-dark:#7a5a00;
}
html,body{width:100%;margin:0;padding:0;background:#efefec;}
body{font-family:'Figtree',sans-serif;color:var(--text-primary);padding:32px 16px;}

.page-header{max-width:720px;margin:0 auto 28px;display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;}
.page-title{font-family:'DM Serif Display',serif;font-size:30px;color:var(--text-primary);line-height:1.2;}
.page-title em{font-style:italic;color:var(--green);}
.page-sub{font-size:12px;color:var(--text-secondary);font-family:'DM Mono',monospace;letter-spacing:.04em;}
.sf-wrap{max-width:720px;margin:0 auto;}
.toggle-row{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;}
.toggle-btn{padding:7px 18px;font-family:'Figtree',sans-serif;font-size:13px;font-weight:500;border-radius:20px;border:1px solid var(--border-mid);background:transparent;color:var(--text-secondary);cursor:pointer;transition:all .2s;}
.toggle-btn:hover{background:var(--bg-secondary);}
.toggle-btn.active{background:var(--text-primary);color:#fff;border-color:var(--text-primary);}
.email-shell{border:1px solid var(--border-light);border-radius:14px;overflow:hidden;background:var(--bg-primary);box-shadow:0 4px 32px rgba(0,0,0,0.06);}
.email-toolbar{background:var(--bg-secondary);padding:10px 18px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border-light);}
.dot{width:12px;height:12px;border-radius:50%;}
.label-pill{font-size:11px;font-weight:500;padding:3px 10px;border-radius:12px;letter-spacing:.04em;text-transform:uppercase;font-family:'DM Mono',monospace;}
.before-pill{background:#F7C1C1;color:#791F1F;}
.after-pill{background:#9FE1CB;color:#085041;}
.notes-pill{background:#CECBF6;color:#3C3489;}
.meta-bar{padding:14px 22px;border-bottom:1px solid var(--border-light);}
.meta-row{font-size:12px;color:var(--text-secondary);line-height:1.9;}
.meta-row span{color:var(--text-primary);font-weight:500;}
.subject-line{font-size:16px;font-weight:500;color:var(--text-primary);margin-top:4px;}
.panel{display:none;}.panel.active{display:block;}

/* BEFORE */
.bef-body{padding:28px 24px;background:#ffffff;}
.bef-header-bar{background:#0a0e1a;padding:16px 24px;}
.bef-co{font-family:'DM Serif Display',serif;font-size:18px;color:#e8edf5;}
.bef-co-sub{font-size:9px;color:#6b7fa3;font-family:'DM Mono',monospace;letter-spacing:.1em;margin-top:2px;}
.bef-body-text{font-size:13px;color:#444;line-height:1.8;margin-top:16px;}
.before-issues{margin:0 22px 22px;padding:16px;background:var(--amber-bg);border-left:3px solid #F09F27;border-radius:0 8px 8px 0;}
.issue-item{font-size:12px;color:var(--amber-dark);margin-bottom:6px;display:flex;gap:8px;line-height:1.5;}

/* AFTER */
.after-header{background:#0a0a0a;padding:22px 28px;display:flex;align-items:center;justify-content:space-between;}
.after-logo-text{font-family:'DM Serif Display',serif;font-size:20px;color:#e8f5e0;}
.after-tagline{font-size:10px;color:#5a8a6a;letter-spacing:.14em;text-transform:uppercase;font-family:'DM Mono',monospace;}
.after-hero{padding:36px 28px 28px;border-bottom:1px solid var(--border-light);}
.after-kicker{font-size:10px;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:var(--green);font-family:'DM Mono',monospace;margin-bottom:14px;}
.after-h1{font-family:'DM Serif Display',serif;font-size:28px;line-height:1.2;color:var(--text-primary);margin-bottom:16px;}
.after-h1 em{font-style:italic;color:var(--green);}
.after-lead{font-size:14px;color:var(--text-secondary);line-height:1.75;margin-bottom:24px;}
.after-cta-primary{background:var(--green);color:white;padding:12px 24px;border-radius:7px;font-size:14px;font-weight:500;text-decoration:none;display:inline-block;}
.after-footer{padding:18px 28px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;border-top:1px solid var(--border-light);}
.footer-note{font-size:10px;color:var(--text-secondary);font-family:'DM Mono',monospace;}

/* NOTES */
.notes-body{padding:28px;}
.notes-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:24px;}
.note-card{padding:16px;border-radius:10px;font-size:12px;line-height:1.75;}
.note-card.bad{border:1px solid #F7C1C1;}
.note-card.good{border:1px solid #9FE1CB;}
.note-label{font-weight:500;margin-bottom:8px;font-size:13px;}
.note-label.bad{color:#791F1F;}.note-label.good{color:#085041;}
.note-card p{color:var(--text-secondary);}
.upgrades-title{font-size:13px;font-weight:500;margin-bottom:14px;color:var(--text-primary);}
.upgrade-item{padding:14px;background:var(--bg-secondary);border-radius:10px;border-left:2px solid var(--green);margin-bottom:10px;}
.upgrade-head{font-size:12px;font-weight:500;color:var(--text-primary);margin-bottom:5px;}
.upgrade-desc{font-size:11px;color:var(--text-secondary);line-height:1.65;}
.diagnosis-box{padding:14px 16px;background:var(--green-light);border-radius:10px;border-left:3px solid var(--green);font-size:13px;color:var(--green-dark);line-height:1.7;margin-bottom:20px;font-style:italic;}
.cta-note{padding:16px;background:var(--green-light);border-radius:10px;margin-top:6px;}
.cta-note-title{font-size:12px;font-weight:500;color:var(--green-dark);margin-bottom:5px;}
.cta-note-body{font-size:11px;color:var(--green-mid);line-height:1.65;}
.page-footer{max-width:720px;margin:28px auto 0;display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--text-secondary);font-family:'DM Mono',monospace;}
.page-footer a{color:var(--green);text-decoration:none;}
@media(max-width:560px){
  .notes-grid{grid-template-columns:1fr;}
  body{padding:16px 10px;}
}
</style>
</head>
<body>

<div class="page-header">
  <div>
    <div class="page-title">${company} — <em>Audited.</em></div>
    <div style="font-size:13px;color:var(--text-secondary);margin-top:4px;">A Strategic Flow email audit — before &amp; after · ${name} &lt;${email}&gt;</div>
  </div>
  <div class="page-sub">strategicflow.carrd.co</div>
</div>

<div class="sf-wrap">
  <div class="toggle-row">
    <button class="toggle-btn active" onclick="switchPanel('before',this)">Before</button>
    <button class="toggle-btn" onclick="switchPanel('after',this)">After — Strategic Flow</button>
    <button class="toggle-btn" onclick="switchPanel('notes',this)">What changed &amp; why</button>
  </div>

  <div class="email-shell">
    <div class="email-toolbar">
      <div class="dot" style="background:#F09595;"></div>
      <div class="dot" style="background:#FAC775;"></div>
      <div class="dot" style="background:#C0DD97;"></div>
      <div style="flex:1;margin-left:8px;">
        <span id="panel-pill" class="label-pill before-pill">Original email</span>
      </div>
    </div>

    <!-- BEFORE -->
    <div class="panel active" id="panel-before">
      <div class="meta-bar">
        <div class="meta-row"><span>From:</span> ${company} &lt;${email}&gt;</div>
        <div class="meta-row"><span>To:</span> [subscriber]</div>
        <div class="subject-line">Subject: ${originalSubject}</div>
      </div>
      <div class="bef-header-bar">
        <div class="bef-co">${company}</div>
        <div class="bef-co-sub">ORIGINAL EMAIL</div>
      </div>
      <div class="bef-body">
        <div class="bef-body-text">${originalBodyFormatted}</div>
      </div>
      <div class="before-issues">
        ${issueAmberList}
      </div>
    </div>

    <!-- AFTER -->
    <div class="panel" id="panel-after">
      <div class="meta-bar">
        <div class="meta-row"><span>From:</span> ${company} &lt;${email}&gt;</div>
        <div class="meta-row"><span>To:</span> [subscriber]</div>
        <div class="subject-line">Subject: ${rewrite ? rewrite.subject : originalSubject}</div>
      </div>
      <div class="after-header">
        <div>
          <div class="after-logo-text">${company}</div>
          <div class="after-tagline">Rebuilt by Strategic Flow</div>
        </div>
        <div style="font-family:'DM Mono',monospace;font-size:10px;color:#5a8a6a;letter-spacing:.06em;">strategicflow.carrd.co</div>
      </div>
      <div class="after-hero">
        <div class="after-kicker">Strategic Flow Method · Outcome-first · Ownership CTA</div>
        <div class="after-lead">${rewriteBodyFormatted}</div>
        <div>
          <a href="mailto:strategicflow@proton.me?subject=Strategic%20Flow%20Audit%20Request" class="after-cta-primary">Get 8 emails like this/month →</a>
        </div>
      </div>
      <div class="after-footer">
        <div style="font-size:11px;color:var(--text-secondary);">Rebuilt by <a href="https://strategicflow.carrd.co" style="color:var(--green);text-decoration:none;">Strategic Flow</a></div>
        <div class="footer-note">strategicflow@proton.me</div>
      </div>
    </div>

    <!-- NOTES -->
    <div class="panel" id="panel-notes">
      <div class="notes-body">
        <div class="diagnosis-box">${parsed.diagnosis || ''}</div>

        <div class="notes-grid">
          ${notesGrid}
        </div>

        <div class="upgrades-title">The ${upgrades.length} Strategic Flow upgrades — and why they work</div>
        ${upgradeItems}

        <div class="cta-note">
          <div class="cta-note-title">This is the Strategic Flow method</div>
          <div class="cta-note-body">Name the pain before you name the product. Put the outcome where the feature used to be. Replace the bullet inventory with a benefit story. Use one real consequence to do what 500 words of brand copy cannot. Visit <a href="https://strategicflow.carrd.co/" style="color:var(--green-mid);text-decoration:underline;">strategicflow.carrd.co</a> or reply to this audit to get 20% off your first month.</div>
        </div>
      </div>
    </div>
  </div>

  <div class="page-footer">
    <span>Strategic Flow © ${new Date().getFullYear()}</span>
    <a href="https://strategicflow.carrd.co/">strategicflow.carrd.co</a>
  </div>
</div>

<script>
function switchPanel(id,btn){
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.toggle-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('panel-'+id).classList.add('active');
  btn.classList.add('active');
  var pill=document.getElementById('panel-pill');
  var map={before:['before-pill','Original email'],after:['after-pill','After — Strategic Flow'],notes:['notes-pill','What changed & why']};
  pill.className='label-pill '+map[id][0];
  pill.textContent=map[id][1];
}
</script>
</body>
</html>`;
}

// ─── NOTIFICATION EMAIL (plain inbox version) ─────────────────────────────────
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
      <p style="color:#444;font-size:14px;margin-bottom:24px;">Full audit attached — open the HTML file in any browser to see the Before / After / What changed view.</p>
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

// ─── BACKGROUND: rewrite + email send ────────────────────────────────────────
async function sendAuditEmail(company, name, email, originalSubject, originalBody, parsed) {
  try {
    // Run rewrite API call for the "After" panel
    let rewrite = null;
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2000,
        messages: [{ role: 'user', content: `You are the Strategic Flow rewrite engine. Rewrite this SaaS email completely using the Strategic Flow Method:\n\n- Outcome-first subject line: curiosity gap, specific result or number, no filing-label titles\n- Lead with consequence before caveat: open with the reader's outcome, not a disclaimer or context\n- Translate features to outcomes: [Technical fact] → [What the team no longer has to do]\n- Human, direct tone — no corporate speak, no passive voice\n- Ownership CTA language: "Claim / Start my / See what changed" — not guest language like "Book / Try / Learn more"\n\nCompany: ${company}\nOriginal Subject: "${originalSubject}"\nOriginal Body:\n${originalBody}\n\nReturn ONLY valid JSON with exactly two keys:\n{"subject":"rewritten subject line","body":"full rewritten email body"}` }]
      });
      const raw = msg.content.map(b => b.text || '').join('');
      rewrite = robustJsonParse(raw);
    } catch (rwErr) {
      console.error('Rewrite for attachment failed:', rwErr.message);
    }

    const safeCompany = company.replace(/[^a-zA-Z0-9-_]/g, '-');
    const attachmentHtml = buildAuditAttachmentHtml(company, name, email, originalSubject, originalBody, parsed, rewrite);

    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send({
      from: 'onboarding@resend.dev',
      to: ['consultantcalatorii@gmail.com'],
      subject: `New Audit — ${company} (${email})`,
      html: buildEmailHtml(company, name, email, parsed),
      attachments: [{
        filename: `StrategicFlow-Audit-${safeCompany}.html`,
        content: Buffer.from(attachmentHtml, 'utf-8').toString('base64')
      }]
    });
    if (result.error) console.error('Email send failed:', result.error.message);
  } catch (err) {
    console.error('sendAuditEmail error:', err.message);
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.post('/audit', async (req, res) => {
  try {
    const { company, name, email, goal, subject, body } = req.body;
    const normalizedEmail = (email || '').trim().toLowerCase();
    const isWhitelisted = WHITELISTED_EMAILS.includes(normalizedEmail);

    if (!isWhitelisted) {
      const { rows } = await pool.query(
        'SELECT audit_count FROM audit_usage WHERE email = $1', [normalizedEmail]
      );
      if (rows.length > 0 && rows[0].audit_count >= 1) {
        return res.status(403).json({ limitReached: true });
      }
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4000,
      messages: [{ role: 'user', content: `You are the Strategic Flow audit engine. Analyze this SaaS email and return ONLY valid JSON with keys: diagnosis (string), issues (array of {title,description,before,after}), upgrades (array of {title,description}).\n\nCompany: ${company}\nContact: ${name} (${email})\nGoal: ${goal || 'General conversion improvement'}\nSubject: "${subject}"\nBody:\n${body}` }]
    });
    const raw = message.content.map(b => b.text || '').join('');
    const parsed = robustJsonParse(raw);

    if (!isWhitelisted) {
      await pool.query(`
        INSERT INTO audit_usage (email, audit_count) VALUES ($1, 1)
        ON CONFLICT (email) DO UPDATE
          SET audit_count = audit_usage.audit_count + 1, last_audit_at = NOW()
      `, [normalizedEmail]);
    }

    // Send response immediately, then build & send email in background
    res.json(parsed);
    sendAuditEmail(company, name, email, subject, body, parsed);

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
    const parsed = robustJsonParse(raw);
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

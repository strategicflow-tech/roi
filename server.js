// server.js — Strategic Flow Multi-Tier SaaS Platform
'use strict';

const express    = require('express');
const { Pool }   = require('pg');
const Anthropic  = require('@anthropic-ai/sdk');
const { Resend } = require('resend');

const {
  TIER_CONFIGS, getAuditPrompt, getABSubjectsPrompt, getConversionScorePrompt,
  getAudienceSegmentsPrompt, getContentCalendarPrompt, getCohesionCheckPrompt,
  getEmailTypePrompt, getVoiceAnalysisPrompt
} = require('./system-prompt.js');
const { extractBrandDNA } = require('./brand-dna.js');

const app    = express();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

const MODEL          = 'claude-sonnet-4-5-20250929';
const OWNER_EMAIL    = 'consultantcalatorii@gmail.com';
const SENDER         = 'onboarding@resend.dev';
const BYPASS_EMAILS  = new Set(['strategicflow@proton.me', 'consultantcalatorii@gmail.com']);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'sfadmin2026';

app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

// ─── DATABASE SETUP ─────────────────────────────────────────────────────────

async function setupDB() {
  // Keep existing audit_usage table untouched
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_usage (
      email          VARCHAR(255) PRIMARY KEY,
      audit_count    INTEGER NOT NULL DEFAULT 0,
      first_audit_at TIMESTAMP DEFAULT NOW(),
      last_audit_at  TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS users (
      email                  VARCHAR(255) PRIMARY KEY,
      tier                   VARCHAR(50)  NOT NULL DEFAULT 'free',
      newsletter_count       INTEGER      NOT NULL DEFAULT 0,
      newsletter_count_month INTEGER      NOT NULL DEFAULT 0,
      newsletter_month_key   VARCHAR(7)   NOT NULL DEFAULT '',
      vip                    BOOLEAN      NOT NULL DEFAULT FALSE,
      company                VARCHAR(255),
      created_at             TIMESTAMP DEFAULT NOW(),
      last_used_at           TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS newsletters (
      id                SERIAL PRIMARY KEY,
      email             VARCHAR(255) NOT NULL,
      company           VARCHAR(255),
      original_subject  TEXT,
      original_body     TEXT,
      rebuilt_subject   TEXT,
      rebuilt_body      TEXT,
      tier              VARCHAR(50),
      email_type        VARCHAR(50),
      ab_subjects       JSONB,
      conversion_score  JSONB,
      brand_dna         JSONB,
      audience_segments JSONB,
      content_calendar  JSONB,
      cohesion_check    JSONB,
      created_at        TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS system_config (
      key        VARCHAR(255) PRIMARY KEY,
      value      TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('[DB] All tables ready');
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function isAdmin(email) {
  return BYPASS_EMAILS.has((email || '').toLowerCase().trim());
}

function checkLimit(user) {
  const { tier, newsletter_count, newsletter_count_month, newsletter_month_key } = user;
  const cfg = TIER_CONFIGS[tier];
  if (!cfg) return { allowed: false, reason: 'no_tier' };
  if (tier === 'single') {
    return newsletter_count < 1 ? { allowed: true } : { allowed: false, reason: 'single_used' };
  }
  const mk = currentMonthKey();
  const used = newsletter_month_key === mk ? newsletter_count_month : 0;
  if (used >= cfg.limit) return { allowed: false, reason: 'monthly_limit', used, limit: cfg.limit };
  return { allowed: true, used, limit: cfg.limit };
}

async function getUser(email) {
  const r = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
  return r.rows[0] || null;
}

async function upsertUser(email, fields) {
  const e = email.toLowerCase().trim();
  const sets = Object.entries(fields).map(([k, v], i) => `${k} = $${i + 2}`).join(', ');
  const vals = Object.values(fields);
  await pool.query(
    `INSERT INTO users (email, ${Object.keys(fields).join(', ')}) VALUES ($1, ${vals.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (email) DO UPDATE SET ${sets}, last_used_at = NOW()`,
    [e, ...vals]
  );
}

async function bumpCount(email) {
  const mk = currentMonthKey();
  await pool.query(`
    UPDATE users SET
      newsletter_count       = newsletter_count + 1,
      newsletter_count_month = CASE WHEN newsletter_month_key = $2 THEN newsletter_count_month + 1 ELSE 1 END,
      newsletter_month_key   = $2,
      last_used_at           = NOW()
    WHERE email = $1
  `, [email.toLowerCase().trim(), mk]);
}

async function claudeJSON(prompt, maxTokens = 2000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const msg = await claude.messages.create({
        model: MODEL, max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      });
      let raw = msg.content[0].text.trim();
      raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
      const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
      if (start !== -1 && end > start) raw = raw.slice(start, end + 1);
      return JSON.parse(raw);
    } catch (err) {
      if (attempt === 1) throw err;
      await new Promise(r => setTimeout(r, 400));
    }
  }
}

function buildNewsletterHTML(company, subject, body, brandDNA) {
  const primaryColor = (brandDNA?.colors?.[0]?.value) || '#00d4c8';
  const logo = brandDNA?.logo
    ? `<img src="${brandDNA.logo}" alt="${company} logo" style="max-height:48px;margin-bottom:10px;" /><br>` : '';
  const formattedBody = (body || '').replace(/\n\n/g, '</p><p style="margin:0 0 16px;">').replace(/\n/g, '<br>');
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 20px;">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">
  <tr><td style="background:${primaryColor};padding:28px 40px;text-align:center;">
    ${logo}<span style="font-size:22px;font-weight:700;color:#fff;">${company}</span>
  </td></tr>
  <tr><td style="padding:40px;">
    <h1 style="font-size:22px;color:#1a1a2e;margin:0 0 24px;line-height:1.35;">${subject}</h1>
    <p style="font-size:16px;color:#333;line-height:1.75;margin:0 0 20px;">${formattedBody}</p>
  </td></tr>
  <tr><td style="background:#f8f8fa;padding:18px 40px;text-align:center;border-top:1px solid #eee;">
    <p style="font-size:11px;color:#999;margin:0;">Rebuilt by <a href="https://strategic-flow-audit.replit.app" style="color:${primaryColor};text-decoration:none;">Strategic Flow</a> &nbsp;·&nbsp; © ${new Date().getFullYear()} ${company}</p>
  </td></tr>
</table></td></tr></table></body></html>`;
}

async function notify(subject, html) {
  try { await resend.emails.send({ from: SENDER, to: OWNER_EMAIL, subject, html }); }
  catch (e) { console.error('[email]', e.message); }
}

// ─── ROUTES ─────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ ok: true, model: MODEL, ts: new Date().toISOString() }));

// ── CHECK EMAIL ──
app.post('/check-email', async (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    if (!email) return res.json({ status: 'no_email' });

    if (isAdmin(email)) {
      await pool.query(`
        INSERT INTO users (email, tier, vip) VALUES ($1, 'high_impact', true)
        ON CONFLICT (email) DO UPDATE SET last_used_at = NOW()
      `, [email]);
      return res.json({ status: 'admin', tier: 'high_impact', isAdmin: true, name: TIER_CONFIGS.high_impact.name });
    }

    const user = await getUser(email);
    if (!user || user.tier === 'free') return res.json({ status: 'new_user' });

    const lim = checkLimit(user);
    return res.json({
      status: 'has_tier', tier: user.tier, company: user.company, vip: user.vip,
      used: lim.used ?? user.newsletter_count, limit: TIER_CONFIGS[user.tier]?.limit,
      monthly: TIER_CONFIGS[user.tier]?.monthly, tierName: TIER_CONFIGS[user.tier]?.name
    });
  } catch (err) { console.error('[check-email]', err); res.status(500).json({ error: err.message }); }
});

// ── ACTIVATE AFTER PAYMENT ──
app.post('/activate', async (req, res) => {
  try {
    const { email, tier } = req.body;
    if (!email || !TIER_CONFIGS[tier]) return res.status(400).json({ error: 'Invalid tier or email' });
    const e = email.toLowerCase().trim();
    await pool.query(`
      INSERT INTO users (email, tier, vip) VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE SET tier = $2, vip = $3, last_used_at = NOW()
    `, [e, tier, tier === 'high_impact']);
    res.json({ success: true, tier, tierName: TIER_CONFIGS[tier].name });
    notify(`🎉 New Activation — ${TIER_CONFIGS[tier].name} — ${e}`,
      `<p>Email: <strong>${e}</strong><br>Tier: <strong>${TIER_CONFIGS[tier].name} ${TIER_CONFIGS[tier].price}</strong></p>`).catch(() => {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── BRAND DNA ──
app.post('/brand-dna', async (req, res) => {
  try {
    const { websiteUrl, email } = req.body;
    if (!websiteUrl) return res.status(400).json({ error: 'websiteUrl required' });
    const dna = await extractBrandDNA(websiteUrl);
    let voiceProfile = null;
    if (dna.success && dna.textContent && dna.textContent.length > 100) {
      try { voiceProfile = await claudeJSON(getVoiceAnalysisPrompt(dna.textContent), 600); }
      catch (e) { console.error('[voice]', e.message); }
    }
    res.json({ ...dna, voiceProfile });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GENERATE (main) ──
app.post('/generate', async (req, res) => {
  try {
    const { email, company, name, goal, subject, body, emailType, roadmapNotes, brandDNA, voiceProfile } = req.body;
    const e = (email || '').toLowerCase().trim();
    if (!e || !subject || !body) return res.status(400).json({ error: 'email, subject, body required' });

    const adminAccess = isAdmin(e);
    const user = await getUser(e);
    const tier = adminAccess ? 'high_impact' : (user?.tier && user.tier !== 'free' ? user.tier : null);
    if (!tier) return res.status(403).json({ error: 'no_tier' });

    if (!adminAccess) {
      const lim = checkLimit(user);
      if (!lim.allowed) return res.status(403).json({ error: 'limit_reached', reason: lim.reason, used: lim.used, limit: lim.limit });
    }

    // High-Impact: detect type if not provided
    let detectedType = emailType || null;
    if (tier === 'high_impact' && !detectedType) {
      try { detectedType = (await claudeJSON(getEmailTypePrompt(subject, body), 200)).type; } catch (_) {}
    }

    const prompt = getAuditPrompt({ tier, company: company || 'Your Company', goal, subject, body, brandDNA, voiceProfile, emailType: detectedType, roadmapNotes });
    const result = await claudeJSON(prompt, 2500);

    const downloadHtml = buildNewsletterHTML(company || 'Your Company', result.rebuilt_subject, result.rebuilt_body, brandDNA);

    // Persist to DB
    let newsletterId = null;
    try {
      const s = await pool.query(`
        INSERT INTO newsletters (email,company,original_subject,original_body,rebuilt_subject,rebuilt_body,tier,email_type,brand_dna)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
      `, [e, company, subject, body, result.rebuilt_subject, result.rebuilt_body, tier, detectedType, brandDNA ? JSON.stringify(brandDNA) : null]);
      newsletterId = s.rows[0].id;
    } catch (dbErr) { console.error('[db]', dbErr.message); }

    if (!adminAccess) await bumpCount(e);
    if (company && user) pool.query('UPDATE users SET company=$1 WHERE email=$2', [company, e]).catch(() => {});

    // Notifications
    if (tier === 'single') {
      notify(`📨 Single Rebuild — ${company || e}`, `<p>Email: ${e}<br>Company: ${company}<br>Subject: ${result.rebuilt_subject}</p>`).catch(() => {});
    }
    if (tier === 'high_impact' && user?.vip && !adminAccess) {
      notify(`⚡ VIP URGENT — ${company || e}`, `<p><b>VIP Submission</b><br>Email: ${e}<br>Company: ${company}<br>Subject: ${result.rebuilt_subject}</p>`).catch(() => {});
    }

    res.json({ ...result, newsletterId, emailType: detectedType, downloadHtml, tier });
  } catch (err) { console.error('[generate]', err); res.status(500).json({ error: err.message }); }
});

// ── A/B SUBJECTS (Lite+) ──
app.post('/ab-subjects', async (req, res) => {
  try {
    const { email, company, subject, body } = req.body;
    const u = await getUser((email || '').toLowerCase());
    if (!isAdmin(email) && !['lite','growth','high_impact'].includes(u?.tier)) return res.status(403).json({ error: 'Lite+ required' });
    res.json(await claudeJSON(getABSubjectsPrompt(company, subject, body), 1000));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CONVERSION SCORE (Lite+) ──
app.post('/conversion-score', async (req, res) => {
  try {
    const { email, originalSubject, originalBody, rebuiltSubject, rebuiltBody } = req.body;
    const u = await getUser((email || '').toLowerCase());
    if (!isAdmin(email) && !['lite','growth','high_impact'].includes(u?.tier)) return res.status(403).json({ error: 'Lite+ required' });
    res.json(await claudeJSON(getConversionScorePrompt(originalSubject, originalBody, rebuiltSubject, rebuiltBody), 1000));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AUDIENCE SEGMENTS (Growth+) ──
app.post('/audience-segments', async (req, res) => {
  try {
    const { email, company, subject, body } = req.body;
    const u = await getUser((email || '').toLowerCase());
    if (!isAdmin(email) && !['growth','high_impact'].includes(u?.tier)) return res.status(403).json({ error: 'Growth+ required' });
    res.json(await claudeJSON(getAudienceSegmentsPrompt(company, subject, body), 900));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CONTENT CALENDAR (Growth+) ──
app.post('/content-calendar', async (req, res) => {
  try {
    const { email, company, subject, body } = req.body;
    const u = await getUser((email || '').toLowerCase());
    if (!isAdmin(email) && !['growth','high_impact'].includes(u?.tier)) return res.status(403).json({ error: 'Growth+ required' });
    res.json(await claudeJSON(getContentCalendarPrompt(company, subject, body), 900));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── COHESION CHECK (High-Impact) ──
app.post('/cohesion-check', async (req, res) => {
  try {
    const { email, subject, body } = req.body;
    const u = await getUser((email || '').toLowerCase());
    if (!isAdmin(email) && u?.tier !== 'high_impact') return res.status(403).json({ error: 'High-Impact required' });
    res.json(await claudeJSON(getCohesionCheckPrompt(subject, body), 900));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── HUMAN REVIEW (Lite+) ──
app.post('/human-review', async (req, res) => {
  try {
    const { email, company, tier, rebuiltSubject, rebuiltBody } = req.body;
    await notify(
      `[${(tier || 'LITE').toUpperCase()} REVIEW] ${company || email} — ${rebuiltSubject}`,
      `<p><b>From:</b> ${email}<br><b>Tier:</b> ${tier}<br><b>Company:</b> ${company}</p><hr><h2>${rebuiltSubject}</h2><div>${(rebuiltBody || '').replace(/\n/g, '<br>')}</div>`
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN STATS ──
app.get('/admin/stats', async (req, res) => {
  if (!isAdmin(req.headers['x-admin-email'])) return res.status(403).json({ error: 'Forbidden' });
  try {
    const [tiers, totU, totN, recent] = await Promise.all([
      pool.query('SELECT tier, COUNT(*) as count FROM users GROUP BY tier ORDER BY count DESC'),
      pool.query('SELECT COUNT(*) as count FROM users'),
      pool.query('SELECT COUNT(*) as count FROM newsletters'),
      pool.query('SELECT email,company,tier,rebuilt_subject,created_at FROM newsletters ORDER BY created_at DESC LIMIT 10')
    ]);
    res.json({ tierCounts: tiers.rows, totalUsers: +totU.rows[0].count, totalNewsletters: +totN.rows[0].count, recentNewsletters: recent.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN USERS ──
app.get('/admin/users', async (req, res) => {
  if (!isAdmin(req.headers['x-admin-email'])) return res.status(403).json({ error: 'Forbidden' });
  try {
    const q = req.query.q ? `%${req.query.q}%` : '%';
    const r = await pool.query(
      `SELECT email,tier,vip,newsletter_count,newsletter_count_month,company,created_at,last_used_at
       FROM users WHERE email ILIKE $1 ORDER BY created_at DESC LIMIT 50`, [q]);
    res.json({ users: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN UPGRADE ──
app.post('/admin/upgrade', async (req, res) => {
  if (!isAdmin(req.headers['x-admin-email'])) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { email, tier } = req.body;
    if (!email || !TIER_CONFIGS[tier]) return res.status(400).json({ error: 'Invalid' });
    const e = email.toLowerCase().trim();
    await pool.query(`
      INSERT INTO users (email, tier, vip) VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE SET tier = $2, vip = $3, last_used_at = NOW()
    `, [e, tier, tier === 'high_impact']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── UPDATE SYSTEM PROMPT (webhook, protected) ──
app.post('/update-system-prompt', async (req, res) => {
  const { password, key, value } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });
  if (!key || !value) return res.status(400).json({ error: 'key and value required' });
  try {
    await pool.query(`
      INSERT INTO system_config (key, value, updated_at) VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
    `, [key, value]);
    res.json({ success: true, key });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── MONTHLY CONVERSION AUDIT (auto on 1st of month) ──
async function runMonthlyAudit() {
  try {
    if (new Date().getDate() !== 1) return;
    const mk = currentMonthKey();
    const sent = await pool.query(`SELECT value FROM system_config WHERE key = 'last_monthly_audit'`);
    if (sent.rows[0]?.value === mk) return;

    const hiUsers = await pool.query(
      `SELECT email, company FROM users WHERE tier = 'high_impact' AND email != $1 AND email != $2`,
      [...BYPASS_EMAILS]
    );
    for (const u of hiUsers.rows) {
      const nls = await pool.query(
        `SELECT rebuilt_subject, rebuilt_body, created_at FROM newsletters WHERE email=$1 ORDER BY created_at DESC LIMIT 3`, [u.email]);
      if (!nls.rows.length) continue;
      const nlHtml = nls.rows.map(n =>
        `<h3>${n.rebuilt_subject}</h3><p>${(n.rebuilt_body||'').slice(0,300)}…</p><p><em>${new Date(n.created_at).toLocaleDateString()}</em></p>`
      ).join('<hr>');
      await notify(`HI AUDIT — ${u.company || u.email} — ${mk}`,
        `<h2>Monthly Conversion Audit — ${u.company || u.email}</h2><p>Email: ${u.email}</p><hr>${nlHtml}<hr>
        <h3>UI/UX Checklist</h3><ul><li>Mobile preview checked?</li><li>CTA above fold?</li><li>Social proof specific?</li><li>Subject under 50 chars?</li></ul>`);
    }

    await pool.query(`INSERT INTO system_config (key, value) VALUES ('last_monthly_audit', $1)
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`, [mk]);
    console.log('[audit] Monthly audit complete for', mk);
  } catch (err) { console.error('[monthly-audit]', err.message); }
}

// ─── BOOT ───────────────────────────────────────────────────────────────────

process.on('uncaughtException',  e => console.error('[uncaught]', e.message));
process.on('unhandledRejection', e => console.error('[unhandled]', e));

setupDB().then(async () => {
  await runMonthlyAudit();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => console.log(`[server] Strategic Flow ready on :${PORT} — model: ${MODEL}`));
}).catch(e => { console.error('[startup]', e); process.exit(1); });

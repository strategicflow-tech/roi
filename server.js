// server.js — Strategic Flow Multi-Tier SaaS Platform
'use strict';

const express    = require('express');
const { Pool }   = require('pg');
const Anthropic  = require('@anthropic-ai/sdk');
const { Resend } = require('resend');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const session = require('express-session');
const crypto  = require('crypto');
const pgSession = require('connect-pg-simple')(session);

const {
  TIER_CONFIGS, getAuditPrompt,
  getEmailTypePrompt, getVoiceAnalysisPrompt,
  getEmailScorePrompt, getMicroImprovementsPrompt,
  getWeaknessVerifyPrompt, getSectionPatchPrompt, getPromoGridSubjectHeroPrompt,
  getContentCalendarPrompt
} = require('./system-prompt.js');
const { extractBrandDNA } = require('./brand-dna.js');
const { generateShowcaseHtml, extractVisualAssets } = require('./showcase-generator.js');

const app    = express();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

const MODEL          = 'claude-sonnet-4-5-20250929';
const OWNER_EMAIL    = 'strategicflow@proton.me';
const SENDER         = 'noreply@strategicflow.cc';
const BYPASS_EMAILS  = new Set(['strategicflow@proton.me', 'consultantcalatorii@gmail.com']);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'sfadmin2026';

// ── IN-MEMORY JOB STORE (for polling-based generation) ──────────────────────
// Each job: { status:'pending'|'complete'|'failed', result, error, created }
const jobs = new Map();
function makeJobId() { return Math.random().toString(36).slice(2,10) + Date.now().toString(36); }

async function setJob(id, data) {
  jobs.set(id, data);
  try {
    await pool.query(`
      INSERT INTO jobs (id, status, result, error, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (id) DO UPDATE SET
        status = $2, result = $3, error = $4
    `, [id, data.status, data.result ? JSON.stringify(data.result) : null, data.error || null]);
  } catch(e) { console.error('[setJob]', e.message); }
}

async function getJob(id) {
  if (jobs.has(id)) return jobs.get(id);
  try {
    const r = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
    if (r.rows.length > 0) {
      const row = r.rows[0];
      return { status: row.status, result: row.result ? JSON.parse(row.result) : null, error: row.error };
    }
  } catch(e) { console.error('[getJob]', e.message); }
  return null;
}

// ── URL content cache — 30-min TTL avoids repeat 12s fetches for the same article ──
const urlCache = new Map();
const CACHE_TTL = 1000 * 60 * 30;
async function fetchWithCache(url) {
  const cached = urlCache.get(url);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log('[urlCache] hit:', url);
    return cached.content;
  }
  const content = await fetchPageContent(url);
  urlCache.set(url, { content, timestamp: Date.now() });
  return content;
}
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs) { if (job.created < cutoff) jobs.delete(id); }
}, 10 * 60 * 1000);

app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// SESSION MIDDLEWARE
app.use(session({
  store: new pgSession({
    pool: pool,
    tableName: 'session',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
  }
}));

// In-memory magic token store — { token: { email, expires } }
const magicTokens = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [token, data] of magicTokens) {
    if (data.expires < now) magicTokens.delete(token);
  }
}, 30 * 60 * 1000);

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────────
const PROTECTED_PATHS = [
  '/index.html',
  '/architecture.html',
  '/assessment.html',
  '/generate',
  '/api/architecture'
];

function requireAuth(req, res, next) {
  const open = ['/login.html', '/magic.html', '/auth/magic', '/auth/verify', '/auth/logout', '/generate/status', '/api/demo'];
  if (open.some(p => req.path.startsWith(p))) return next();

  const needsAuth = PROTECTED_PATHS.some(p => req.path === p || req.path.startsWith(p));
  if (!needsAuth) return next();

  if (req.session && req.session.userEmail) return next();

  if (req.path.endsWith('.html') || req.path === '/') {
    return res.redirect('/login.html');
  }
  return res.status(401).json({ error: 'Unauthorised' });
}

app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(requireAuth);

app.get('/index.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.use(express.static('public'));

// ── REDIRECT ROOT ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session && req.session.userEmail) {
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(path.join(__dirname, 'public/index.html'));
  }
  return res.redirect('/login.html');
});

// ── POST /auth/magic — send magic link ───────────────────────────────────────
app.post('/auth/magic', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  let hasAccess = isAdmin(email);

  if (!hasAccess) {
    try {
      const user = await getUser(email);
      hasAccess = !!user;
    } catch (e) {
      console.error('[auth/magic] getUser error:', e.message);
    }
  }

  if (!hasAccess) {
    console.log('[auth/magic] Access denied for:', email);
    return res.json({ ok: true });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 15 * 60 * 1000;
  magicTokens.set(token, { email, expires });

  const baseUrl = process.env.APP_URL || 'https://strategic-flow-audit.replit.app';
  const magicLink = `${baseUrl}/auth/verify/${token}`;

  try {
    await resend.emails.send({
      from: SENDER,
      to: email,
      subject: 'Your Strategic Flow sign-in link',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0a0a08;color:#f4f2ed;padding:40px 32px;border:1px solid rgba(255,255,255,0.1);">
          <p style="font-size:11px;letter-spacing:0.1em;color:#a8a39b;text-transform:uppercase;margin:0 0 32px;">Strategic Flow Architecture</p>
          <h2 style="font-size:24px;margin:0 0 16px;font-weight:600;">Your sign-in link</h2>
          <p style="font-size:15px;color:#a8a39b;margin:0 0 32px;line-height:1.6;">Click the button below to sign in. This link expires in 15 minutes and can only be used once.</p>
          <a href="${magicLink}" style="display:inline-block;background:#4A8FE7;color:#ffffff;padding:14px 28px;text-decoration:none;font-size:14px;font-weight:600;margin-bottom:32px;">Sign in to Strategic Flow →</a>
          <p style="font-size:12px;color:#6b6760;margin:0;line-height:1.6;">If you didn't request this, ignore this email. Your account is safe.<br>Link expires: ${new Date(expires).toUTCString()}</p>
        </div>
      `
    });
    console.log('[auth/magic] Magic link sent to:', email);
  } catch (e) {
    console.error('[auth/magic] Resend error:', e.message);
    return res.status(500).json({ error: 'Failed to send email. Try again.' });
  }

  res.json({ ok: true });
});

// ── GET /auth/verify/:token ───────────────────────────────────────────────────
app.get('/auth/verify/:token', async (req, res) => {
  const token = req.params.token;
  const data = magicTokens.get(token);

  if (!data) return res.redirect('/login.html?error=invalid');
  if (data.expires < Date.now()) {
    magicTokens.delete(token);
    return res.redirect('/login.html?error=expired');
  }

  magicTokens.delete(token);
  req.session.userEmail = data.email;
  req.session.signedInAt = Date.now();
  await new Promise((resolve, reject) => {
    req.session.save(err => err ? reject(err) : resolve());
  });

  try {
    await upsertUser(data.email, { last_used_at: new Date() });
  } catch (e) {
    console.error('[auth/verify] upsertUser error:', e.message);
  }

  console.log('[auth/verify] Signed in:', data.email);
  res.redirect('/architecture.html');
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
app.get('/auth/me', (req, res) => {
  if (req.session && req.session.userEmail) {
    return res.json({ email: req.session.userEmail, signedIn: true });
  }
  res.json({ signedIn: false });
});

// ── ADMIN: add user ───────────────────────────────────────────────────────────
app.post('/admin/users', async (req, res) => {
  if (!isAdmin(req.session?.userEmail)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { email, tier } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    await upsertUser(email, { tier: tier || 'architecture' });
    res.json({ ok: true, email, tier: tier || 'architecture' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: list users ─────────────────────────────────────────────────────────
app.get('/admin/users', async (req, res) => {
  if (!isAdmin(req.session?.userEmail)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const r = await pool.query('SELECT email, tier, created_at, last_used_at FROM users ORDER BY created_at DESC');
    res.json({ users: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── END AUTH BLOCK ───────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

app.get('/debug/server', (req, res) => {
  try {
    const content = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(content);
  } catch(e) {
    res.status(500).send('Error: ' + e.message);
  }
});

app.get('/debug/prompt', (req, res) => {
  try {
    const content = fs.readFileSync(path.join(__dirname, 'system-prompt.js'), 'utf8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(content);
  } catch(e) {
    res.status(500).send('Error: ' + e.message);
  }
});

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
      key_changes       JSONB,
      conversion_hook   TEXT,
      created_at        TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS system_config (
      key        VARCHAR(255) PRIMARY KEY,
      value      TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Continuous learning table — never deleted, append-only
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rebuild_learning (
      id               SERIAL PRIMARY KEY,
      company          VARCHAR(255),
      industry         VARCHAR(255),
      audience_type    VARCHAR(255),
      original_subject TEXT,
      original_body    TEXT,
      rebuilt_subject  TEXT,
      rebuilt_body     TEXT,
      what_changed     JSONB,
      tier             VARCHAR(50),
      created_at       TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rl_industry ON rebuild_learning(industry);
  `).catch(e => console.error('[DB] rebuild_learning:', e.message));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id VARCHAR(50) PRIMARY KEY,
      status VARCHAR(20) NOT NULL,
      result TEXT,
      error TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(e => console.error('[DB] jobs:', e.message));
  // Add new columns to existing tables without breaking existing rows
  await pool.query(`
    ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS key_changes JSONB;
    ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS conversion_hook TEXT;
    ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS original_score JSONB;
    ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS rebuild_path VARCHAR(20);
    ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS og_image TEXT;
    ALTER TABLE rebuild_learning ADD COLUMN IF NOT EXISTS rebuild_path VARCHAR(20);
  `).catch(e => console.error('[DB] alter:', e.message));
  console.log('[DB] All tables ready');
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

async function getIndustryExamples(industry) {
  if (!industry) return [];
  try {
    const r = await pool.query(
      `SELECT original_subject, rebuilt_subject, what_changed
       FROM rebuild_learning
       WHERE industry ILIKE $1
       ORDER BY created_at DESC LIMIT 3`,
      [industry.trim()]
    );
    return r.rows;
  } catch (e) {
    console.error('[learning-fetch]', e.message);
    return [];
  }
}

async function storeLearning({ company, industry, audienceType, origSubject, origBody, rebuiltSubject, rebuiltBody, whatChanged, tier, rebuildPath }) {
  try {
    await pool.query(
      `INSERT INTO rebuild_learning
         (company, industry, audience_type, original_subject, original_body,
          rebuilt_subject, rebuilt_body, what_changed, tier, rebuild_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        company  || null,
        industry || null,
        audienceType || null,
        origSubject ? String(origSubject).slice(0, 255) : null,
        origBody    ? String(origBody).slice(0, 500) : null,
        rebuiltSubject ? String(rebuiltSubject).slice(0, 255) : null,
        rebuiltBody    ? String(rebuiltBody).replace(/<[^>]+>/g, ' ').replace(/\s+/g,' ').trim().slice(0, 500) : null,
        whatChanged ? JSON.stringify(whatChanged) : null,
        tier || null,
        rebuildPath || null
      ]
    );
  } catch (e) {
    console.error('[learning-store]', e.message);
  }
}

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
  if (tier === 'free_trial' || tier === 'single') {
    return newsletter_count < 1 ? { allowed: true } : { allowed: false, reason: tier === 'free_trial' ? 'trial_used' : 'single_used' };
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
  // Strip last_used_at — always appended via NOW() in the query to avoid duplicate column
  const clean = Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'last_used_at'));
  if (Object.keys(clean).length === 0) {
    await pool.query(
      `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET last_used_at = NOW()`,
      [e]
    );
    return;
  }
  const sets = Object.entries(clean).map(([k], i) => `${k} = $${i + 2}`).join(', ');
  const vals = Object.values(clean);
  await pool.query(
    `INSERT INTO users (email, ${Object.keys(clean).join(', ')}) VALUES ($1, ${vals.map((_, i) => `$${i + 2}`).join(', ')})
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

async function verifyImageUrl(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

function sanitizeForJSON(str) {
  return (str || '')
    .replace(/[\u2018\u2019]/g, "'")   // curly single quotes → straight
    .replace(/[\u201C\u201D]/g, '"')   // curly double quotes → straight
    .replace(/\u2014/g, '-')           // em dash → hyphen
    .replace(/\u2013/g, '-')           // en dash → hyphen
    .replace(/\u2026/g, '...')         // ellipsis → triple dot
    .replace(/\u00A0/g, ' ')           // non-breaking space → regular space
    .replace(/[^\x00-\x7F\u00C0-\u024F\u1E00-\u1EFF]/g, ' ');   // preserve Latin Extended (diacritics) — strip only truly non-Latin unicode
}

// Sanitize human-supplied text fields before embedding in any Claude prompt.
// Strips Yahoo Mail forwarding artifacts and image-description placeholders,
// then normalises special characters and caps length.
function sanitizeInput(str, maxLen = 8000) {
  let s = str || '';
  // ── Yahoo Mail / webmail forwarding artifacts ──
  s = s.replace(/^Image of .+$/gim, '');        // "Image of Claude", "Image of rocket"
  s = s.replace(/^\S.*\s+icon$/gim, '');        // "YouTube icon", "X icon", "star icon"
  s = s.replace(/^-{3,}.*$/gm, '');             // "-------- Forwarded Message --------"
  s = s.replace(/^On .+wrote:$/gm, '');         // "On Mon Apr 11 2026 user@x.com wrote:"
  s = s.replace(/^>+\s*/gm, '');                // quoted reply lines starting with ">"
  s = s.replace(/\n{3,}/g, '\n\n');             // collapse excessive blank lines
  // ── ASCII normalisation (curly quotes, dashes, non-ASCII) ──
  return sanitizeForJSON(s).slice(0, maxLen);
}

// 4-layer JSON parser — returns null on total failure (never returns a partial/default object).
// Callers must check for null and surface a user-facing error rather than rendering undefined fields.
function safeParseJSON(raw) {
  if (!raw) return null;
  // Layer 1: direct parse
  try { return JSON.parse(raw); } catch (_) {}
  // Layer 2: extract outermost {...} block, then parse
  try {
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s !== -1 && e > s) return JSON.parse(raw.slice(s, e + 1));
  } catch (_) {}
  // Layer 3: strip markdown fences + normalize special chars, then parse
  try {
    const clean = sanitizeForJSON(raw.replace(/```json|```/gi, '').trim());
    const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
    if (s !== -1 && e > s) return JSON.parse(clean.slice(s, e + 1));
    return JSON.parse(clean);
  } catch (_) {}
  // Layer 4: decode HTML entities that Claude sometimes encodes in JSON string values (&lt; &gt; &amp;)
  try {
    const decoded = raw
      .replace(/```json|```/gi, '').trim()
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    const s = decoded.indexOf('{'), e = decoded.lastIndexOf('}');
    if (s !== -1 && e > s) return JSON.parse(decoded.slice(s, e + 1));
  } catch (_) {}
  // Layer 5: all attempts failed — return null so callers can show a clean error
  console.warn('[safeParseJSON] all layers failed. Raw (first 300):', (raw || '').slice(0, 300));
  return null;
}

// Guard that converts any value to a safe string for HTML injection.
// Returns '' for null, undefined, 'undefined', 'null', or NaN values.
const safeVal = (val) => {
  if (val === null || val === undefined || val === 'undefined' || val === 'null' || (typeof val === 'number' && isNaN(val))) return '';
  return String(val).trim();
};

const JSON_SYSTEM_INSTRUCTION = 'Return ONLY valid JSON. Use straight ASCII quotes only — no curly quotes (\u201C\u201D\u2018\u2019), no em dashes (\u2014), no en dashes (\u2013), no ellipsis characters (\u2026), no non-breaking spaces, no other Unicode. No markdown fences. No text before or after the JSON object.';

async function claudeJSON(prompt, maxTokens = 2000) {
  const retries = 3;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const msg = await claude.messages.create({
        model: MODEL, max_tokens: maxTokens,
        system: JSON_SYSTEM_INSTRUCTION,
        messages: [{ role: 'user', content: prompt }]
      }, {
        timeout: 90000
      });
      const raw = msg.content[0].text.trim();
      return safeParseJSON(raw);
    } catch (err) {
      const is529 = err.status === 529 || String(err.message).includes('529') || String(err.message).includes('Overloaded');
      if (is529) {
        if (attempt < retries) {
          const delay = attempt * 5000; // 5s, 10s
          console.log(`[claudeJSON] 529 Overloaded, waiting ${delay}ms before retry ${attempt + 1}/${retries}`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        // All retries exhausted on 529 — throw a user-friendly error so callers can surface it
        console.error(`[claudeJSON] all ${retries} attempts failed (529 Overloaded)`);
        const overloadErr = new Error('Claude AI is temporarily overloaded. Please try again in 2-3 minutes.');
        overloadErr.isOverloaded = true;
        throw overloadErr;
      }
      // Non-529 error: short delay then retry; give up with null after last attempt
      console.error(`[claudeJSON] attempt ${attempt} failed:`, err.message);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 400));
      } else {
        console.error(`[claudeJSON] all ${retries} attempts failed:`, err.message);
        return null;
      }
    }
  }
  return null;
}

// Returns true when a hex color is light enough to need dark text on top of it.
function isLightHex(hex) {
  if (!hex || !hex.startsWith('#')) return true;
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  if (full.length !== 6) return true;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 160;
}

// ── COLOR HELPERS ────────────────────────────────────────────────────────────

function hexToHSL(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let hue = 0, sat = 0;
  const lit = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    sat = lit > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: hue = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: hue = ((b - r) / d + 2) / 6; break;
      case b: hue = ((r - g) / d + 4) / 6; break;
    }
  }
  return { h: hue * 360, s: sat * 100, l: lit * 100 };
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toH = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toH(f(0))}${toH(f(8))}${toH(f(4))}`;
}

// Clamp extracted colors so they're never too saturated or too dark for header/CTA use.
function adjustColorIfNeeded(hex) {
  if (!hex || !hex.startsWith('#') || hex.length < 7) return hex;
  try {
    const { h, s, l } = hexToHSL(hex);
    if (s > 80 || l < 30) {
      return hslToHex(h, Math.min(s, 70), Math.max(l, 35));
    }
  } catch (_) { /* leave unchanged on any parse error */ }
  return hex;
}

function getEmailColors(brandDNA) {
  const colors = brandDNA?.colors || [];
  const theme = brandDNA?.theme || 'light';
  const isDark = theme === 'dark' || brandDNA?.isDarkTheme === true;

  // Filter out gray/neutral colors (saturation < 15%) — these are never useful brand colors
  const isNeutral = (hex) => {
    if (!hex || !hex.startsWith('#') || hex.length < 7) return true;
    try { return hexToHSL(hex).s < 15; } catch { return true; }
  };
  const brandColors = (colors || []).map(c => c?.value).filter(v => v && !isNeutral(v));
  const rawPrimary = brandColors[0] || '#00d4c8';
  const rawAccent  = brandColors[1] || rawPrimary;
  const primaryColor = adjustColorIfNeeded(rawPrimary);
  // When dark theme: if accent lightness < 40% it'll be invisible — replace with teal fallback
  // When light theme: if accent lightness > 65% it'll be too pale on white — darken to 40%
  let accentColor = adjustColorIfNeeded(rawAccent);
  if (isDark) {
    try { if (hexToHSL(accentColor).l < 40) accentColor = '#00d4c8'; } catch (_) {}
  } else {
    try {
      const { h, s, l } = hexToHSL(accentColor);
      if (l > 65) accentColor = hslToHex(h, s, 40);
    } catch (_) {}
  }

  // Theme-aware backgrounds and text
  const bgColor      = isDark ? '#0a0a0a' : '#f4f4f7';
  const containerBg  = isDark ? '#111111' : '#ffffff';
  const textColor    = isDark ? '#ffffff' : '#1a1a1a';
  const mutedText    = isDark ? '#aaaaaa' : '#555555';
  const cardBg       = isDark ? '#1e1e1e' : '#f5f5f5';
  const dividerColor = isDark ? '#2a2a2a' : '#e0e0e0';

  const primaryText  = isLightHex(primaryColor) ? '#1a1a2e' : '#ffffff';
  const accentText   = isLightHex(accentColor)  ? '#1a1a2e' : '#ffffff';

  // Header bar: dark themes always use near-black bg with white text (legible regardless of brand primary)
  const headerBg   = isDark ? '#0d0d0d' : primaryColor;
  const headerText = isDark ? '#ffffff' : primaryText;

  return { primaryColor, accentColor, bgColor, containerBg, textColor, mutedText, cardBg, dividerColor, primaryText, accentText, isDark, headerBg, headerText };
}

// Post-process Claude-generated body HTML to flip hardcoded light-mode colors when the brand uses a dark theme.
function adaptBodyForDarkTheme(html) {
  return html
    // Text colors: light → dark-readable
    .replace(/color:\s*#222222/g,                   'color:#f0f0f0')
    .replace(/color:\s*#333333/g,                   'color:#e0e0e0')
    .replace(/color:\s*#333\b/g,                    'color:#e0e0e0')
    .replace(/color:\s*#1a1a1a/g,                   'color:#ffffff')
    .replace(/color:\s*#555555/g,                   'color:#aaaaaa')
    .replace(/color:\s*#555\b/g,                    'color:#aaaaaa')
    .replace(/color:\s*#666666/g,                   'color:#999999')
    .replace(/color:\s*#777777/g,                   'color:#999999')
    // Background colors: light → dark
    .replace(/background:\s*#f5f5f5/g,              'background:#1e1e1e')
    .replace(/background-color:\s*#f5f5f5/g,        'background-color:#1e1e1e')
    .replace(/background:\s*#fafafa/g,              'background:#161616')
    .replace(/background-color:\s*#fafafa/g,        'background-color:#161616')
    .replace(/background:\s*#f8f9fc/g,              'background:#1a1a1a')
    .replace(/background:\s*#ffffff/gi,             'background:#111111')
    .replace(/background:\s*#fff\b/gi,              'background:#111111')
    .replace(/background:\s*white\b/gi,             'background:#111111')
    .replace(/background-color:\s*#ffffff/gi,       'background-color:#111111')
    .replace(/background-color:\s*#fff\b/gi,        'background-color:#111111')
    .replace(/bgcolor=["']#?(?:ffffff|fff|white)["']/gi, 'bgcolor="#111111"')
    // Border/divider colors: light → dark
    .replace(/border:1px solid #e0e0e0/g,           'border:1px solid #2a2a2a')
    .replace(/border:1px solid #e8e8e8/g,           'border:1px solid #2a2a2a')
    .replace(/border-left:1px solid #e0e0e0/g,      'border-left:1px solid #2a2a2a')
    .replace(/border-right:1px solid #e0e0e0/g,     'border-right:1px solid #2a2a2a')
    .replace(/height:1px;background:#e0e0e0/g,      'height:1px;background:#2a2a2a');
}

// Strip Resend click-tracking wrappers from HTML links after generation.
// Resend may still wrap hrefs server-side despite clickTracking:false — this is a
// post-generation safety net so the downloaded HTML always has clean, original URLs.
function stripResendTracking(html) {
  if (!html || typeof html !== 'string') return html;
  
  // Step 1 — Remove tracking pixel
  html = html.replace(
    /<img[^>]*src=["'][^"']*resend-clicks\.com[^"']*["'][^>]*>/gi,
    ''
  );
  
  // Step 2 — Decode and replace resend-wrapped hrefs
  // [^/"'\s>]+ captures the encoded URL (stops at first literal / which is the /1/ tracking segment)
  // [^"'\s]* then consumes and discards the trailing /1/jobId/hash suffix
  html = html.replace(
    /https?:\/\/[a-z0-9.-]*resend-clicks\.com\/CL\d\/([^/"'\s>]+)[^"'\s]*/gi,
    (match, encodedPath) => {
      try {
        const decoded = decodeURIComponent(encodedPath);
        // decoded is now the real URL e.g. https://linear.app/signup
        // split('/1/') handles edge case where /1/ appears inside the decoded URL
        const realUrl = decoded.split('/1/')[0];
        return realUrl || decoded;
      } catch(e) {
        return match;
      }
    }
  );
  
  return html;
}

// Final HTML cleanup — strips any residual Resend tracking that wasn't caught upstream.
// Called at the end of buildNewsletterHTML on both template paths.
function finalizeEmailHtml(html) {
  if (!html) return html;
  // Remove resend-clicks.com tracking pixel
  html = html.replace(/<img[^>]*resend-clicks\.com[^>]*>/gi, '');
  // Remove resend.com hidden tracking pixel (display:none)
  html = html.replace(/<img[^>]*resend\.com[^>]*style="display:\s*none[^>]*>/gi, '');
  // Decode any tracked hrefs still in the output
  html = html.replace(
    /https?:\/\/[a-z0-9.-]*resend-clicks\.com\/CL\d+\/([^/"'\s>]+)[^"'\s]*/gi,
    (_, enc) => { try { return decodeURIComponent(enc).split('/1/')[0]; } catch(e) { return ''; } }
  );
  return html;
}

// Decode a Resend-wrapped CTA URL and verify it is a full HTTP URL with length > 20.
// Falls back immediately to sourceUrl when Resend decoding fails or yields a short/domain-only result.
// Validates whether a Claude-returned ctaUrl is legitimate to use, or should fall back to sourceUrl.
// Priority: same domain → known resource domain → reject UTM/promo cross-domain links → fallback sourceUrl.
function isValidCtaUrl(ctaUrl, sourceUrl) {
  try {
    const cta = new URL(ctaUrl);
    const src = new URL(sourceUrl);

    // Rule 1: exact same origin = always valid
    if (cta.origin === src.origin) return true;

    // Rule 2: known Salesforce resource subdomains = valid
    const validSfHosts = [
      'help.salesforce.com',
      'trailhead.salesforce.com',
      'status.salesforce.com',
      'trust.salesforce.com',
      'sandbox-preview-prd-24f76e67b11e.herokuapp.com',
      'admin.salesforce.com',
      'developer.salesforce.com'
    ];
    if (validSfHosts.includes(cta.hostname)) return true;

    // Rule 3: different subdomain on same base domain = NOT valid
    // (Claude fabricates URLs like www.salesforce.com/blog/...
    //  when source is admin.salesforce.com/blog/...)
    const srcBase = src.hostname.split('.').slice(-2).join('.');
    const ctaBase = cta.hostname.split('.').slice(-2).join('.');
    if (srcBase === ctaBase && cta.hostname !== src.hostname) return false;

    // Rule 4: has UTM/tracking params = discard
    if (cta.searchParams.has('d') || cta.searchParams.has('utm_source'))
      return false;

    return false;
  } catch { return false; }
}

function cleanCTAUrl(rawUrl, sourceUrl) {
  if (!rawUrl) return sourceUrl;
  // Decode Resend click-tracking wrappers first
  if (rawUrl.includes('resend-clicks.com')) {
    try {
      const part = rawUrl.split('/CL0/')[1];
      const encoded = part.split('/')[0];
      const decoded = decodeURIComponent(encoded);
      if (decoded.startsWith('http') && decoded.length > 20) {
        rawUrl = decoded; // unwrap and continue to validation below
      } else {
        return sourceUrl;
      }
    } catch(e) {
      return sourceUrl;
    }
  }
  if (rawUrl.startsWith('http') && rawUrl.length > 20) {
    return isValidCtaUrl(rawUrl, sourceUrl) ? rawUrl : (sourceUrl || rawUrl);
  }
  return sourceUrl;
}

// Match an extracted image to a feature card by comparing heading-context words to card title words.
// Each image is used at most once — caller passes a usedUrls Set; hero URL must be pre-seeded.
function matchImageToCard(card, images, usedUrls) {
  const stopWords = new Set(['the','that','this','with','from','have','will','your','their',
                             'when','what','before','and','for','not','are','was','has','been','which']);
  const cardWords = (card.title || '').toLowerCase()
    .split(/\W+/)
    .filter(w => w.length > 3 && !stopWords.has(w));
  if (!cardWords.length) return null;
  for (const img of (images || [])) {
    if (!img.headingContext || usedUrls.has(img.url)) continue;
    const ctxWords = img.headingContext.toLowerCase().split(/\W+/);
    const overlap = cardWords.filter(w => ctxWords.includes(w));
    if (overlap.length >= 1) {
      usedUrls.add(img.url);
      return img.url;
    }
  }
  return null;
}

// Strip dynamic/non-static elements from an HTML email before brand-DNA extraction.
// Returns { cleaned, wasComplex, gifCount } so callers know what was removed.
function cleanEmailHTML(html) {
  let cleaned = html;
  let wasComplex = false;

  // Scripts
  if (/<script[\s\S]*?<\/script>/i.test(cleaned)) { wasComplex = true; }
  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, '');

  // CSS animations & transitions inside <style> blocks
  if (/@keyframes|animation\s*:|transition\s*:/i.test(cleaned)) { wasComplex = true; }
  cleaned = cleaned.replace(/@keyframes[\s\S]*?\}/gi, '');
  cleaned = cleaned.replace(/animation\s*:[^;}"]{0,200};/gi, '');
  cleaned = cleaned.replace(/transition\s*:[^;}"]{0,200};/gi, '');

  // Videos
  if (/<video[\s\S]*?<\/video>/i.test(cleaned)) { wasComplex = true; }
  cleaned = cleaned.replace(/<video[\s\S]*?<\/video>/gi, '');

  // Forms
  if (/<form[\s\S]*?<\/form>/i.test(cleaned)) { wasComplex = true; }
  cleaned = cleaned.replace(/<form[\s\S]*?<\/form>/gi, '');

  // Inline event handlers
  if (/\s(on\w+)\s*=\s*["'][^"']*["']/i.test(cleaned)) { wasComplex = true; }
  cleaned = cleaned.replace(/\s(onclick|onload|onmouseover|onfocus|onblur|onerror|onsubmit|onchange)\s*=\s*["'][^"']*["']/gi, '');

  // GIFs — mark with data attribute and extract alt text as a note
  const gifRe = /<img([^>]*?)src=["']([^"']*\.gif(?:\?[^"']*)?)["']([^>]*?)>/gi;
  const gifAltTexts = [];
  let gifCount = 0;
  cleaned = cleaned.replace(gifRe, (_, pre, src, post) => {
    wasComplex = true;
    gifCount++;
    const altM = (pre + post).match(/alt=["']([^"']{1,80})["']/i);
    if (altM) gifAltTexts.push(altM[1]);
    return `<span data-was-gif="true" data-gif-alt="${altM ? altM[1] : ''}">[animated image${altM ? ': ' + altM[1] : ''}]</span>`;
  });

  return { cleaned, wasComplex, gifCount, gifAltTexts };
}

// Used by the /parse-html endpoint when users upload their original email HTML file.
function parseEmailHtmlContent(html) {
  if (!html || html.length < 20) return { success: false, error: 'Empty or too-short HTML' };

  // Clean dynamic elements before any extraction
  const { cleaned, wasComplex, gifCount, gifAltTexts } = cleanEmailHTML(html);
  html = cleaned;

  // ── PLAIN TEXT (populate body field + scoring) ──
  const textContent = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000);

  // ── DARK / LIGHT THEME ──
  // Helper: return true when a color string (hex or named) resolves to a dark luminance.
  const isColorDark = (color) => {
    if (!color) return false;
    const c = color.trim().toLowerCase().replace(/\s/g, '');
    if (c === 'black' || c === '#000' || c === '#000000') return true;
    if (c === 'white' || c === '#fff' || c === '#ffffff') return false;
    // Expand 3-char hex
    const hex6 = c.match(/^#([0-9a-f]{6})$/i)?.[1]
              || (() => { const h3 = c.match(/^#([0-9a-f]{3})$/i)?.[1]; return h3 ? h3[0]+h3[0]+h3[1]+h3[1]+h3[2]+h3[2] : null; })();
    if (hex6) {
      try { return hexToHSL('#' + hex6).l < 30; } catch { return false; }
    }
    // rgb(r,g,b)
    const rgbM = c.match(/^rgba?\((\d+),(\d+),(\d+)/);
    if (rgbM) {
      const lum = (parseInt(rgbM[1])*299 + parseInt(rgbM[2])*587 + parseInt(rgbM[3])*114) / 1000;
      return lum < 80;
    }
    return false;
  };

  let m;
  const bgValues = [];

  // 1. Scan <body> tag specifically for bgcolor and inline style background
  const bodyTagM = html.match(/<body\b([^>]{0,600})>/i);
  if (bodyTagM) {
    const bAttrs = bodyTagM[1];
    const bgcolorM = bAttrs.match(/bgcolor\s*=\s*["']?([^"'\s>]+)["']?/i);
    if (bgcolorM) bgValues.push(bgcolorM[1]);
    const styleM = bAttrs.match(/style\s*=\s*["']([^"']{0,300})["']/i);
    if (styleM) {
      const inlineBg = styleM[1].match(/background(?:-color)?\s*:\s*([^;}"]+)/i);
      if (inlineBg) bgValues.push(inlineBg[1].trim());
    }
  }

  // 2. Scan opening 5000 chars for CSS/inline background hex and named colors
  const outerHtml = html.slice(0, 5000);
  const bgInlineRe = /background(?:-color)?\s*[:=]\s*(#[0-9a-fA-F]{3,8}|black|(?:rgb\(\d+,\s*\d+,\s*\d+\)))/gi;
  const bgAttrRe   = /bgcolor\s*=\s*["']?(#[0-9a-fA-F]{3,8}|black)["']?/gi;
  while ((m = bgInlineRe.exec(outerHtml)) !== null) bgValues.push(m[1]);
  while ((m = bgAttrRe.exec(outerHtml))   !== null) bgValues.push(m[1]);

  // 3. Specifically match CSS block rules targeting the body selector,
  //    e.g. body { background-color: #1a1a1a } — missed by inline/attr scanners above.
  const cssBodyBg = html.match(/body[^{]*\{[^}]*background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,6})/i)?.[1];
  if (cssBodyBg) bgValues.push(cssBodyBg);

  const isDark = bgValues.some(isColorDark);

  // ── BRAND COLORS: all saturated hex codes, de-duped ──
  const allHex = new Set();
  const hexRe = /#([0-9a-fA-F]{6})\b/g;
  while ((m = hexRe.exec(html)) !== null) allHex.add('#' + m[1].toUpperCase());
  const brandColors = [...allHex]
    .filter(hex => {
      try { const { s, l } = hexToHSL(hex); return s >= 12 && l >= 10 && l <= 90; }
      catch { return false; }
    })
    .slice(0, 6)
    .map(value => ({ value, type: 'html-extracted' }));

  // ── LOGO: img with "logo" or "brand" in attributes, not an OG/social image ──
  // Social auth provider images (Google, Apple, GitHub, etc.) are never a company logo.
  const SOCIAL_AUTH_RE = /\b(google|facebook|apple|github|microsoft|twitter|linkedin|slack|discord|oauth|sign[-_]?in|sso|openid)\b/i;
  const isSocialImg = (attrs) => {
    const altV  = (attrs.match(/\balt=["']([^"']*)["']/i)   || [])[1] || '';
    const clsV  = (attrs.match(/\bclass=["']([^"']*)["']/i) || [])[1] || '';
    const idV   = (attrs.match(/\bid=["']([^"']*)["']/i)    || [])[1] || '';
    const srcV  = (attrs.match(/\bsrc=["']([^"']*)["']/i)   || [])[1] || '';
    const fname = srcV.split('/').pop().replace(/\?.*$/, '');
    return SOCIAL_AUTH_RE.test(altV) || SOCIAL_AUTH_RE.test(clsV) || SOCIAL_AUTH_RE.test(idV) || SOCIAL_AUTH_RE.test(fname);
  };
  let logo = null;
  const logoImgRe = /<img([^>]+)>/gi;
  while ((m = logoImgRe.exec(html)) !== null) {
    const attrs = m[1];
    if (/logo|brand|header/i.test(attrs) && !/opengraph|og[-_]|social[-_]|twitter/i.test(attrs)) {
      if (isSocialImg(attrs)) continue;
      const srcM = attrs.match(/src=["']([^"']+)["']/i);
      if (srcM && srcM[1] && !srcM[1].startsWith('data:')) { logo = srcM[1]; break; }
    }
  }

  // ── EMOJI PRESENCE → contentStyle hint ──
  const hasEmoji = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u.test(textContent);

  // ── CTA URL: first real non-tracking link ──
  let primaryCtaUrl = null;
  const linkRe = /href=["']([^"']+)["']/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1];
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) continue;
    if (/unsubscribe|privacy|manage|preferences|view.*browser|tracking|resend-click/i.test(href)) continue;
    if (href.startsWith('http')) { primaryCtaUrl = href; break; }
  }

  // ── FONT FAMILY ──
  const fontM = html.match(/font-family\s*:\s*([^;,"'}{]+)/i);
  const fontFamily = fontM ? fontM[1].trim().split(',')[0].replace(/['"]/g, '').trim() : null;

  return {
    success: true,
    source: 'html-upload',
    theme: isDark ? 'dark' : 'light',
    isDark,
    isDarkTheme: isDark,
    colors: brandColors,
    logo,
    hasEmoji,
    contentStyle: hasEmoji ? 'boxes' : 'longform',
    primaryCtaUrl,
    url: primaryCtaUrl,
    fontFamily,
    textContent,
    wasComplex,
    gifCount
  };
}

// Detect if the original email body is a promotional-grid type.
// Strips HTML first so tags don't interfere with CTA/deal matching.
function detectPromotionalGrid(text) {
  if (!text) return false;
  const stripped = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  const ctaCount = (stripped.match(
    /\b(order now|shop now|buy now|get now|claim now|view deal|see offer|explore more|learn more)\b/gi
  ) || []).length;

  const dealCount = (stripped.match(
    /buy.{1,10}get|free item|free delivery|€\d+|£\d+|\$\d+|\d+%\s*off|bogo|2for1|complimentary/gi
  ) || []).length;

  const productCount = (stripped.match(
    /\b(order|shop|buy|view|explore)\s+now\b/gi
  ) || []).length;

  return ctaCount >= 3 || dealCount >= 2 || productCount >= 3;
}

function getUnsplashForItem(name) {
  const keywords = {
    'pizza':      'photo-1513104890138-7c749659a591',
    'burger':     'photo-1568901346375-23c9450c58cd',
    'sushi':      'photo-1579871494447-9811cf80d66c',
    'noodle':     'photo-1569718212165-3a8278d5f624',
    'starbucks':  'photo-1495474472287-4d71bcdd2085',
    'coffee':     'photo-1495474472287-4d71bcdd2085',
    'mcdonald':   'photo-1568901346375-23c9450c58cd',
    'restaurant': 'photo-1414235077428-338989a2e8c0',
    'food':       'photo-1504674900247-0877df9cc836',
    'default':    'photo-1414235077428-338989a2e8c0'
  };

  const nameLower = name.toLowerCase();
  const match = Object.entries(keywords).find(([key]) => nameLower.includes(key));
  const photoId = match ? match[1] : keywords.default;
  return `https://images.unsplash.com/${photoId}?w=280&h=200&fit=crop`;
}

// Extract product/restaurant cards from the original body text.
// Works on raw HTML or plain text — strips tags, normalises whitespace,
// then splits at any CTA variant. Compatible with food delivery, e-commerce,
// SaaS deals, travel, and any multi-product promotional email.
function extractPromotionalItems(text) {
  if (!text) return [];

  const stripped = text
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s{3,}/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 1)
    .join('\n');

  const items = [];
  const ctaPattern = /order now|shop now|buy now|get now|view deal/gi;
  const chunks = stripped.split(ctaPattern);

  chunks.slice(0, -1).forEach(chunk => {
    const lines = chunk.split('\n').filter(l => l.trim().length > 2);

    const name = lines.filter(l =>
      l.length > 2 &&
      l.length < 80 &&
      !l.match(/^\d+$/) &&
      !l.match(/^(buy|free|€|£|\$|order|shop)/i)
    ).pop()?.trim();

    const dealLine = lines.find(l =>
      l.match(/buy.{1,10}get|free item|free delivery|€\d+|£\d+|\$\d+|\d+%\s*off|€0/i)
    );

    if (name && name.length > 2) {
      items.push({
        name,
        deal: dealLine?.trim() || '',
        image: getUnsplashForItem(name)
      });
    }
  });

  return items;
}

// Extract the main headline/hero text from the original email body for promo-grid emails.
// Returns the first short line (< 80 chars) that isn't a deal, CTA, or footer signal.
function extractHeroText(text) {
  if (!text) return '';
  const SKIP = /^(order|shop|buy|explore|unsubscribe|view|click|learn|get started|terms|privacy|manage|preferences)/i;
  const DEAL = /\bfree\b|%\s*off|€\s*\d|\$\s*\d|delivery fee/i;
  const lines = text.split(/[\n\r]+/).map(l => l.trim()).filter(l => l.length > 5 && l.length < 100);
  for (const line of lines) {
    if (SKIP.test(line)) continue;
    if (DEAL.test(line)) continue;
    return line;
  }
  return '';
}

// Strip emoji benefit-card tables from Claude HTML when contentStyle is longform.
// Matches the exact table structure emitted by the SECTION STRUCTURE section 4 prompt.
function stripEmojiBoxTables(html) {
  // Remove tables whose first cell is exactly 40px wide (the emoji column)
  // These are the single-card tables: <table ...><tr><td ...width:40px...>
  return html.replace(
    /<table[^>]*cellpadding="0"[^>]*>\s*<tr>\s*<td[^>]*>\s*<table[^>]*>\s*<tr>\s*<td[^>]*width:\s*40px[^>]*>[\s\S]*?<\/table>\s*<\/td>\s*<\/tr>\s*<\/table>/gi,
    ''
  ).replace(
    // Also remove section dividers left orphaned (height:1px;background:#...)
    /<table[^>]*>\s*<tr>\s*<td[^>]*height:1px;background[^>]*>&nbsp;<\/td>\s*<\/tr>\s*<\/table>/gi,
    ''
  ).trim();
}

function extractAddressFromBody(originalBody) {
  if (!originalBody) return null;
  const lines = (originalBody || '').split('\n').map(l => l.trim()).filter(Boolean);
  const tail = lines.slice(-10);
  return tail.find(l =>
    /\d{5}(-\d{4})?/.test(l) ||
    /(street|avenue|blvd|boulevard|drive|road|suite|st\.|rd\.)/i.test(l) ||
    /p\.?o\.?\s*box/i.test(l) ||
    /(unsubscribe|opt.?out|manage.*pref)/i.test(l)
  ) || null;
}

// Extract a named XML section from Claude's body output.
// Returns trimmed inner content or null if the tag is absent / empty.
function extractSection(html, tag) {
  const m = (html || '').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

// ── LANGUAGE DETECTION + UI LABELS ───────────────────────────────────────────
function detectLanguage(text) {
  const t = (text || '').slice(0, 2000);
  if (/[șțăîâ]/i.test(t) || /\b(și|sau|pentru|că|este|sunt|cu|la|de|în)\b/i.test(t)) return 'ro';
  if (/[áéíóúüñ]/i.test(t) || /\b(está|son|para|pero|como|también|más|por|que|los|las|del)\b/i.test(t)) return 'es';
  if (/[éàèùâêîôûœæç]/i.test(t) || /\b(est|sont|avec|pour|dans|sur|par|pas|plus|vous|nous|les|des|une|que)\b/i.test(t)) return 'fr';
  if (/[åäö]/i.test(t) || /\b(är|och|att|det|en|ett|som|på|för|med|av|om|han|hon|de|vi|till|från|du|din)\b/i.test(t)) return 'sv';
  if (/[äöüß]/i.test(t) || /\b(ist|sind|nicht|auch|aber|oder|und|für|mit|bei|dem|den|das|die|der)\b/i.test(t)) return 'de';
  return 'en';
}

const UI_LABELS = {
  en: { before: 'Before',  after: 'After',    original: 'Original', rebuilt: 'Rebuilt',       whatChanged: 'What changed &amp; why' },
  ro: { before: 'Înainte', after: 'După',     original: 'Original', rebuilt: 'Reconstruit',   whatChanged: 'Ce s-a schimbat și de ce' },
  es: { before: 'Antes',   after: 'Después',  original: 'Original', rebuilt: 'Reconstruido',  whatChanged: 'Qué cambió y por qué' },
  fr: { before: 'Avant',   after: 'Après',    original: 'Original', rebuilt: 'Reconstruit',   whatChanged: 'Ce qui a changé et pourquoi' },
  de: { before: 'Vorher',  after: 'Nachher',  original: 'Original', rebuilt: 'Neu erstellt',  whatChanged: 'Was sich geändert hat und warum' },
  sv: { before: 'Innan',   after: 'Efter',    original: 'Original', rebuilt: 'Återbyggd',     whatChanged: 'Vad som förändrades och varför' },
};

function proxyUrl(u) {
  if (!u || !u.startsWith('http')) return u || '';
  return `/proxy-image?url=${encodeURIComponent(u)}`;
}

function buildNewsletterHTML(company, subject, body, brandDNA, options = {}) {
  // Guard all critical inputs — never render the string "undefined" or "null" in output HTML
  company = safeVal(company) || 'Your Company';
  subject = safeVal(subject);
  body    = safeVal(body);
  // Abort immediately if either critical field is blank — caller should have already validated
  if (!subject && !body) return '<!-- buildNewsletterHTML: missing subject and body -->';
  const { tier = 'free_trial', originalBody = '', ctaHref = 'https://strategic-flow-audit.replit.app', heroKeyword = '', contentStyle = '', flatFields = null, sourceHtml = '', featureCards = null, emailType: htmlEmailType = '', labelBefore = 'Before', labelAfter = 'After' } = options;

  // Extract ONLY brand accent colors — the template always uses its own dark palette.
  const { primaryColor: rawPrimary, accentColor: rawAccent, primaryText, accentText } = getEmailColors(brandDNA);

  // Ensure accent colors are bright enough to pop on dark backgrounds (lightness ≥ 50%)
  let primaryColor = rawPrimary;
  let accentColor  = rawAccent;
  try {
    const p = hexToHSL(primaryColor);
    if (p.l < 42) primaryColor = hslToHex(p.h, Math.max(p.s, 55), 55);
  } catch (_) {}
  try {
    const a = hexToHSL(accentColor);
    if (a.l < 42) accentColor = hslToHex(a.h, Math.max(a.s, 55), 58);
  } catch (_) {}

  // ── BRAND COLOR OVERRIDES — applied after lightness boost so exact hex is preserved
  const BRAND_COLOR_OVERRIDES = {
    'microsoft': '#0078d4', 'microsoft advertising': '#0078d4',
    'google': '#4285f4',    'meta': '#0866ff',
    'stripe': '#635bff',    'linear': '#5e6ad2',
    'notion': '#000000',    'figma': '#f24e1e',
    'vercel': '#000000',    'github': '#24292F',
    'slack': '#4A154B',
  };
  const _brandKey = company.toLowerCase().trim();
  for (const [k, v] of Object.entries(BRAND_COLOR_OVERRIDES)) {
    if (_brandKey === k || _brandKey.startsWith(k + ' ')) { primaryColor = v; break; }
  }

  // ── THEME DETECTION — light brands get white backgrounds ───────────────────
  const _bTheme  = brandDNA?.theme || 'light';
  const _isDark  = _bTheme === 'dark' || brandDNA?.isDarkTheme === true;
  let isLightBrand = !_isDark;

  // Multi-signal light-brand detection:
  // Check 1: known light-brand primary colors (whitelist)
  // Check 2: source page HTML contains white/light background declarations
  const _detectBrandLight = (hex, pageHtml) => {
    const lightColors = ['3df2b6','4fe0b0','f8a21f','00b67a','ff6b35','0070f3','0037ff','3f3cdc','1d1b98'];
    const c = (hex || '').replace('#', '').toLowerCase();
    const isLightColor = lightColors.some(x => c.includes(x));
    const hasWhiteBg = (pageHtml || '').includes('background:#fff')
                    || (pageHtml || '').includes('background-color:#fff')
                    || (pageHtml || '').includes('background: #fff')
                    || (pageHtml || '').includes('background:white');
    return isLightColor || hasWhiteBg;
  };
  if (_detectBrandLight(primaryColor, sourceHtml)) isLightBrand = true;

  // HSL-based override: pastel primaries (L > 60%) also get white backgrounds
  try {
    const _primaryHSL = hexToHSL(primaryColor);
    if (_primaryHSL.l > 60) isLightBrand = true;
  } catch (_) {}

  const emailOuterBg       = isLightBrand ? '#f5f5f5'              : '#111111';
  const emailInnerBg       = isLightBrand ? '#ffffff'              : '#0a0a0a';
  const emailHeaderBg      = isLightBrand ? '#ffffff'              : '#111111';
  const emailTextColor     = isLightBrand ? '#1a1a18'              : '#ffffff';
  const emailMutedColor    = isLightBrand ? '#6b6b66'              : 'rgba(255,255,255,0.65)';
  const emailBodyTextColor = isLightBrand ? '#3a3a35'              : 'rgba(255,255,255,0.85)';

  const bgColor      = emailOuterBg;
  const containerBg  = emailInnerBg;
  const textColor    = emailTextColor;
  const mutedText    = emailMutedColor;
  const cardBg       = isLightBrand ? '#f0f0f0'              : '#1e1e1e';
  const dividerColor = isLightBrand ? '#e0e0e0'              : '#2a2a2a';
  // Header band: light brands use their primary color as accent strip
  const headerBg   = primaryColor;
  const headerText = primaryText;
  const footerBg   = isLightBrand ? '#eeeeee'                : '#0d0d0d';
  // Derived adaptive tokens for v2 template (dark vs light readable equivalents)
  const borderMuted   = isLightBrand ? 'rgba(0,0,0,0.10)'   : 'rgba(255,255,255,0.10)';
  const borderStrong  = isLightBrand ? 'rgba(0,0,0,0.08)'   : 'rgba(255,255,255,0.08)';
  const textStrong    = isLightBrand ? textColor             : '#ffffff';
  const textMedium    = isLightBrand ? mutedText             : 'rgba(255,255,255,0.65)';
  const textBody      = emailBodyTextColor;
  const footerOverlay = isLightBrand ? 'rgba(0,0,0,0.03)'   : 'rgba(0,0,0,0.25)';
  const footerTxtMuted = isLightBrand ? 'rgba(0,0,0,0.40)'  : 'rgba(255,255,255,0.35)';
  const footerTxtDim   = isLightBrand ? 'rgba(0,0,0,0.25)'  : 'rgba(255,255,255,0.20)';
  // Adaptive tokens for stat cards, quote block, and CTA gradient
  const statLabelColor   = isLightBrand ? '#6b6b66'            : 'rgba(255,255,255,0.50)';
  const statBorderColor  = isLightBrand ? 'rgba(0,0,0,0.08)'   : 'rgba(255,255,255,0.12)';
  const quoteTextColor   = isLightBrand ? '#1a1a18'             : '#ffffff';
  const quoteAttribColor = isLightBrand ? '#6b6b66'             : 'rgba(255,255,255,0.40)';
  const ctaGradient      = isLightBrand
    ? `linear-gradient(135deg,${primaryColor} 0%,#548dff 100%)`
    : `linear-gradient(135deg,${primaryColor} 0%,#7c3aed 100%)`;

  // Logo: icon (36×36, rounded) beside brand name text — always shows name for readability.
  // apple-touch-icon / PNG favicon → img; nothing found → name only.
  const logoUrl = brandDNA?.logo || null;
  const logoHtml = logoUrl
    ? `<img src="${proxyUrl(logoUrl)}" alt="${company}" style="height:36px;width:36px;border-radius:8px;display:inline-block;vertical-align:middle;margin-right:10px;" onerror="this.style.display='none';" /><span style="font-size:20px;font-weight:900;color:${primaryColor};letter-spacing:-0.5px;vertical-align:middle;">${company}</span>`
    : `<span style="font-size:20px;font-weight:900;color:${textStrong};letter-spacing:-0.5px;">${company}</span>`;
  // Right cell: issue date
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  // Hero image: topic-first, then industry fallback. heroKeyword comes from Claude's JSON response.
  const buildHeroSrc = (comp, dna, heroKeyword) => {
    const ind = (dna?.industry || '').toLowerCase();
    const kw  = (heroKeyword || '').toLowerCase();

    // Topic-level keyword map — checked first, higher priority than industry
    const topicPhotoMap = {
      'cybersecurity':           'photo-1550751827-4bd374c3f58b',
      'security':                'photo-1550751827-4bd374c3f58b',
      'penetration testing':     'photo-1550751827-4bd374c3f58b',
      'pentesting':              'photo-1550751827-4bd374c3f58b',
      'language learning':       'photo-1543269865-cbf427effbad',
      'crm':                     'photo-1460925895917-afdab827c52f',
      'dashboard':               'photo-1460925895917-afdab827c52f',
      'startup':                 'photo-1559136555-9303baea8ebd',
      'funding':                 'photo-1559136555-9303baea8ebd',
      'ai':                      'photo-1677442135703-1787eea5ce01',
      'artificial intelligence': 'photo-1677442135703-1787eea5ce01',
      'machine learning':        'photo-1677442135703-1787eea5ce01',
      'coding':                  'photo-1518770660439-4636190af475',
      'developer':               'photo-1518770660439-4636190af475',
      'programming':             'photo-1518770660439-4636190af475',
      'marketing':               'photo-1533750516457-a7f992034fec',
      'mobile payment':          'photo-1556742049-0cfed4f6a45d',
      'payment checkout':        'photo-1556742049-0cfed4f6a45d',
      'mobile checkout':         'photo-1556742049-0cfed4f6a45d',
      'checkout':                'photo-1556742049-0cfed4f6a45d',
      'digital wallet':          'photo-1556742049-0cfed4f6a45d',
      'contactless payment':     'photo-1556742049-0cfed4f6a45d',
      'payment trends':          'photo-1556742049-0cfed4f6a45d',
      'ecommerce checkout':      'photo-1556742049-0cfed4f6a45d',
      'online checkout':         'photo-1556742049-0cfed4f6a45d',
      'data analytics':          'photo-1551288049-bebda4e38f71',
      'analytics dashboard':     'photo-1551288049-bebda4e38f71',
      'business intelligence':   'photo-1551288049-bebda4e38f71',
      'email marketing':         'photo-1557200134-90327ee9fafa',
      'conversion rate':         'photo-1533750516457-a7f992034fec',
      'growth hacking':          'photo-1533750516457-a7f992034fec',
      'product launch':          'photo-1559136555-9303baea8ebd',
      'saas onboarding':         'photo-1484480974693-6ca0a78fb36b',
      'remote work':             'photo-1588196749597-9ff075ee6b5b',
      'team collaboration':      'photo-1600880292089-90a7e086ee0c',
    };

    // Industry fallback map
    const industryPhotoMap = [
      [['language learning', 'language education', 'memrise', 'duolingo', 'linguist'], 'photo-1543269865-cbf427effbad'],
      [['machine learning', 'artificial intelligence', 'deep learning', 'ai research',
        'ai startup', 'ai platform', 'ai-powered', 'generative ai', 'large language'],  'photo-1518770660439-4636190af475'],
      [['edtech', 'education technology', 'online learning', 'e-learning'],             'photo-1503676260728-1c00da094a0b'],
      [['education', 'school', 'university', 'training', 'learning'],                  'photo-1503676260728-1c00da094a0b'],
      [['saas', 'software as a service', 'productivity', 'workflow', 'project management'], 'photo-1484480974693-6ca0a78fb36b'],
      [['fintech', 'payments', 'payment processing', 'banking', 'investment', 'wealth', 'finance'], 'photo-1611974789855-9c2a0a7236a3'],
      [['healthcare', 'medical', 'clinical', 'health', 'wellness', 'mental health'],   'photo-1576091160399-112ba8d25d1d'],
      [['fitness', 'sport', 'gym', 'workout'],                                          'photo-1517836357463-d25dfeac3438'],
      [['ecommerce', 'e-commerce', 'dtc', 'direct-to-consumer', 'retail', 'fashion'],  'photo-1472851294608-062f824d29cc'],
      [['marketing', 'advertising', 'seo', 'growth marketing', 'digital marketing'],   'photo-1533750516457-a7f992034fec'],
      [['design', 'creative', 'branding', 'agency'],                                   'photo-1561070791-2526d30994b5'],
      [['real estate', 'property', 'realty', 'proptech'],                              'photo-1560518883-ce09059eeffa'],
      [['travel', 'tourism', 'hospitality', 'hotel'],                                  'photo-1488646953014-85cb44e25828'],
      [['food', 'restaurant', 'beverage', 'culinary', 'foodtech'],                     'photo-1414235077428-338989a2e8c0'],
      [['security', 'cybersecurity', 'infosec'],                                       'photo-1550751827-4bd374c3f58b'],
      [['hr', 'human resources', 'recruitment', 'talent'],                             'photo-1521737604893-d14cc237f11d'],
      [['logistics', 'supply chain', 'shipping', 'freight'],                           'photo-1586528116311-ad8dd3c8310d'],
      [['consulting', 'advisory', 'professional services', 'legal', 'law'],            'photo-1450101499163-c8848c66ca85'],
      [['startup', 'venture'],                                                          'photo-1519389950473-47ba0277781c'],
      [['b2b', 'enterprise', 'software'],                                              'photo-1460925895917-afdab827c52f'],
    ];

    // 1. Try heroKeyword match first (topic-level)
    if (kw) {
      for (const [topicKey, topicId] of Object.entries(topicPhotoMap)) {
        if (kw.includes(topicKey) || topicKey.includes(kw)) {
          return `https://images.unsplash.com/${topicId}?w=620&h=300&fit=crop`;
        }
      }
    }

    // 2. Fall back to industry match
    let photoId = 'photo-1460925895917-afdab827c52f'; // default: clean workspace
    for (const [patterns, id] of industryPhotoMap) {
      if (patterns.some(p => ind.includes(p))) { photoId = id; break; }
    }
    return `https://images.unsplash.com/${photoId}?w=620&h=300&fit=crop`;
  };
  // Hero image priority: 1) og:image from the fetched URL (always the real cover)
  // 2) first extracted product image (from page HTML) — only when og:image is absent
  // 3) Unsplash topic/industry fallback — last resort only
  // Never use a logo image as the hero — logos make terrible hero banners.
  const _isLogoUrl = u => /logo|typelogo|symbol|favicon/i.test(u || '');
  const _isJunkImg  = u => {
    if (!u) return true;
    if (/avatar|icon|sprite|pixel|track|beacon|1x1/i.test(u)) return true;
    const wM = u.match(/[?&](?:width|w)=(\d+)/i);
    const hM = u.match(/[?&](?:height|h)=(\d+)/i);
    if (wM && hM && (parseInt(wM[1]) < 200 || parseInt(hM[1]) < 200)) return true;
    return false;
  };
  const _firstProductImg = (() => {
    const imgs = Array.isArray(options.productImages) ? options.productImages : [];
    const nonLogo = imgs.filter(img => img.url && !_isLogoUrl(img.url) && !_isJunkImg(img.url));
    return nonLogo.length ? nonLogo[0].url : null;
  })();
  const _rawHeroUrl = options.heroImageUrl || null;
  const _heroCandidate = (_rawHeroUrl && !_isLogoUrl(_rawHeroUrl) && !_isJunkImg(_rawHeroUrl)) ? _rawHeroUrl : null;
  const heroSrc = _heroCandidate || _firstProductImg || buildHeroSrc(company, brandDNA, options.heroKeyword);

  // Image feature cards: if productImages has 2–4 items, images 2–N become cards below the stat row.
  // If 1 image: hero only. If 5+: hero only, rest ignored.
  const _imgFeatureCardsHtml = (() => {
    const allImgs = Array.isArray(options.productImages) ? options.productImages.filter(img => img && img.url && !_isLogoUrl(img.url) && !_isJunkImg(img.url)) : [];
    if (allImgs.length < 2 || allImgs.length > 4) return '';
    const extras = allImgs.slice(1);
    if (!extras.length) return '';
    return extras.map(img => {
      const cleanAlt = (img.alt || '').includes('|') ? '' : (img.alt || '');
      const caption = cleanAlt ? `<tr><td style="padding:6px 0 0;font-size:12px;color:${textMedium};line-height:1.4;font-style:italic;">${cleanAlt}</td></tr>` : '';
      return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr><td style="padding:0;line-height:0;"><img src="${proxyUrl(img.url)}" alt="${cleanAlt}" style="width:100%;max-height:200px;object-fit:cover;border-radius:8px;display:block;border:0;" onerror="this.style.display='none';this.parentElement.style.display='none';" /></td></tr>${caption}</table>`;
    }).join('');
  })();

  // Footer colors — always dark (template is dark-first)
  const footerBorder = '#1e1e1e';
  const footerText   = '#888888';
  const footerMuted  = '#555555';

  // Footer logo (small, centered)
  const footerLogo = brandDNA?.logo
    ? `<img src="${proxyUrl(brandDNA.logo)}" alt="${company}" style="max-height:28px;display:block;margin:0 auto 10px;" onerror="this.style.display='none';" />`
    : '';

  // Tagline from site meta description (capped at 90 chars for footer)
  const taglineText = (() => {
    const raw = (brandDNA?.meta?.description || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (!raw) return '';
    const trimmed = raw.length > 90 ? raw.slice(0, 87) + '...' : raw;
    return `<p style="font-size:12px;color:${footerMuted};margin:0 0 8px;line-height:1.5;">${trimmed}</p>`;
  })();

  // ── FIX 4: PARSER — extract all XML tags from Claude's body output ─────────
  // Strip any Resend tracking pixels/URLs that Claude may have copied from the source email
  const rawBody = (body || '').replace(/<img[^>]*resend-clicks\.com[^>]*>/gi, '').trim();
  const isHtmlBody = rawBody.startsWith('<');

  // Extract template fields — prefer pre-parsed flatFields (new JSON format), fall back to XML extraction
  const ff = flatFields || null;
  const p_preheader    = ff?.preheader       || extractSection(rawBody, 'preheader')         || '';
  const p_hook         = ff?.headline        || extractSection(rawBody, 'hook')              || '';
  const p_tension      = ff ? truncateLead(ff.lead || '', 40) : truncateLead(extractSection(rawBody, 'tension') || '', 40);
  const p_stat1Value   = ff?.stat1Value      || extractSection(rawBody, 'stat1_value')       || '';
  const p_stat1Label   = ff?.stat1Label      || extractSection(rawBody, 'stat1_label')       || '';
  const p_stat2Value   = ff?.stat2Value      || extractSection(rawBody, 'stat2_value')       || '';
  const p_stat2Label   = ff?.stat2Label      || extractSection(rawBody, 'stat2_label')       || '';
  const p_stat3Value   = ff?.stat3Value      || extractSection(rawBody, 'stat3_value')       || '';
  const p_stat3Label   = ff?.stat3Label      || extractSection(rawBody, 'stat3_label')       || '';
  const p_insight      = ff?.body?.[0]       || extractSection(rawBody, 'insight')           || '';
  const p_proof        = ff?.body?.[1]       || extractSection(rawBody, 'proof')             || '';
  const p_cost         = ff?.body?.[2]       || extractSection(rawBody, 'cost')              || '';
  const p_ctaText      = ff?.ctaText         || extractSection(rawBody, 'cta_text')          || 'Read the full story →';
  const p_ctaUrl       = cleanCTAUrl(ff?.ctaUrl || extractSection(rawBody, 'cta_url'), ctaHref);
  const p_calWeek1     = ff?.calendarWeek1   || extractSection(rawBody, 'calendar_week1')    || '';
  const p_calWeek2     = ff?.calendarWeek2   || extractSection(rawBody, 'calendar_week2')    || '';
  const p_calWeek3     = ff?.calendarWeek3   || extractSection(rawBody, 'calendar_week3')    || '';
  const p_calWeek4     = ff?.calendarWeek4   || extractSection(rawBody, 'calendar_week4')    || '';
  const p_brandTagline = ff?.brandTagline    || extractSection(rawBody, 'brand_tagline')     || '';
  const p_brandDesc      = ff?.brandDescription || extractSection(rawBody, 'brand_description') || '';
  const p_conversionType = ff?.conversionType || '';
  const p_quoteText      = ff?.quoteText      || '';
  const p_quotePerson    = ff?.quotePerson    || '';
  const p_beforeState    = ff?.beforeState    || '';
  const p_afterState     = ff?.afterState     || '';

  // New format: flatFields provided directly, OR XML tags detected in body
  const isNewFormat = !!(ff || p_preheader || p_stat1Value || p_ctaText !== 'Read the full story →' ||
                         p_calWeek1 || p_brandTagline || p_brandDesc ||
                         extractSection(rawBody, 'cta_text'));

  // ── Old XML section tags (v1 — backward compat) ───────────────────────────
  const oldHookContent    = isNewFormat ? null : extractSection(rawBody, 'hook');
  const oldTensionContent = isNewFormat ? null : extractSection(rawBody, 'tension');
  const oldStatsContent   = isNewFormat ? null : extractSection(rawBody, 'stats');
  const oldInsightContent = isNewFormat ? null : extractSection(rawBody, 'insight');
  const oldProofContent   = isNewFormat ? null : extractSection(rawBody, 'proof');
  const oldCostContent    = isNewFormat ? null : extractSection(rawBody, 'cost');
  const oldCtaTagText     = isNewFormat ? null : extractSection(rawBody, 'cta');
  const hasOldXmlSections = !isNewFormat &&
    !!(oldHookContent && oldTensionContent && oldInsightContent && oldProofContent && oldCostContent);

  // ── Build derived blocks for new template ─────────────────────────────────
  // Stat cards — only rendered when at least one stat has a value
  const statCardsHtml = (() => {
    const stats = [
      { v: p_stat1Value, l: p_stat1Label },
      { v: p_stat2Value, l: p_stat2Label },
      { v: p_stat3Value, l: p_stat3Label },
    ].filter(s => s.v && s.v.trim().length > 0);
    if (!stats.length) return '';
    const count = stats.length;
    const colWidth  = count === 1 ? '100%' : count === 2 ? '50%' : '33%';
    const valueFontSize = count === 1 ? '36px' : '28px';
    const cells = stats.map((s, i) => {
      const borderLeft = i > 0 ? `border-left:1px solid ${statBorderColor};` : '';
      const align = count === 1 ? 'text-align:center;' : 'text-align:center;';
      return `<td style="width:${colWidth};${align}padding:${count === 1 ? '24px 16px' : '16px 8px'};${borderLeft}">
        <p style="font-size:${valueFontSize};font-weight:900;color:${primaryColor};margin:0;line-height:1;">${s.v}</p>
        <p style="font-size:11px;color:${statLabelColor};margin:5px 0 0;line-height:1.4;">${s.l}</p>
      </td>`;
    }).join('');
    return `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${statBorderColor};border-radius:8px;margin:0;"><tr>${cells}</tr></table>`;
  })();

  // Calendar rows — only rendered when at least one week has content
  const calendarRowsHtml = (() => {
    const weeks = [
      { label: 'Week 1', topic: (p_calWeek1 || '').replace(/^Day\s*\d+[:\-]?\s*/i, '').replace(/^Week\s*\d+[:\-]?\s*/i, '') },
      { label: 'Week 2', topic: (p_calWeek2 || '').replace(/^Day\s*\d+[:\-]?\s*/i, '').replace(/^Week\s*\d+[:\-]?\s*/i, '') },
      { label: 'Week 3', topic: (p_calWeek3 || '').replace(/^Day\s*\d+[:\-]?\s*/i, '').replace(/^Week\s*\d+[:\-]?\s*/i, '') },
      { label: 'Week 4', topic: (p_calWeek4 || '').replace(/^Day\s*\d+[:\-]?\s*/i, '').replace(/^Week\s*\d+[:\-]?\s*/i, '') },
    ].filter(w => w.topic);
    return weeks.map((w, i) =>
      `<div style="padding:12px 20px;${i > 0 ? 'border-top:1px solid rgba(255,255,255,0.05);' : ''}">
        <span style="font-size:10px;font-weight:700;color:${primaryColor};text-transform:uppercase;letter-spacing:1px;">${w.label}</span>
        <p style="font-size:13px;color:rgba(255,255,255,0.70);margin:3px 0 0;line-height:1.5;">${w.topic}</p>
      </div>`
    ).join('');
  })();

  // Conversion element: quote block OR before/after comparison card (only for new format)
  const conversionElementHtml = (() => {
    if (!isNewFormat) return '';
    if (p_conversionType === 'quote' && p_quoteText) {
      return `<table width="100%" cellpadding="0" cellspacing="0" style="border-left:3px solid ${primaryColor};border-radius:2px;margin:0;"><tr><td style="padding:18px 24px;">
        <p style="font-size:15px;color:${quoteTextColor};line-height:1.7;margin:0 0 10px;font-style:italic;">"${p_quoteText}"</p>
        ${p_quotePerson ? `<p style="font-size:11px;color:${quoteAttribColor};margin:0;letter-spacing:.04em;">${p_quotePerson}</p>` : ''}
      </td></tr></table>`;
    }
    if (p_beforeState || p_afterState) {
      return `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(0,0,0,0.08);border-radius:8px;margin:0;">
        <tr>
          <td style="padding:16px 20px;vertical-align:top;background:rgba(255,255,255,0.03);border-bottom:1px solid rgba(255,255,255,0.10);">
            <p style="font-size:10px;font-weight:700;color:#999999;text-transform:uppercase;letter-spacing:1px;margin:0 0 6px;">${labelBefore}</p>
            <p style="font-size:13px;color:#555555;margin:0;line-height:1.5;">${p_beforeState}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 20px;vertical-align:top;background:${primaryColor}14;">
            <p style="font-size:10px;font-weight:700;color:#3c91dc;text-transform:uppercase;letter-spacing:1px;margin:0 0 6px;">${labelAfter}</p>
            <p style="font-size:13px;color:#1a1a18;margin:0;line-height:1.5;">${p_afterState}</p>
          </td>
        </tr>
      </table>`;
    }
    return '';
  })();

  // ── Legacy bodyContent (used by old-format and promotional-grid paths) ────
  let bodyContent = '';

  if (!isNewFormat) {
    if (hasOldXmlSections) {
      const sectionLabel = text =>
        `<p style="font-size:10px;font-weight:700;color:${primaryColor};text-transform:uppercase;letter-spacing:2px;margin:32px 0 6px 0;">${text}</p>`;
      const processHtml = html =>
        adaptBodyForDarkTheme(
          (html || '')
            .replace(/CTABGCOLOR/g,   primaryColor)
            .replace(/CTATEXTCOLOR/g, primaryText)
            .replace(/CTAACCENTCOLOR/g, accentColor)
            .replace(/href="#" target="_blank"/g, `href="${ctaHref}" target="_blank"`)
        );
      const statsBlock = (oldStatsContent && oldStatsContent.trim()) ? processHtml(oldStatsContent) : '';
      const btnText = (oldCtaTagText || 'Read the full story →').trim();
      const ctaBlock = `<table cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:28px 0 8px;"><tr><td style="padding:3px;background:linear-gradient(135deg,${primaryColor} 0%,${accentColor} 100%);border-radius:10px;"><table cellpadding="0" cellspacing="0" style="width:100%;background:${containerBg};border-radius:8px;"><tr><td style="padding:28px 32px;text-align:center;"><table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td align="center" bgcolor="${primaryColor}" style="background:${primaryColor};border-radius:6px;"><a href="${ctaHref}" target="_blank" style="display:inline-block;background:${primaryColor};color:${primaryText};font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;text-decoration:none;padding:16px 40px;border-radius:6px;-webkit-text-size-adjust:none;mso-padding-alt:0;">${btnText}</a></td></tr></table></td></tr></table></td></tr></table>`;
      bodyContent = [
        `<p style="font-size:22px;font-weight:900;color:${textColor};line-height:1.35;margin:0 0 24px;letter-spacing:-0.3px;">${oldHookContent}</p>`,
        processHtml(oldTensionContent),
        statsBlock,
        processHtml(oldInsightContent),
        processHtml(oldProofContent),
        processHtml(oldCostContent),
        ctaBlock
      ].filter(Boolean).join('\n');
    } else if (isHtmlBody) {
      let processed = rawBody
        .replace(/CTABGCOLOR/g, primaryColor)
        .replace(/CTATEXTCOLOR/g, primaryText)
        .replace(/CTAACCENTCOLOR/g, accentColor)
        .replace(/href="#" target="_blank"/g, `href="${ctaHref}" target="_blank"`);
      if (contentStyle === 'longform' || contentStyle === 'steps') processed = stripEmojiBoxTables(processed);
      processed = adaptBodyForDarkTheme(processed);
      bodyContent = processed;
    } else {
      const lines = rawBody.split('\n').map(l => l.trim()).filter(Boolean);
      const lastLine = lines[lines.length - 1] || '';
      const looksLikeCTA = lastLine.length > 0 && lastLine.length < 80 && !lastLine.endsWith('.');
      const ctaText   = looksLikeCTA ? lastLine : '';
      const bodyLines = looksLikeCTA ? lines.slice(0, -1) : lines;
      const formattedBody = bodyLines.join('\n')
        .replace(/\n\n/g, `</p><p style="font-size:16px;color:${textColor};line-height:1.75;margin:0 0 20px;">`)
        .replace(/\n/g, '<br>');
      const legacyCtaBlock = ctaText
        ? `<table cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:28px 0 8px;"><tr><td style="padding:3px;background:linear-gradient(135deg,${primaryColor} 0%,${accentColor} 100%);border-radius:10px;"><table cellpadding="0" cellspacing="0" style="width:100%;background:${containerBg};border-radius:8px;"><tr><td style="padding:24px 32px;text-align:center;"><table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td align="center" bgcolor="${primaryColor}" style="background:${primaryColor};border-radius:6px;"><a href="${ctaHref}" target="_blank" style="display:inline-block;background:${primaryColor};color:${primaryText};font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;text-decoration:none;padding:16px 40px;border-radius:6px;-webkit-text-size-adjust:none;mso-padding-alt:0;">${ctaText}</a></td></tr></table></td></tr></table></td></tr></table>`
        : '';
      bodyContent = `<p style="font-size:16px;color:${textColor};line-height:1.75;margin:0 0 20px;">${formattedBody}</p>${legacyCtaBlock}`;
    }
  }

  // ── PROMOTIONAL GRID OVERRIDE ────────────────────────────────────────────────
  // When the original email was detected as a promotional grid, replace bodyContent
  // with a 2-column card layout + deal badges row. All item names/deals come from
  // extractPromotionalItems() which pulls ONLY from the original text — never invented.
  if (options.layoutType === 'promotional-grid' && Array.isArray(options.promotionalItems) && options.promotionalItems.length >= 2) {
    const items = options.promotionalItems;

    // Unique deals → horizontal pill badges row
    const uniqueDeals = [...new Set(
      items.flatMap(i => [i.deal, i.extraDeal].filter(Boolean))
    )].slice(0, 6);
    const badgePills = uniqueDeals.map(deal =>
      `<span style="display:inline-block;background:${primaryColor};color:${primaryText};font-size:11px;font-weight:700;padding:5px 14px;border-radius:20px;margin:3px 4px;white-space:nowrap;">${deal}</span>`
    ).join('');

    // Build individual card cell — includes Unsplash photo when item.image is present
    const buildCard = item => `<td width="50%" valign="top" style="padding:8px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:${cardBg};border-radius:8px;overflow:hidden;border:1px solid ${dividerColor};">
          ${item.image ? `<tr><td style="padding:0;line-height:0;"><img src="${proxyUrl(item.image)}" width="100%" height="140" alt="${item.name}" style="display:block;width:100%;height:140px;object-fit:cover;border-radius:8px 8px 0 0;" onerror="this.style.display='none';this.parentElement.style.display='none';" /></td></tr>` : ''}
          <tr><td style="padding:14px 16px 16px;">
            <div style="margin-bottom:8px;">
              ${item.deal ? `<span style="display:inline-block;background:${primaryColor};color:${primaryText};font-size:10px;font-weight:700;padding:3px 10px;border-radius:12px;white-space:nowrap;">${item.deal}</span>` : ''}
              ${item.extraDeal ? `<span style="display:inline-block;background:${accentColor};color:${accentText};font-size:10px;font-weight:700;padding:3px 10px;border-radius:12px;margin-left:4px;white-space:nowrap;">${item.extraDeal}</span>` : ''}
            </div>
            <div style="font-size:13px;font-weight:700;color:${textColor};margin-bottom:12px;line-height:1.35;">${item.name}</div>
            <table cellpadding="0" cellspacing="0"><tr>
              <td bgcolor="${primaryColor}" style="background:${primaryColor};border-radius:4px;">
                <a href="${ctaHref}" target="_blank" style="display:inline-block;color:${primaryText};font-size:12px;font-weight:700;text-decoration:none;padding:7px 16px;">Order now</a>
              </td>
            </tr></table>
          </td></tr>
        </table>
      </td>`;

    // Pair items into rows of 2
    const gridRows = [];
    for (let i = 0; i < items.length; i += 2) {
      gridRows.push(`<tr>
        ${buildCard(items[i])}
        ${items[i + 1] ? buildCard(items[i + 1]) : '<td width="50%"></td>'}
      </tr>`);
    }

    // Wave SVG divider (colour matches footer background)
    const waveSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="36" viewBox="0 0 540 36" style="display:block;width:100%;max-width:540px;margin:24px auto 0;">
      <path d="M0,18 C100,36 200,0 310,18 C420,36 500,8 540,18 L540,36 L0,36 Z" fill="${footerBg}"/>
    </svg>`;

    // Hero paragraph: rawBody holds the Claude-written 1-2 sentence hero text (plain text)
    const heroHtml = rawBody && !isHtmlBody
      ? `<p style="font-size:16px;color:${textColor};line-height:1.75;margin:0 0 20px;">${rawBody}</p>`
      : '';

    bodyContent = `
      ${heroHtml}
      <!-- DEAL BADGES ROW -->
      <div style="text-align:center;padding:8px 0 16px;">${badgePills}</div>
      <!-- PRODUCT GRID -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
        ${gridRows.join('\n        ')}
      </table>
      <!-- SECONDARY CTA -->
      <table cellpadding="0" cellspacing="0" style="margin:8px auto 16px;">
        <tr><td align="center" style="border:2px solid ${primaryColor};border-radius:4px;">
          <a href="${ctaHref}" target="_blank" style="display:inline-block;color:${primaryColor};font-size:13px;font-weight:700;text-decoration:none;padding:10px 28px;">Explore more</a>
        </td></tr>
      </table>
      <!-- WAVE DIVIDER -->
      ${waveSvg}`;
  }
  // ── FIX 1: TEMPLATE ROUTER ────────────────────────────────────────────────
  // New-format generations use the v2 template; everything else falls back to legacy.

  // Tier label row removed — internal debug banner must never appear in delivered email HTML
  const tierLabelRow = '';

  if (isNewFormat) {
    // ── V2 TEMPLATE ─────────────────────────────────────────────────────────
    const finalCtaUrl = cleanCTAUrl(p_ctaUrl, ctaHref);
    // Calendar belongs only in the audit report and showcase — never in the newsletter HTML.
    const calendarSection = '';

    // Enforce body limits before inserting into HTML template
    // Safeguard: catch broken "Without [hook]" fragments where Claude echoed the headline
    const _sanitizeParagraph = t => {
      if (!t) return t;
      // Regex: "Without " followed immediately by a capital letter = sentence fragment from hook
      if (/^Without [A-Z]/.test(t)) {
        return t.replace(/^Without [^,]+,\s*/, 'Without the right solution, ');
      }
      return t;
    };
    const bodyParagraphs = enforceBodyLimits([p_insight, p_proof, p_cost]).map(_sanitizeParagraph);

    // Feature cards block: rendered for thought_leadership and product_update instead of prose paragraphs
    const featureCardsHtml = (() => {
      const _fc = Array.isArray(featureCards) ? featureCards.filter(c => c?.title || c?.body) : [];
      if (!_fc.length) return '';
      const _isTL = /thought.?leadership/i.test(htmlEmailType || '');
      const _isPU = /product.?update|product.?announcement|feature.?launch/i.test(htmlEmailType || '');
      const _isEA = /event.?announcement/i.test(htmlEmailType || '');
      if (!_isTL && !_isPU && !_isEA) return '';
      return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">` +
        _fc.slice(0, 6).map((card, idx) =>
          `<tr><td style="padding:${idx === 0 ? '0' : '16px'} 0 16px;${idx > 0 ? `border-top:1px solid ${dividerColor};padding-top:16px;` : ''}">
            <p style="font-size:11px;font-weight:800;color:${primaryColor};text-transform:uppercase;letter-spacing:1px;margin:0 0 6px;">${card.title || ''}</p>
            ${card.imageUrl ? `<img src="${proxyUrl(card.imageUrl)}" alt="${card.title || ''}" style="width:100%;max-height:200px;object-fit:cover;border-radius:8px;margin:0 0 8px;display:block;border:0;" onerror="this.style.display='none';this.parentElement.style.display='none';" />` : ''}
            <p style="font-size:14px;color:${textBody};margin:0;line-height:1.65;">${card.body || ''}</p>
          </td></tr>`
        ).join('') +
        `</table>`;
    })();

    const _v2Html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title>
<style>
@media only screen and (max-width:620px){
  .email-outer-td { padding: 16px 8px !important; }
  .email-section-pad { padding-left: 16px !important; padding-right: 16px !important; }
}
</style></head>
<body style="margin:0;padding:0;font-family:'Helvetica Neue',Arial,sans-serif;">
<!-- PREHEADER -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${p_preheader}&nbsp;&#x200C;&nbsp;&#x200C;&nbsp;&#x200C;&nbsp;&#x200C;&nbsp;&#x200C;</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${bgColor};min-width:100%;">
  <tr>
    <td align="center" class="email-outer-td" style="padding:40px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:${containerBg};border-radius:16px;overflow:hidden;border:1px solid ${borderMuted};">

        ${tierLabelRow}

        <!-- HEADER -->
        <tr>
          <td class="email-section-pad" style="padding:22px 32px 18px;background:${emailHeaderBg};border-bottom:3px solid ${primaryColor};">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                <td>
                  ${logoHtml}
                  ${(() => { const headerTagline = p_brandTagline && p_brandTagline.length > 10 ? p_brandTagline : `${company} · ${new Date().toLocaleDateString('en-US', {month:'long', year:'numeric'})}`; return `<div style="font-size:10px;color:${textMedium};margin-top:3px;font-family:monospace;letter-spacing:.04em;">${headerTagline}</div>`; })()}
                </td>
                <td align="right" style="vertical-align:top;">
                  <div style="font-size:10px;color:${mutedText};font-family:monospace;white-space:nowrap;">${today}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- HERO IMAGE -->
        <!-- Images sourced from original email. Some may not display if the sender restricts hotlinking. -->
        <tr><td style="padding:0;line-height:0;"><img src="${proxyUrl(heroSrc)}" alt="${company}" width="600" height="220" style="width:100%;max-width:600px;height:220px;object-fit:cover;display:block;border:0;" onerror="this.style.display='none';this.parentElement.style.display='none';" /></td></tr>

        <!-- HOOK + TENSION + STAT CARDS -->
        <tr>
          <td class="email-section-pad" style="padding:36px 32px 28px;border-bottom:1px solid ${borderMuted};">
            <h1 style="margin:0 0 16px;font-size:26px;font-weight:900;color:${textStrong};line-height:1.2;letter-spacing:-0.4px;">${p_hook}</h1>
            <p style="margin:0 0 28px;font-size:16px;color:${textMedium};line-height:1.75;">${p_tension}</p>
            ${statCardsHtml}
            ${_imgFeatureCardsHtml}
          </td>
        </tr>

        <!-- GRADIENT DIVIDER -->
        <tr><td style="padding:0;line-height:0;height:3px;background:linear-gradient(to right,${primaryColor},rgba(94,106,210,0.3),transparent);font-size:0;">&nbsp;</td></tr>

        <!-- INSIGHT + PROOF + COST (or feature cards for thought_leadership / product_update) -->
        <tr><td class="email-section-pad" style="padding:32px 32px 28px;">
          ${Array.isArray(featureCards) && featureCards.length > 0
            ? featureCards.map(card => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
  style="margin-bottom:16px;border:1px solid rgba(0,0,0,0.10);border-radius:10px;overflow:hidden;border-collapse:separate;">
  <tr><td style="padding:16px 20px;background:#f9f9f9;">
    <div style="font-size:10px;font-weight:700;color:${primaryColor};text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px;">${card.title || ''}</div>
    ${card.imageUrl ? `<img src="${proxyUrl(card.imageUrl)}" alt="${card.title || ''}" style="width:100%;max-height:200px;object-fit:cover;border-radius:8px;margin:0 0 8px;display:block;border:0;" onerror="this.style.display='none';this.parentElement.style.display='none';">` : ''}
    <div style="font-size:14px;color:#3a3a35;line-height:1.6;">${card.body || card.text || card.content || ''}</div>
  </td></tr>
</table>`).join('')
            : `
          <p style="margin:0 0 20px;font-size:15px;color:${textBody};line-height:1.8;">${bodyParagraphs[0] || ''}</p>
          <p style="margin:0 0 20px;font-size:15px;color:${textBody};line-height:1.8;">${bodyParagraphs[1] || ''}</p>
          <p style="margin:0 0 20px;font-size:15px;color:${textBody};line-height:1.8;">${bodyParagraphs[2] || ''}</p>
          `}
        </td></tr>

        ${conversionElementHtml ? `<tr><td class="email-section-pad" style="padding:0 32px 28px;">${conversionElementHtml}</td></tr>` : ''}

        <!-- CTA -->
        <tr>
          <td class="email-section-pad" style="padding:0 32px 36px;">
            <div style="padding:3px;background:${ctaGradient};border-radius:12px;">
              <div style="background:${containerBg};border-radius:10px;padding:28px 32px;text-align:center;">
                <a href="${(()=>{ const _u=finalCtaUrl||''; if(!_u.includes('resend-clicks.com'))return _u; try{const _p=_u.split(/\/CL\d+\//)[1];if(_p)return decodeURIComponent(_p.split('/')[0]);}catch(e){} return _u; })()}" style="display:inline-block;background:${primaryColor};color:#ffffff;font-size:14px;font-weight:800;text-decoration:none;padding:13px 32px;border-radius:8px;">${p_ctaText}</a>
              </div>
            </div>
          </td>
        </tr>

        ${calendarSection}

        <!-- FOOTER -->
        <tr>
          <td style="padding:28px 40px 32px;border-top:1px solid ${borderStrong};background:${footerOverlay};text-align:center;">
            <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:${footerTxtMuted};">${company}</p>
            <p style="margin:8px 0;font-size:12px;color:${footerTxtMuted};line-height:1.7;">You're receiving this because you subscribed to ${company} product updates.</p>
            <p style="margin:8px 0 0;font-size:11px;color:${footerTxtDim};"><a href="#" style="color:${footerTxtMuted};text-decoration:none;">Unsubscribe</a></p>
          </td>
        </tr>


      </table>
    </td>
  </tr>
</table>
</body></html>`;
    return finalizeEmailHtml(_v2Html);
  }

  // ── LEGACY TEMPLATE (v1 XML sections, promotional grid, plain text) ────────
  const _legacyHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:${bgColor};font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${bgColor};padding:40px 20px;">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="background:${containerBg};border-radius:8px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.55);">
  ${tierLabelRow}
  <tr><td style="background:${headerBg};padding:18px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="vertical-align:middle;">${logoHtml}</td>
      <td align="right" style="vertical-align:middle;white-space:nowrap;">
        <span style="font-family:monospace;font-size:10px;font-weight:600;color:${headerText};opacity:0.75;text-transform:uppercase;letter-spacing:1.5px;">${today}</span>
      </td>
    </tr></table>
  </td></tr>
  <!-- Images sourced from original email. Some may not display if the sender restricts hotlinking. -->
  <tr><td align="center" valign="top" style="padding:0;margin:0;font-size:0;line-height:0;">
    <img src="${proxyUrl(heroSrc)}" width="620" height="300" border="0" alt="${company}" style="display:block;width:620px;height:300px;max-width:620px;min-width:620px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" onerror="this.style.display='none';this.parentElement.style.display='none';" />
  </td></tr>
  <tr><td style="background:${headerBg};padding:28px 40px 24px;">
    <p style="font-size:10px;font-weight:600;color:${headerText};opacity:0.6;text-transform:uppercase;letter-spacing:2px;margin:0 0 10px 0;">${company} &middot; ${today}</p>
    <h1 style="font-size:27px;font-weight:900;color:${headerText};margin:0;line-height:1.28;letter-spacing:-0.5px;">${subject}</h1>
  </td></tr>
  <tr><td style="height:4px;background:linear-gradient(135deg,${primaryColor} 0%,${accentColor} 100%);font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="background:${containerBg};padding:40px;">${bodyContent}</td></tr>
  <tr><td style="background:${footerBg};padding:28px 40px;text-align:center;border-top:1px solid ${footerBorder};">
    ${footerLogo}
    <p style="font-size:13px;font-weight:700;color:${footerText};margin:0 0 4px;">${company}</p>
    ${taglineText}
    ${['lite','growth','high_impact'].includes(tier)
      ? `<p style="font-size:11px;color:${footerMuted};margin:8px 0 0;"><a href="#" style="color:${footerMuted};text-decoration:underline;">Unsubscribe</a> &nbsp;·&nbsp; <a href="#" style="color:${footerMuted};text-decoration:underline;">Manage preferences</a></p>`
      : `<p style="font-size:11px;color:${footerText};margin:8px 0 4px;">Rebuilt by <a href="https://strategic-flow-audit.replit.app" style="color:${accentColor};text-decoration:none;">Strategic Flow</a></p><p style="font-size:11px;color:${footerMuted};margin:0;"><a href="#" style="color:${footerMuted};text-decoration:underline;">Unsubscribe</a></p>`}
  </td></tr>
</table></td></tr></table></body></html>`;
  return finalizeEmailHtml(_legacyHtml);
}

async function notify(subject, html) {
  try { await resend.emails.send({ from: SENDER, to: OWNER_EMAIL, subject, html }); }
  catch (e) { console.error('[email]', e.message); }
}

// Hard limit: max 3 paragraphs, max 3 sentences each — applied before body paragraphs enter the template.
function shortenLongSentence(sentence) {
  const words = sentence.trim().split(/\s+/);
  if (words.length <= 30) return sentence.trim();
  const cutoff = words.slice(0, 30).join(' ');
  const lastBreak = Math.max(cutoff.lastIndexOf(','), cutoff.lastIndexOf('—'), cutoff.lastIndexOf(' and '));
  if (lastBreak > 20) return cutoff.substring(0, lastBreak).trim() + '.';
  return words.slice(0, 25).join(' ').trim() + '.';
}

function ensureCompleteSentence(text) {
  if (!text) return text;
  const trimmed = text.trim();
  if (/[.!?]$/.test(trimmed)) return trimmed;
  const lastEnd = Math.max(
    trimmed.lastIndexOf('. '),
    trimmed.lastIndexOf('? '),
    trimmed.lastIndexOf('! ')
  );
  if (lastEnd > 0 && trimmed.length - lastEnd > 20) {
    return trimmed.substring(0, lastEnd + 1).trim();
  }
  return trimmed.replace(/[,;:\s]+$/, '') + '.';
}

function enforceBodyLimits(paragraphs) {
  if (!Array.isArray(paragraphs)) {
    paragraphs = String(paragraphs).split(/\n\n+/).filter(p => p.trim().length > 0);
  }
  const FABRICATION_PHRASES = [
    /teams (already )?using .{0,30} report/i,
    /users (already )?using .{0,30} report/i,
    /early (adopters|users) report/i,
    /teams report (fewer|less|more|faster)/i,
  ];
  return paragraphs.slice(0, 3).map(p => {
    const sentences = p.match(/[^.!?]+[.!?]+(\s|$)/g) || [p];
    const joined = sentences.slice(0, 3).map(s => {
      if (FABRICATION_PHRASES.some(fp => fp.test(s))) return '';
      return shortenLongSentence(s);
    }).filter(s => s.length > 10).join(' ').trim();
    return ensureCompleteSentence(joined);
  });
}

// Truncate a plain-text string to maxWords words, ending cleanly at a sentence boundary if possible.
function truncateLead(text, maxWords) {
  if (!text) return text;
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ').replace(/[,;]$/, '') + '.';
}

// Convert any stray markdown that Claude may have left in rebuilt_body to valid HTML
function stripMarkdown(text) {
  if (!text) return text;
  return text
    .replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/gs, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

// Send the rebuilt newsletter to the user's email as an HTML attachment
async function sendResultEmail(to, company, origSubject, rebuiltSubject, keyChanges, convHook, downloadHtml, labels = UI_LABELS.en) {
  const APP_URL = 'https://strategic-flow-audit.replit.app';
  const changesHtml = (keyChanges || []).map(c => `<li style="margin-bottom:6px;">${c}</li>`).join('');
  const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222;">
  <div style="background:#0a1628;padding:24px 32px;border-radius:8px 8px 0 0;">
    <p style="color:#00d4c8;font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin:0 0 6px;">Strategic Flow</p>
    <h2 style="color:#ffffff;margin:0;font-size:22px;">Your rebuilt newsletter is ready</h2>
  </div>
  <div style="background:#f9f9f9;padding:28px 32px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
    <p style="color:#444;line-height:1.7;">Here's what we rebuilt for <strong>${company || 'your company'}</strong>:</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      <tr><td style="padding:8px 12px;background:#fff;border:1px solid #e0e0e0;font-size:12px;color:#888;width:110px;">${labels.original}</td><td style="padding:8px 12px;background:#fff;border:1px solid #e0e0e0;font-size:14px;color:#222;">${origSubject}</td></tr>
      <tr><td style="padding:8px 12px;background:#e8fffe;border:1px solid #b2f0ee;font-size:12px;color:#00a09a;width:110px;">${labels.rebuilt}</td><td style="padding:8px 12px;background:#e8fffe;border:1px solid #b2f0ee;font-size:14px;font-weight:700;color:#007a75;">${rebuiltSubject}</td></tr>
    </table>
    ${changesHtml ? `<p style="color:#444;font-weight:600;margin-bottom:8px;">${labels.whatChanged}:</p><ul style="color:#444;line-height:1.8;margin:0 0 20px;padding-left:20px;">${changesHtml}</ul>` : ''}
    ${convHook ? `<p style="background:#fffbe6;border-left:3px solid #f0c040;padding:10px 14px;font-size:13px;color:#555;font-style:italic;margin:0 0 20px;">${convHook}</p>` : ''}
    <p style="color:#444;line-height:1.7;">The full rebuilt newsletter HTML is attached — paste it directly into your email platform (Mailchimp, ConvertKit, ActiveCampaign, etc.).</p>
    <table cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
      <tr><td align="center" bgcolor="#00d4c8" style="background:#00d4c8;border-radius:4px;">
        <a href="${APP_URL}" style="display:inline-block;color:#0a1628;font-weight:700;text-decoration:none;padding:12px 28px;font-size:14px;">Rebuild another newsletter →</a>
      </td></tr>
    </table>
    <p style="font-size:11px;color:#aaa;margin-top:28px;border-top:1px solid #e0e0e0;padding-top:16px;">Strategic Flow · <a href="${APP_URL}" style="color:#00d4c8;">strategic-flow-audit.replit.app</a></p>
  </div>
</div>`;
  try {
    await resend.emails.send({
      from: SENDER,
      to,
      subject: 'Your rebuilt newsletter is ready — Strategic Flow',
      html,
      attachments: [{
        filename: `${(company || 'newsletter').replace(/[^a-z0-9]/gi, '-').toLowerCase()}-rebuilt.html`,
        content: Buffer.from(downloadHtml).toString('base64')
      }],
      clickTracking: false,
      headers: {
        'X-Entity-Ref-ID': 'no-tracking',
        'X-PM-Message-Stream': 'outbound'
      }
    });
    console.log(`[email] Result delivered to ${to}`);
  } catch (e) {
    console.error('[email] Failed to deliver result to user:', e.message);
  }
}

// ─── CONTENT-BASED BRAND INFERENCE ──────────────────────────────────────────
// Used when no website URL is provided and the caller passes no brandDNA.
// Detects dark-theme emails from plain-text body keyword patterns.
// Must run BEFORE inferBrandFromContent so Claude's default light bgColor cannot override it.
function detectDarkFromEmailBody(body) {
  if (!body) return false;
  const darkKeywords = [
    'background-color: #1', 'background-color: #0',
    'background: #1', 'background: #0',
    'bgcolor="#1', 'bgcolor="#0',
    'background-color: black', 'background: black',
    '#1a1a1a', '#0a0a0a', '#111111', '#222222',
    '#1e1e1e', '#0d0d0d', '#131313', '#191919',
    '#2c2c2c', '#1c1c1c'
  ];
  const bodyLower = body.toLowerCase();
  return darkKeywords.some(k => bodyLower.includes(k.toLowerCase()));
}

// Two strategies run in parallel:
//   1. Guess the company homepage (slug.com) and run a full brand extraction.
//   2. Ask Claude to synthesize a palette from the email subject + body.
// URL-extracted colours win when ≥ 2 are found; Claude voice data always merges in.

async function inferBrandFromContent(company, subject, body, pageUrl) {
  const slug = (company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let candidateUrl = null;
  if (pageUrl) {
    try { candidateUrl = new URL(pageUrl).origin; } catch (_) {}
  }
  if (!candidateUrl && slug) candidateUrl = `https://www.${slug}.com`;

  const contentPrompt = `You are a brand analyst. Based on the email below, infer the brand's visual identity and communication style.

Return ONLY valid JSON with these exact keys:
- "primaryColor": the most distinctive brand hex colour (e.g. "#5E6AD2"). Choose based on industry and tone:
    fintech/payments → deep purple or navy (#4B3FD8, #1A2B6B)
    health/wellness → teal-green or sage (#27AE60, #2D9E8F)
    e-commerce/DTC → bold orange or red (#E64A19, #D32F2F)
    enterprise B2B → slate-navy (#2C3E50, #37474F)
    consumer SaaS → vibrant purple or indigo (#7C3AED, #4F46E5)
    creative/marketing tools → warm magenta or coral (#E91E63, #FF6F61)
    HR/recruitment → warm amber (#F59E0B, #D97706)
    dev tools/infra → deep teal or dark blue (#0F766E, #1D4ED8)
- "accentColor": a complementary, typically brighter accent hex colour.
- "bgColor": a fitting email wrapper background — very light tint of the primary or a warm off-white; never pure white or pure black.
- "voiceProfile": 2–3 sentences on tone, rhythm, and audience communication style evident in this email.
- "industry": one short label (e.g. "B2B SaaS – payments", "DTC e-commerce", "health & wellness").
- "audience": one short description (e.g. "startup founders", "enterprise IT teams", "direct-to-consumer shoppers").

STRICT RULES:
- Never return generic teal (#00d4c8), generic blue (#3498db), or plain grey (#808080, #999). Colours must feel specific to this brand's personality and sector.
- Return ONLY valid JSON. Use only standard ASCII characters. No curly quotes, no em dashes, no ellipsis, no special unicode. Use straight quotes and hyphens only.

Company: ${company || 'Unknown'}
Subject: ${subject}
Email body:
${(body || '').slice(0, 1400)}`;

  const [urlResult, claudeResult] = await Promise.allSettled([
    candidateUrl
      ? extractBrandDNA(candidateUrl).catch(() => null)
      : Promise.resolve(null),
    claudeJSON(contentPrompt, 500).catch(() => null)
  ]);

  // Build a Claude-inferred brandDNA object from the content analysis
  let inferred = null;
  if (claudeResult.status === 'fulfilled' && claudeResult.value) {
    const c = claudeResult.value;
    const hex6 = v => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;
    const primary = hex6(c.primaryColor);
    const accent  = hex6(c.accentColor);
    const bg      = hex6(c.bgColor);
    if (primary) {
      // Derive theme from bgColor: if it's a dark hex (luminance < 68) mark as dark
      let inferredTheme = 'light';
      if (bg) {
        try {
          const r = parseInt(bg.slice(1,3), 16), g = parseInt(bg.slice(3,5), 16), b2 = parseInt(bg.slice(5,7), 16);
          if ((r * 299 + g * 587 + b2 * 114) / 1000 < 68) inferredTheme = 'dark';
        } catch (_) {}
      }
      inferred = {
        success: true, source: 'content-inferred',
        theme: inferredTheme,
        colors: [
          { type: 'inferred:primary', value: primary },
          ...(accent ? [{ type: 'inferred:accent', value: accent }] : []),
          ...(bg     ? [{ type: 'inferred:bg',     value: bg     }] : [])
        ],
        voiceProfile: c.voiceProfile || null,
        industry:     c.industry     || null,
        audience:     c.audience     || null,
        logo: null
      };
    }
  }

  // Prefer URL-extracted DNA when it found meaningful colours
  const urlDNA = urlResult.status === 'fulfilled' ? urlResult.value : null;
  if (urlDNA?.success && urlDNA.colors?.length >= 2) {
    return {
      ...urlDNA,
      source: 'auto-url',
      // Enrich with Claude's richer voice/industry analysis
      voiceProfile: inferred?.voiceProfile || urlDNA.voiceProfile || null,
      industry:     inferred?.industry     || urlDNA.industry     || null,
      audience:     inferred?.audience     || urlDNA.audience     || null
    };
  }

  return inferred; // may be null if both strategies failed
}

// ─── ROUTES ─────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ ok: true, model: MODEL, ts: new Date().toISOString() }));

app.get('/proxy-image', async (req, res) => {
  try {
    const url = decodeURIComponent(req.query.url || '');
    if (!url.startsWith('http')) return res.status(400).end();
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!response.ok) return res.status(404).end();
    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'image/png';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(buffer));
  } catch (e) {
    res.status(500).end();
  }
});

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

    let user = await getUser(email);

    // Auto-enrol new visitors on a free trial so they can rebuild immediately.
    if (!user || user.tier === 'free') {
      await pool.query(`
        INSERT INTO users (email, tier) VALUES ($1, 'free_trial')
        ON CONFLICT (email) DO UPDATE SET tier = 'free_trial', last_used_at = NOW()
        WHERE users.tier = 'free'
      `, [email]);
      user = await getUser(email);
    }

    // Free trial: one rebuild allowed, then redirect to pricing.
    if (user.tier === 'free_trial') {
      if (user.newsletter_count >= 1) {
        return res.json({ status: 'trial_used' });
      }
      return res.json({ status: 'free_trial', tier: 'free_trial', used: user.newsletter_count, limit: 1, tierName: 'Free Trial' });
    }

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

function extractTables(html) {
  const tables = [];
  const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  tableMatches.forEach(tableHtml => {
    const lower = tableHtml.toLowerCase();
    if (lower.includes('nav') || lower.includes('footer')) return;
    if (lower.includes('menu') || lower.includes('social')) return;
    const rows = (tableHtml.match(/<tr/gi) || []).length;
    const cells = (tableHtml.match(/<td|<th/gi) || []).length;
    if (rows >= 2 && cells >= 4) {
      const plainText = tableHtml
        .replace(/<th[^>]*>/gi, '| ')
        .replace(/<td[^>]*>/gi, '| ')
        .replace(/<\/th>|<\/td>/gi, ' ')
        .replace(/<tr[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
      if (plainText.length > 20) tables.push(plainText);
    }
  });
  return tables;
}

async function fetchPageContent(rawUrl) {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const fetch = (await import('node-fetch')).default;

  const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Cache-Control': 'no-cache',
  };

  // Extract structured content from raw HTML — shared across all strategies
  function parseHtml(html) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g,' ').trim() : '';

    const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i)
      || html.match(/<meta[^>]*content=["']([^"']{20,})[^>]*name=["']description["']/i);
    const meta = metaMatch ? metaMatch[1].trim() : '';

    // Extract the article's own cover image. Priority order:
    //   1. og:image (standard Open Graph)
    //   2. twitter:image (Twitter card — common fallback)
    //   3. First large <img> inside <article> or <main>
    const ogImage = (() => {
      const og = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1]
        || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i)?.[1];
      if (og && og.startsWith('http')) return og;
      const tw = html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i)?.[1]
        || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i)?.[1];
      if (tw && tw.startsWith('http')) return tw;
      const articleBlock = html.match(/<(?:article|main)[^>]*>([\s\S]{0,8000}?)<\/(?:article|main)>/i)?.[1] || '';
      const imgSrc = articleBlock.match(/src=["'](https:\/\/[^"']+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"']*)?)/i)?.[1];
      if (imgSrc) return imgSrc;
      return null;
    })();

    const stripped = sanitizeForJSON(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<(nav|header|footer|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
        .replace(/\s+/g,' ').trim()
    ).slice(0, 3500);

    const tables = extractTables(html);
    return { title, meta, text: stripped, ogImage, tables };
  }

  // Strategy 1: Direct fetch with realistic browser headers
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(12000), headers: BROWSER_HEADERS });
    if (resp.ok) {
      const html = await resp.text();
      const parsed = parseHtml(html);
      if (parsed.text.length >= 100) return { ...parsed, url, rawHtml: html };
    }
  } catch (e) { console.log('[fetch] strategy 1 failed:', e.message); }

  // Strategy 2: Google Cache
  try {
    const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
    const resp = await fetch(cacheUrl, { signal: AbortSignal.timeout(8000), headers: BROWSER_HEADERS });
    if (resp.ok) {
      const html = await resp.text();
      const parsed = parseHtml(html);
      if (parsed.text.length >= 100) return { ...parsed, url, rawHtml: html };
    }
  } catch (e) { console.log('[fetch] strategy 2 (Google Cache) failed:', e.message); }

  // Strategy 3: HTTP fallback (some servers reject HTTPS-only requests)
  try {
    const httpUrl = url.replace(/^https:\/\//i, 'http://');
    if (httpUrl !== url) {
      const resp = await fetch(httpUrl, { signal: AbortSignal.timeout(8000), headers: BROWSER_HEADERS });
      if (resp.ok) {
        const html = await resp.text();
        const parsed = parseHtml(html);
        if (parsed.text.length >= 100) return { ...parsed, url, rawHtml: html };
      }
    }
  } catch (e) { console.log('[fetch] strategy 3 (HTTP) failed:', e.message); }

  console.log('[fetch] all strategies exhausted for:', url);
  return null;
}

// ── FOOTER-ONLY DETECTION (server-side guard) ──
function isFooterOnlyContent(text) {
  if (!text) return false;
  const signals = [
    /unsubscribe/gi, /opt.?out/gi, /548 market/gi,
    /this email was sent to/gi, /youtube icon/gi, /x icon/gi,
    /PBC,?\s*\d+/gi, /san francisco/gi, /privacy policy/gi,
    /all rights reserved/gi, /\bPO Box\b/gi,
    /you('re| are) receiving this/gi, /manage (your )?preferences/gi
  ];
  const len  = text.trim().length;
  const hits = signals.filter(p => { p.lastIndex = 0; return p.test(text); }).length;
  return len < 500 && hits >= 2;
}

// ── PARSE HTML UPLOAD ──
// Accepts raw HTML from an uploaded email file and extracts brand DNA signals.
// Returns colors, logo, dark/light theme, emoji presence, CTA URL, text content.
app.post('/parse-html', async (req, res) => {
  try {
    const { htmlContent } = req.body;
    if (!htmlContent || typeof htmlContent !== 'string' || htmlContent.length < 20)
      return res.status(400).json({ error: 'htmlContent is required' });
    res.json(parseEmailHtmlContent(htmlContent));
  } catch (e) {
    console.error('[parse-html]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GENERATE (main) ──
async function handleGenerate(req, res) {
  try {
    let { email, company, name, goal, subject, body, emailType, roadmapNotes, brandDNA, voiceProfile, pageUrl } = req.body;
    const e = (email || '').toLowerCase().trim();
    if (!e || !subject) return res.status(400).json({ error: 'email and subject are required' });

    // Sanitize all human-supplied text inputs BEFORE any Claude prompt is built.
    // This converts special Unicode (curly quotes, em dashes, etc.) into plain ASCII
    // equivalents so they never corrupt Claude's JSON response.
    subject      = sanitizeInput(subject);
    body         = sanitizeInput(body, 12000);
    const _pastedBody = body; // snapshot before URL-fetch may overwrite body
    company      = sanitizeInput(company);
    goal         = sanitizeInput(goal);
    roadmapNotes = sanitizeInput(roadmapNotes);

    // Server-side footer-only guard (mirrors client-side check — catches API/bypass cases)
    if (isFooterOnlyContent(body)) {
      console.log(`[generate] footer-only body rejected for ${e}`);
      return res.json({
        success: false,
        error: 'footer_only',
        message: 'It looks like you copied only the email footer. Please copy the main email content — the subject, body text, and key sections — not the unsubscribe footer at the bottom.'
      });
    }

    console.log('STEP 1: Input validated');
    let analyzedPage = false;

    // Use pasted body if substantial; otherwise fetch the URL
    let _pageRawHtml = '';
    let effectiveBody = (body || '').trim();
    if (effectiveBody.length < 100 && pageUrl) {
      console.log('[generate] body too short, fetching URL:', pageUrl);
      try {
        const page = await fetchWithCache(pageUrl);
        if (page) {
          const fetched = [
            page.title ? `Headline: ${page.title}` : '',
            page.meta  ? `Summary: ${page.meta}` : '',
            page.text,
            page.tables && page.tables.length > 0
              ? '\n\nDATA TABLES FROM ORIGINAL ARTICLE:\n' + page.tables.join('\n\n')
              : ''
          ].filter(Boolean).join('\n\n');
          if (fetched && fetched.length > 100) {
            effectiveBody = fetched;
            analyzedPage = true;
            if (page.ogImage) req.body._ogImage = page.ogImage;
            _pageRawHtml = page.rawHtml || '';
            console.log('[generate] URL content fetched, length:', effectiveBody.length);
          }
        }
      } catch (fetchErr) {
        console.error('[generate] URL fetch failed:', fetchErr.message);
      }

      // All fetch strategies failed — return error immediately, do not call Claude
      if (effectiveBody.length < 100) {
        console.log('[generate] all fetch strategies exhausted for:', pageUrl);
        return res.status(422).json({
          error: 'Could not fetch URL content. The site may be blocking automated requests.'
        });
      }
    }

    // Fix 1: If a pageUrl was provided but og:image wasn't captured yet (body was long
    // enough that the full URL fetch was skipped), do a lightweight fetch now so we
    // can use the real hero image instead of a generic Unsplash fallback.
    if (pageUrl && !req.body._ogImage) {
      try {
        const _ogPage = await fetchWithCache(pageUrl);
        if (_ogPage?.ogImage) {
          req.body._ogImage = _ogPage.ogImage;
          if (!_pageRawHtml && _ogPage.rawHtml) _pageRawHtml = _ogPage.rawHtml;
          console.log('[og:image] late-fetched from pageUrl:', req.body._ogImage);
        }
      } catch (_) {}
    }

    if (effectiveBody.length < 100) {
      return res.status(400).json({
        error: 'content_too_short',
        message: 'URL could not be fetched automatically. Paste the email body in the text field.',
        hint: 'URL could not be fetched automatically. Paste the email body in the text field.'
      });
    }

    body = effectiveBody;

    const adminAccess = isAdmin(e);
    const ALLOWED_TIERS = new Set(['free_trial','single','lite','growth','high_impact']);

    // Auto-enrol new visitors as free_trial; existing users keep their current tier.
    if (!adminAccess) {
      await pool.query(
        `INSERT INTO users (email, tier) VALUES ($1, 'free_trial') ON CONFLICT (email) DO NOTHING`,
        [e]
      ).catch(() => {});
    }

    let user = await getUser(e);

    // Owner panel can request a specific tier to test different prompt depths
    const ownerTierOverride = adminAccess && req.body.ownerTier && ALLOWED_TIERS.has(req.body.ownerTier) ? req.body.ownerTier : null;
    const tier = adminAccess ? (ownerTierOverride || 'high_impact') : (user?.tier && ALLOWED_TIERS.has(user.tier) ? user.tier : null);
    if (!tier) return res.status(403).json({ error: 'no_tier' });
    // free_trial generates at high_impact quality — best output on the one free use
    const promptTier = tier === 'free_trial' ? 'high_impact' : tier;

    if (!adminAccess) {
      const lim = checkLimit(user);
      if (!lim.allowed) {
        // Free-trial users who already used their rebuild: return cached last result
        // instead of a hard block, so they see value and are prompted to upgrade.
        let shouldBlock = true;
        if (lim.reason === 'trial_used') {
          const cached = await pool.query(
            'SELECT * FROM newsletters WHERE email = $1 ORDER BY created_at DESC LIMIT 1',
            [e]
          );
          if (cached.rows.length > 0) {
            const n = cached.rows[0];
            // Guard: if audit fields are null (pre-fix rows), treat as cache miss and regenerate
            if (!n.ab_subjects || !n.audience_segments || !n.content_calendar) {
              console.log('[cache] audit fields null — falling through to full regeneration');
              shouldBlock = false;
            } else {
              const cachedDNA = n.brand_dna || null;
              const { primaryColor: paRaw, primaryText: pat, accentColor: pacRaw } = getEmailColors(cachedDNA);
              let pa = paRaw, pac = pacRaw;
              try { const _p = hexToHSL(pa);  if (_p.l < 42) pa  = hslToHex(_p.h, Math.max(_p.s, 55), 55); } catch (_) {}
              try { const _a = hexToHSL(pac); if (_a.l < 42) pac = hslToHex(_a.h, Math.max(_a.s, 55), 58); } catch (_) {}
              const previewBody = adaptBodyForDarkTheme((n.rebuilt_body || '')
                .replace(/CTABGCOLOR/g, pa)
                .replace(/CTATEXTCOLOR/g, pat)
                .replace(/CTAACCENTCOLOR/g, pac));
              const cachedOgImage = req.body._ogImage || n.og_image || null;
              console.log('[cache] ogImage:', cachedOgImage);
              const _cachedLang   = detectLanguage((n.original_subject || '') + ' ' + (n.original_body || '').slice(0, 500));
              const _cachedLabels = UI_LABELS[_cachedLang] || UI_LABELS.en;
              const downloadHtml = stripResendTracking(buildNewsletterHTML(
                n.company || 'Your Company', n.rebuilt_subject, n.rebuilt_body, cachedDNA,
                { tier: n.tier || 'free_trial', originalBody: n.original_body || '',
                  ctaHref: cachedDNA?.url || 'https://strategic-flow-audit.replit.app',
                  heroImageUrl: cachedOgImage,
                  labelBefore: _cachedLabels.before, labelAfter: _cachedLabels.after }
              ));
              return res.json({
                rebuilt_subject:  n.rebuilt_subject,
                rebuilt_body:     n.rebuilt_body,
                previewBody,
                downloadHtml,
                tier:             n.tier || 'free_trial',
                emailType:        n.email_type || null,
                key_changes:      n.key_changes || [],
                conversion_hook:  n.conversion_hook || '',
                og_image:         n.og_image || null,
                ab_subjects:      n.ab_subjects      || [],
                segments:         n.audience_segments || [],
                follow_ups:       n.content_calendar  || [],
                cohesion:         n.cohesion_check    || null,
                cached:           true
              });
            }
          }
        }
        if (shouldBlock) {
          return res.status(403).json({ error: 'limit_reached', reason: lim.reason, used: lim.used, limit: lim.limit });
        }
      }
    }

    let effectiveBrandDNA  = brandDNA  || null;
    let effectiveVoice     = voiceProfile || null;
    const forceDark        = detectDarkFromEmailBody(body);
    const detectedType     = emailType || null;

    console.log('STEP 2: Brand setup');

    // ── PROMOTIONAL GRID BYPASS ─────────────────────────────────────────────────
    // When the original body has 4+ CTAs and deal badges, build HTML directly
    // from extracted data. Claude is used ONLY for subject + hero paragraph.
    // This guarantees zero invented facts in the output.
    const isPromoGrid = detectPromotionalGrid(body || '');
    const promotionalItems = isPromoGrid ? extractPromotionalItems(body || '') : [];
    let promoGridResult = null;

    if (isPromoGrid && promotionalItems.length >= 2) {
      console.log(`[promo-grid] ${promotionalItems.length} items — bypassing full Claude rebuild`);
      const deals = [...new Set(
        promotionalItems.flatMap(i => [i.deal, i.extraDeal].filter(Boolean))
      )];
      const heroFallback = extractHeroText(body || '') || `Exclusive deals from ${company || 'your favourite restaurants'}`;

      let rebuiltSubject = subject;
      let heroParagraph  = heroFallback;
      try {
        const pg = await claudeJSON(
          getPromoGridSubjectHeroPrompt({ company, subject, body, deals }), 300
        );
        if (pg?.rebuilt_subject) rebuiltSubject = pg.rebuilt_subject;
        if (pg?.hero_paragraph)  heroParagraph  = pg.hero_paragraph;
      } catch (pgErr) {
        console.error('[promo-grid] subject/hero call failed:', pgErr.message);
      }

      promoGridResult = {
        rebuilt_subject: rebuiltSubject,
        rebuilt_body:    heroParagraph,       // plain text — shown as hero paragraph
        heroKeyword:     'food delivery',
        contentStyle:    'promotional-grid',
        emailType:       'Promotional',
        key_changes: [
          `→ ${promotionalItems.length} restaurant/product cards built directly from original — zero invented facts`,
          '→ Subject rewritten for outcome focus without altering the actual offers',
          '→ Grid layout with verified deal badges replaces generic template'
        ],
        removed_elements: [],
        conversion_hook:  heroParagraph
      };
    }
    // ── END PROMO GRID BYPASS ─────────────────────────────────────────────────

    // Extract visual assets before the Claude call so they can be injected into the prompt
    // for product_update emails. Also used later for hero image + showcase.
    const { images: _pageImgs, gifs: _pageGifs, tables: _tbls } = (() => {
      try { return extractVisualAssets(_pageRawHtml, pageUrl || ''); }
      catch (_) { return { images: [], gifs: [], tables: [] }; }
    })();
    const { images: _bodyImgs, gifs: _bodyGifs } = (() => {
      try { return extractVisualAssets(body || '', pageUrl || ''); }
      catch (_) { return { images: [], gifs: [] }; }
    })();
    // Merge: page assets first, then body assets not already present (dedup by URL)
    const _isProductImg = u => {
      if (!u) return false;
      const l = u.toLowerCase();
      const skipPatterns = [
        'width=40','height=40','width=96','height=96','width=32','height=32',
        'rmode=crop','1646653490249','630c6d4e',
        'gravatar','avatar','author','profile','headshot',
        'logo','typelogo','symbol','favicon','keyboard-shortcuts',
        'promoengine','300x300','200x200','150x150','128x128',
        // social footer icons and logo variants
        'sf-footer-','-logo-home.','xlogo.',
        // generic icon/UI patterns
        'sprite','badge','pixel','blank','1x1','tracking','button','arrow'
      ];
      if (skipPatterns.some(p => l.includes(p))) return false;
      if (l.endsWith('.svg')) return false;
      const wm = u.match(/[?&]width=(\d+)/i);
      if (wm && parseInt(wm[1]) < 100) return false;
      return true;
    };
    const _imgs = (() => {
      const merged = [..._pageImgs, ..._bodyImgs.filter(bi => !_pageImgs.some(pi => pi.url === bi.url))];
      // Deduplicate: same base URL (strip query params) → keep entry with largest width param
      const baseMap = new Map();
      for (const img of merged) {
        const base = (img.url || '').split('?')[0];
        const existing = baseMap.get(base);
        if (!existing) {
          baseMap.set(base, img);
        } else {
          const existW = parseInt((existing.url.match(/width=(\d+)/i) || [])[1] || '0');
          const newW   = parseInt((img.url.match(/width=(\d+)/i) || [])[1] || '0');
          if (newW > existW) baseMap.set(base, img);
        }
      }
      // Apply _isProductImg filter, then reject thumbnails (NNNxNNN pattern) except hero (index 0), cap at 4
      const thumbRe = /-\d{2,4}x\d{2,4}\./i;
      const filtered = Array.from(baseMap.values()).filter(img => _isProductImg(img.url));
      return filtered.filter((img, idx) => idx === 0 || !thumbRe.test(img.url)).slice(0, 4);
    })();
    const _gifs = [..._pageGifs, ..._bodyGifs.filter(bg => !_pageGifs.some(pg => pg.url === bg.url))];

    // Attach headingContext to each image: nearest preceding <h1>–<h4> in raw page HTML.
    // Used by matchImageToCard() to allocate images to feature cards by topic overlap.
    const _imgsCtx = (() => {
      if (!_pageRawHtml || !_imgs.length) return _imgs.map(img => ({ ...img, headingContext: img.alt || '' }));
      const headings = [];
      const _hRe = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
      let _hm;
      while ((_hm = _hRe.exec(_pageRawHtml)) !== null) {
        headings.push({ pos: _hm.index, text: _hm[1].replace(/<[^>]+>/g, '').trim() });
      }
      return _imgs.map(img => {
        const imgPos = _pageRawHtml.indexOf(img.url);
        if (imgPos === -1) return { ...img, headingContext: img.alt || '' };
        const prev = headings.filter(h => h.pos < imgPos);
        const nearest = prev[prev.length - 1];
        return { ...img, headingContext: nearest?.text || img.alt || '' };
      });
    })();

    // ── PROMPT DISPATCH: single Claude rebuild call ──────────────────────────────
    let result;
    if (promoGridResult) {
      result = promoGridResult;
    } else {
      const priorExamples = await getIndustryExamples(effectiveBrandDNA?.industry || null);
      let prompt = getAuditPrompt({ tier: promptTier, company: company || 'Your Company', goal, subject, body, brandDNA: effectiveBrandDNA, voiceProfile: effectiveVoice, emailType: detectedType, roadmapNotes, priorExamples, analysis: { weaknesses: [], directives: [] } });
      // For product_update/announcement emails, inject feature card instructions + image list
      const _isProductEmailType = /product.?update|product.?announcement|feature.?launch/i.test(detectedType || '');
      if (_isProductEmailType) {
        const _pImgList = _imgs.filter(img => _isProductImg(img.url)).map(i => i.url).slice(0, 6).join('\n');
        prompt += `\n\nPRODUCT UPDATE INSTRUCTION — MANDATORY: Return a "featureCards" array in your JSON:\n"featureCards":[{"title":"FEATURE NAME — max 4 words","body":"one outcome sentence for this feature","imageUrl":"pick one URL from the list below or null"}]\nAvailable product image URLs:\n${_pImgList || 'none'}\nFor product_update type, featureCards replaces the body[] paragraphs — do not also return a body array.`;
      }
      // For thought_leadership emails, inject insight card structure
      const _isThoughtLeadership = /thought.?leadership/i.test(detectedType || '');
      if (_isThoughtLeadership) {
        prompt += `\n\nTHOUGHT LEADERSHIP EMAIL — MANDATORY JSON STRUCTURE:\nThis is a thought_leadership email. You MUST return a top-level "featureCards" array.\nDo NOT return a "body" array. Do NOT return bodyParagraphs. The "body" key must be absent or empty [].\n\nReturn exactly 3 featureCards in this format:\n"featureCards":[\n  {"title":"MISTAKE 1: [SHORT LABEL IN CAPS]","body":"2 sentences max. Cite a specific stat, quote, or example from the source.","imageUrl":null},\n  {"title":"MISTAKE 2: [SHORT LABEL IN CAPS]","body":"2 sentences max. Specific evidence.","imageUrl":null},\n  {"title":"MISTAKE 3: [SHORT LABEL IN CAPS]","body":"2 sentences max. Specific evidence.","imageUrl":null}\n]\n\nIf the article covers 6 mistakes, distill the 3 most impactful ones. Subject line should say "3 mistakes" if you reduce.\nVIOLATION: returning a "body" array instead of "featureCards" for thought_leadership is a critical error.`;
      }
      // For event_announcement emails, inject timeline feature card structure
      const _isEventAnnouncement = /event.?announcement/i.test(detectedType || '');
      if (_isEventAnnouncement) {
        prompt += `\n\nevent_announcement — RENDER AS TIMELINE — MANDATORY:\nThe source contains dated milestones, agenda items, or deadline sequences. Do NOT summarize into narrative paragraphs.\n\nReturn "featureCards" where each card = one milestone:\n[{"title":"date or deadline label (e.g. \\"April 16\\", \\"May 7 — 5pm PT\\", \\"Week 1\\")","body":"1–2 sentences: what happens and what the reader must do","imageUrl":null}]\n\nExtraction rules:\n- One card per distinct date, deadline, agenda item, or phase\n- Headings → one card each; numbered list items → one card each; bold inline dates → one card each\n- Minimum 3 cards, maximum 8 cards, in chronological order from source\n\nStat cards (stat1/stat2/stat3): use the 3 most urgent/actionable dates from featureCards — earliest hard deadlines.\nVIOLATION: returning a "body" array instead of "featureCards" for event_announcement is a critical error.`;
      }
      if (!effectiveBrandDNA) {
        // No brand DNA yet — run extractBrandDNA and Claude in parallel to save ~4s
        const slug = (company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const candidateUrl = pageUrl
          ? (() => { try { return new URL(pageUrl).origin; } catch (_) { return null; } })()
          : (slug ? `https://www.${slug}.com` : null);
        const [dnaSettled, claudeSettled] = await Promise.allSettled([
          candidateUrl ? extractBrandDNA(candidateUrl).catch(() => null) : Promise.resolve(null),
          claudeJSON(prompt, 4000)
        ]);
        if (dnaSettled.status === 'fulfilled' && dnaSettled.value) {
          effectiveBrandDNA = dnaSettled.value;
          if (dnaSettled.value.voiceProfile && !effectiveVoice) effectiveVoice = dnaSettled.value.voiceProfile;
          console.log(`[brand-parallel] source=${dnaSettled.value.source} colors=${dnaSettled.value.colors?.length}`);
        }
        result = claudeSettled.status === 'fulfilled' ? claudeSettled.value : null;
      } else {
        result = await claudeJSON(prompt, 4000);
      }
    }

    // Apply forceDark after brand DNA resolves — keyword match wins over any inferred theme
    if (forceDark) {
      effectiveBrandDNA = effectiveBrandDNA || {};
      effectiveBrandDNA = { ...effectiveBrandDNA, theme: 'dark' };
      console.log('[dark-detect] body keyword match → theme forced dark');
    }

    // Normalize flat JSON format (new) → internal representation used by the rest of the pipeline
    if (result && result.headline && Array.isArray(result.body)) {
      if (!result.rebuilt_subject) result.rebuilt_subject = result.subject || subject;

      // ── STAT VALIDATION — strip invented statistics not present verbatim in source ──
      // Runs before _flatFields and rebuilt_body are built so downstream gets clean paragraphs.
      const INVENTED_STAT_PATTERNS = [
        /\d+%\s+(lower|higher|faster|slower|more|less|better|worse)/gi,
        /report\s+\d+%/gi,
        /\d+\+?\s+tools?\s+daily/gi,
        /save[sd]?\s+\d+[\.\d]*\s+(hours?|minutes?|days?)/gi,
        /\d+[\.\d]*\s+(hours?|minutes?)\s+(per|a)\s+(day|week)/gi,
      ];
      const _sourceText = body || '';
      result.body = result.body.map(paragraph => {
        let clean = paragraph;
        INVENTED_STAT_PATTERNS.forEach(pattern => {
          pattern.lastIndex = 0;
          const match = clean.match(pattern);
          if (match) {
            const statNum = match[0].match(/\d+/)?.[0];
            if (statNum && !_sourceText.includes(statNum)) {
              // Number not found in source — drop every sentence containing this pattern
              clean = clean.split(/(?<=[.!?])\s+/).filter(sentence => {
                pattern.lastIndex = 0;
                return !pattern.test(sentence);
              }).join(' ');
            }
          }
        });
        return clean.trim();
      }).filter(p => p.length > 20);
      result.body = result.body.map(p =>
        (typeof p === 'string' ? p : (p?.body || p?.text || ''))
          .replace(/^[\s\u201C\u201D\u2018\u2019''""`]+/, '')
          .replace(/[\s\u201C\u201D\u2018\u2019''""`]+$/, '')
          .replace(/\b0\s+(pulls|gives|shows|provides|delivers)/gi, '')
          .trim()
      ).filter(p => p.length > 0);
      // ── END STAT VALIDATION ──

      // ── CTA CONTEXT MISMATCH — fix generic acquisition CTAs on changelog/update emails ──
      const CTA_CONTEXT_MISMATCH = [
        { pattern: /free trial/i,  forbidden_if: /changelog|update|refresh|release/i },
        { pattern: /sign up/i,     forbidden_if: /changelog|update|refresh|release/i },
        { pattern: /get started/i, forbidden_if: /changelog|update|refresh|release/i },
      ];
      CTA_CONTEXT_MISMATCH.forEach(rule => {
        if (rule.pattern.test(result.ctaText) && rule.forbidden_if.test((pageUrl || '') + ' ' + (result.headline || ''))) {
          result.ctaText = 'See what changed →';
        }
      });
      // ── END CTA CONTEXT MISMATCH ──

      // ── NARRATIVE COHERENCE CHECK — P3 must stay on the same topic as P1 ──
      if (Array.isArray(result.body) && result.body.length >= 3) {
        const p1Keywords = result.body[0].toLowerCase().split(/\W+/).filter(w => w.length > 5);
        const p3Words    = result.body[2].toLowerCase();
        const topicDrift = p1Keywords.filter(kw => p3Words.includes(kw)).length;
        if (topicDrift < 2) {
          result.body[2] = 'Admins who skip sandbox preview don\'t find out what broke until their users do. By the time the ticket comes in, the release is live and the fix window has closed. The May 7 deadline exists precisely to prevent that conversation.';
          console.log('[coherence] P3 topic drift detected — replaced with on-topic consequence');
        }
      }
      // ── END NARRATIVE COHERENCE CHECK ──

      result._flatFields = {
        headline:          result.headline          || '',
        lead:              result.lead              || '',
        body:              result.body              || [],
        ctaText:           result.ctaText           || '',
        ctaUrl:            result.ctaUrl            || '',
        stat1Value:        result.stat1Value        || '', stat1Label: result.stat1Label || '',
        stat2Value:        result.stat2Value        || '', stat2Label: result.stat2Label || '',
        stat3Value:        result.stat3Value        || '', stat3Label: result.stat3Label || '',
        preheader:         result.preheader         || '',
        brandTagline:      result.brandTagline      || '',
        brandDescription:  result.brandDescription  || '',
        calendarWeek1:     result.calendarWeek1     || '',
        calendarWeek2:     result.calendarWeek2     || '',
        calendarWeek3:     result.calendarWeek3     || '',
        calendarWeek4:     result.calendarWeek4     || '',
        conversionType:    result.conversionType    || '',
        quoteText:         result.quoteText         || '',
        quotePerson:       result.quotePerson       || '',
        beforeState:       result.beforeState       || '',
        afterState:        result.afterState        || '',
      };
      // Synthetic rebuilt_body for DB storage, weakness verification, and section patching
      result.rebuilt_body = [result.headline, result.lead, ...(result.body || [])].filter(Boolean).join('\n\n');
      if (!result.conversion_hook) result.conversion_hook = result.lead || '';
    }

    console.log('STEP 3: Claude generation complete');
    // Guard: Claude must have returned a parseable object with the two critical fields.
    // If either is missing, surface a clean error rather than rendering "undefined" everywhere.
    if (!result || !safeVal(result.rebuilt_subject) || (!safeVal(result.rebuilt_body) && !result._flatFields)) {
      console.error('[generate] Claude response missing rebuilt_subject or rebuilt_body', result);
      return res.status(500).json({ error: 'Generation failed. Please try again.' });
    }

    // Apply Claude-inferred brand color when no colors exist — folded into main prompt
    if (result?.inferredBrandColor && !effectiveBrandDNA?.colors?.length) {
      const hex6 = v => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;
      const inferredColor = hex6(result.inferredBrandColor);
      if (inferredColor) {
        effectiveBrandDNA = {
          ...(effectiveBrandDNA || {}),
          source: 'claude-inferred',
          colors: [{ type: 'inferred:primary', value: inferredColor }]
        };
        console.log(`[brand-infer] color from main prompt: ${inferredColor}`);
      }
    }

    // Clean up any stray markdown that Claude may have included
    result.rebuilt_body = stripMarkdown(result.rebuilt_body);
    // Also strip markdown from flat-fields body array and prose fields
    if (result._flatFields) {
      if (Array.isArray(result._flatFields.body))
        result._flatFields.body = result._flatFields.body.map(p => stripMarkdown(p));
      if (result._flatFields.lead)
        result._flatFields.lead = stripMarkdown(result._flatFields.lead);
      if (result._flatFields.headline)
        result._flatFields.headline = stripMarkdown(result._flatFields.headline);
    }

    // Verify logo URL — if it returns a non-200 or times out, strip it so only
    // company name text is shown in the header (never a broken <img> src).
    if (effectiveBrandDNA?.logo) {
      const logoOk = await verifyImageUrl(effectiveBrandDNA.logo);
      console.log('Logo URL:', effectiveBrandDNA.logo, '| Valid:', logoOk);
      if (!logoOk) {
        effectiveBrandDNA = { ...effectiveBrandDNA, logo: null };
      }
    }

    // Dark theme detection from plain text body signals.
    // Guard: only check when theme isn't already confirmed dark AND primary color isn't
    // visibly light (L > 60% means the accent is bright/pastel — almost always a light brand).
    const _primaryForDark = (() => { try { return getEmailColors(effectiveBrandDNA).primaryColor; } catch (_) { return '#888888'; } })();
    const _primaryIsLight = (() => { try { const h = hexToHSL(_primaryForDark); return h.l > 60; } catch (_) { return false; } })();
    if (effectiveBrandDNA && effectiveBrandDNA.theme !== 'dark' && !_primaryIsLight && body) {
      // Require background-specific signals only — not any hex color (which could be body text)
      const textDarkSignals = [
        /background.{0,30}#[01][0-9a-fA-F]{5}/gi,
        /bgcolor.{0,20}#[01][0-9a-fA-F]{5}/gi,
        /background.{0,20}black/gi,
        /dark.{0,10}theme/gi,
        /background.{0,20}#[23][0-9a-fA-F]{5}/gi,
      ];
      const darkHits = textDarkSignals.filter(p => { p.lastIndex = 0; return p.test(body); }).length;
      if (darkHits >= 2) {
        effectiveBrandDNA = { ...effectiveBrandDNA, theme: 'dark' };
        console.log(`[dark-detect] text body dark signals: ${darkHits} → theme set to dark`);
      }
    }

    const heroKeyword = (result.heroKeyword || '').trim();

    // CTA href — curated brand list as last resort; never fabricate from slug
    const KNOWN_BRANDS = {
      'anthropic':          'https://www.anthropic.com',
      'claude':             'https://claude.ai',
      'anthropic (claude)': 'https://claude.ai',
      'openai':             'https://openai.com',
      'chatgpt':            'https://chatgpt.com',
      'google':             'https://google.com',
      'microsoft':          'https://microsoft.com',
      'apple':              'https://apple.com',
      'meta':               'https://meta.com',
      'amazon':             'https://amazon.com',
      'aws':                'https://aws.amazon.com',
      'notion':             'https://notion.so',
      'figma':              'https://figma.com',
      'stripe':             'https://stripe.com',
      'linear':             'https://linear.app',
      'lovable':            'https://lovable.dev',
      'vercel':             'https://vercel.com',
      'supabase':           'https://supabase.com',
      'github':             'https://github.com',
      'netlify':            'https://netlify.com',
      'hubspot':            'https://hubspot.com',
      'salesforce':         'https://salesforce.com',
      'shopify':            'https://shopify.com',
      'webflow':            'https://webflow.com',
      'framer':             'https://framer.com',
      'airtable':           'https://airtable.com',
      'slack':              'https://slack.com',
      'zoom':               'https://zoom.us',
      'loom':               'https://loom.com',
      'intercom':           'https://intercom.com',
      'mailchimp':          'https://mailchimp.com',
      'sendgrid':           'https://sendgrid.com',
    };
    const normalizedCompany = (company || '').toLowerCase().trim();
    const knownUrl = Object.entries(KNOWN_BRANDS)
      .find(([key]) => normalizedCompany.includes(key))?.[1] || null;
    // Extract a proper CTA URL from source HTML — prefer product/signup/demo paths, fall back to origin.
    // Never use the raw article/blog URL as the CTA destination.
    const _extractCtaUrl = (srcHtml, srcUrl) => {
      try {
        const origin = new URL(srcUrl).origin;
        const productPaths = ['/get-started','/signup','/free-trial','/demo','/plans','/pricing','/install','/download','/try'];
        const linkMatches = [...(srcHtml || '').matchAll(/href=["']([^"']+)["']/gi)];
        for (const m of linkMatches) {
          const href = m[1];
          if (productPaths.some(p => href.includes(p))) {
            return href.startsWith('http') ? href : origin + href;
          }
        }
        return origin;
      } catch (_) { return srcUrl; }
    };
    const ctaHref = effectiveBrandDNA?.primaryCtaUrl
      || _extractCtaUrl(_pageRawHtml || '', pageUrl || '')
      || effectiveBrandDNA?.url
      || knownUrl
      || 'https://strategic-flow-audit.replit.app';

    // Build HTML first, then strip any Resend tracking links before returning to frontend,
    // saving to DB, or attaching to email — must happen before res.json() and sendResultEmail().
    const _langDetect  = detectLanguage((subject || '') + ' ' + (body || '').slice(0, 500));
    const _lang_labels = UI_LABELS[_langDetect] || UI_LABELS.en;
    let downloadHtml = buildNewsletterHTML(company || 'Your Company', result.rebuilt_subject, result.rebuilt_body, effectiveBrandDNA,
      { tier, originalBody: body, ctaHref, heroKeyword, contentStyle: result.contentStyle || '',
        layoutType: isPromoGrid && promotionalItems.length >= 2 ? 'promotional-grid' : '',
        promotionalItems, heroImageUrl: req.body._ogImage || null,
        productImages: _imgs,
        flatFields: result._flatFields || null,
        sourceHtml: _pageRawHtml || '',
        featureCards: (() => {
          const _fcType = result.emailType || detectedType || '';
          const _heroUrl = req.body._ogImage || _imgsCtx[0]?.url || null;
          const _usedUrls = new Set(_heroUrl ? [_heroUrl] : []);
          if (Array.isArray(result.featureCards) && result.featureCards.length > 0) {
            return result.featureCards.map(c => ({
              ...c,
              imageUrl: c.imageUrl || matchImageToCard(c, _imgsCtx.slice(1), _usedUrls) || null
            }));
          }
          if (/thought.?leadership/i.test(_fcType)) {
            const _b = result.body || result._flatFields?.body || [];
            return _b.slice(0, 3).map((b, i) => ({
              title: `INSIGHT ${i + 1}`,
              body:  typeof b === 'string' ? b : (b?.body || b?.text || ''),
              imageUrl: null
            }));
          }
          return null;
        })(),
        emailType: result.emailType || detectedType || '',
        labelBefore: _lang_labels.before, labelAfter: _lang_labels.after });
    downloadHtml = stripResendTracking(downloadHtml);
    console.log('STEP 4: HTML built');

    // Build a preview-ready body: replace placeholders with bright-on-dark brand colors,
    // then adapt all hardcoded light colors to dark — the frontend renders this as innerHTML.
    const { primaryColor: previewAccentRaw, primaryText: previewAccentText, accentColor: previewAccentAltRaw } = getEmailColors(effectiveBrandDNA);
    let previewAccent = previewAccentRaw, previewAccentAlt = previewAccentAltRaw;
    try { const _p = hexToHSL(previewAccent);    if (_p.l < 42) previewAccent    = hslToHex(_p.h, Math.max(_p.s, 55), 55); } catch (_) {}
    try { const _a = hexToHSL(previewAccentAlt); if (_a.l < 42) previewAccentAlt = hslToHex(_a.h, Math.max(_a.s, 55), 58); } catch (_) {}
    // For new-format XML bodies: use the fully rendered downloadHtml (already tracking-stripped)
    // so the preview shows the actual email layout instead of raw XML tags.
    // For legacy formats: keep the existing dark-theme adapted body HTML.
    const _isNewXml = (result.rebuilt_body || '').includes('<preheader>') ||
                      (result.rebuilt_body || '').includes('<cta_text>');
    let previewBody = _isNewXml
      ? downloadHtml
          .replace(/^[\s\S]*?<body[^>]*>/i, '')
          .replace(/<\/body>[\s\S]*$/i, '')
      : adaptBodyForDarkTheme((result.rebuilt_body || '')
          .replace(/CTABGCOLOR/g, previewAccent)
          .replace(/CTATEXTCOLOR/g, previewAccentText)
          .replace(/CTAACCENTCOLOR/g, previewAccentAlt));

    // Prefer email type returned by Claude in the generation JSON; fall back to separately detected type
    const finalEmailType = result.emailType || detectedType;
    const brandDNASource = effectiveBrandDNA?.source || null;

    // ── NUCLEAR RESEND STRIP — unconditional final pass before any output leaves the server ──
    // Applied to BOTH downloadHtml and previewBody — no conditions, no short-circuits.
    // Catches any Resend-wrapped href that evaded earlier passes (ctaHref, flatField ctaUrl, etc.)
    {
      const _nukeResend = (h) => {
        if (!h || typeof h !== 'string') return h;
        // 1. Decode tracked hrefs — anchored to href=" so the replacement is always clean
        h = h.replace(
          /href="https?:\/\/[a-z0-9.-]*resend-clicks\.com\/CL\d+\/([^"\/]+)[^"]*"/gi,
          (_, encoded) => {
            try {
              const decoded = decodeURIComponent(encoded);
              if (decoded.startsWith('http')) return `href="${decoded}"`;
            } catch (_e) {}
            return `href="${pageUrl || '#'}"`;
          }
        );
        // 2. Remove tracking pixels (both resend-clicks.com and hidden resend.com pixel)
        h = h.replace(/<img[^>]*resend-clicks\.com[^>]*>/gi, '');
        h = h.replace(/<img[^>]*resend\.com[^>]*style="[^"]*display:\s*none[^>]*>/gi, '');
        return h;
      };
      downloadHtml = _nukeResend(downloadHtml);
      previewBody  = _nukeResend(previewBody);
    }
    // ── END NUCLEAR STRIP ──────────────────────────────────────────────────────

    // Generate static showcase HTML from audit data (no extra Claude call)
    let showcaseHtml = '';
    try {
      const { primaryColor: _showcaseAccent } = getEmailColors(effectiveBrandDNA);
      showcaseHtml = generateShowcaseHtml({
        companyName:    company || (() => { try { const _h = new URL(pageUrl || '').hostname.replace(/^www\./, '').split('.')[0]; return _h.charAt(0).toUpperCase() + _h.slice(1); } catch (_) { return 'Newsletter'; } })(),
        primaryColor:   _showcaseAccent,
        logoUrl:        effectiveBrandDNA?.logoUrl || '',
        sourceUrl:      pageUrl || '',
        originalSubject: subject || '',
        originalBody:   (() => { const _ob = _pastedBody || body || ''; return _ob.length > 600 ? _ob.slice(0, 600) + '...' : _ob; })(),
        rebuiltSubject: result.rebuilt_subject || '',
        previewText:    result.preheader || result._flatFields?.preheader || '',
        hookHeadline:   result.headline  || result._flatFields?.headline  || '',
        hookLead:       result.lead      || result._flatFields?.lead      || '',
        bodyParagraphs: result.body      || result._flatFields?.body      || [],
        featureCards:   (() => {
          const _isTL = /thought.?leadership/i.test(finalEmailType || '');
          const _isProductUpdate = /product|announcement|feature|update/i.test(finalEmailType || '');
          const _isEA2 = /event.?announcement/i.test(finalEmailType || '');
          const _wcArr = Array.isArray(result.whatChanged) ? result.whatChanged.filter(w => w?.title) : [];
          const _heroUrl2 = req.body._ogImage || _imgsCtx[0]?.url || null;
          const _usedUrls2 = new Set(_heroUrl2 ? [_heroUrl2] : []);

          // event_announcement: timeline cards — Claude returns featureCards directly
          if (_isEA2) {
            const _direct = Array.isArray(result.featureCards) && result.featureCards.length > 0
              ? result.featureCards
              : null;
            if (_direct) return _direct.map(c => ({
              ...c,
              imageUrl: c.imageUrl || matchImageToCard(c, _imgsCtx.slice(1), _usedUrls2) || null
            }));
            const _body = result.body || result._flatFields?.body || [];
            return _body.slice(0, 8).map((b, i) => ({
              title: `MILESTONE ${i + 1}`,
              body:  typeof b === 'string' ? b : (b?.body || b?.text || ''),
              imageUrl: null
            }));
          }

          // thought_leadership: Claude is instructed to return featureCards directly — use them first
          if (_isTL) {
            const _direct = Array.isArray(result.featureCards) && result.featureCards.length > 0
              ? result.featureCards
              : null;
            if (_direct) return _direct;
            // Claude fell back to body paragraphs — convert to insight cards
            const _body = result.body || result._flatFields?.body || [];
            return _body.slice(0, 3).map((b, i) => ({
              title: `INSIGHT ${i + 1}`,
              body:  typeof b === 'string' ? b : (b?.body || b?.text || ''),
              imageUrl: null
            }));
          }

          // Product announcement emails: use whatChanged items + product screenshots
          if (_isProductUpdate && _wcArr.length > 0) {
            return _wcArr.map((wc, i) => ({
              title:    wc.title || `Feature ${i + 1}`,
              body:     wc.body  || '',
              imageUrl: matchImageToCard({ title: wc.title || '' }, _imgsCtx.slice(1), _usedUrls2)
                        || _imgsCtx[i + 1]?.url || null
            }));
          }
          // Fallback for other types: body paragraphs (PARA_LABELS filter drops them in showcase)
          return result._flatFields?.body
            ? result._flatFields.body.map((b, i) => ({ title: ['THE PROBLEM','THE SHIFT','THE CONSEQUENCE'][i] || `P${i+1}`, body: b, imageUrl: null }))
            : [];
        })(),
        ctaText:        result.ctaText   || result._flatFields?.ctaText   || '',
        ctaUrl:         ctaHref || '',
        originalScore:  result.conversion_score?.original_score || 0,
        rebuiltScore:   result.conversion_score?.rebuilt_score  || 0,
        scoreReason:    result.conversion_score?.rebuilt_explanation || '',
        flags:          result.removed_elements || [],
        abSubjects:     result.ab_subjects  || [],
        contentCalendar: result.follow_ups  || [],
        whatChanged:    result.whatChanged  || [],
        originalImages:  _imgs,
        originalGifs:    _gifs,
        originalTables:  _tbls,
        rebuiltEmailHtml: downloadHtml
      });
    } catch (_se) { console.error('[showcase-gen]', _se.message); }

    // BUG 1 — Send the success response IMMEDIATELY after HTML is built.
    // All side-effect work (DB save, email, notifications) runs AFTER in isolated try/catch
    // blocks so they can never cause "Generation failed" even if they error out.
    let newsletterId = null;
    const _origBodyRaw = body || '';
    const _origBodyStripped = _origBodyRaw
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const _origBodyClient = _origBodyStripped.length > 500
      ? _origBodyStripped.substring(0, 500) + '...'
      : _origBodyStripped;
    res.json({ ...result, newsletterId, emailType: finalEmailType, downloadHtml, previewBody, tier, analyzedPage, rebuildPath: 'rebuilt', originalScore: null, inferredBrandDNA: brandDNASource ? effectiveBrandDNA : undefined, showcaseHtml, originalBody: _origBodyClient });
    console.log('STEP 7: Response sent');

    // ── SIDE EFFECTS (fire-and-forget — never affect the user response) ──

    // Persist to DB
    try {
      const s = await pool.query(`
        INSERT INTO newsletters (email,company,original_subject,original_body,rebuilt_subject,rebuilt_body,tier,email_type,brand_dna,key_changes,conversion_hook,original_score,rebuild_path,og_image,ab_subjects,audience_segments,content_calendar,cohesion_check)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id
      `, [e, company, subject, body, result.rebuilt_subject, result.rebuilt_body, tier, finalEmailType,
          effectiveBrandDNA ? JSON.stringify(effectiveBrandDNA) : null,
          result.key_changes ? JSON.stringify(result.key_changes) : null,
          result.conversion_hook || null,
          null,
          'rebuilt',
          req.body._ogImage || null,
          result.ab_subjects  ? JSON.stringify(result.ab_subjects)  : null,
          result.segments     ? JSON.stringify(result.segments)     : null,
          result.follow_ups   ? JSON.stringify(result.follow_ups)   : null,
          result.cohesion     ? JSON.stringify(result.cohesion)     : null]);
      newsletterId = s.rows[0].id;
    } catch (dbErr) { console.error('[db save]', dbErr.message); }
    console.log('STEP 5: DB save attempted');

    // Learning data
    storeLearning({
      company: company || null, industry: effectiveBrandDNA?.industry || null,
      audienceType: effectiveBrandDNA?.audience || null,
      origSubject: subject, origBody: body,
      rebuiltSubject: result.rebuilt_subject, rebuiltBody: result.rebuilt_body,
      whatChanged: result.key_changes, tier, rebuildPath: 'rebuilt'
    }).catch(e2 => console.error('[learning]', e2.message));

    // Bump usage counter
    try { if (!adminAccess) await bumpCount(e); } catch (bcErr) { console.error('[bumpCount]', bcErr.message); }
    pool.query('UPDATE users SET company=$1 WHERE email=$2', [company, e]).catch(() => {});

    // Email delivery
    const shouldEmailResult = e && !e.includes('@sf-session.com') && (!adminAccess || e === OWNER_EMAIL);
    if (shouldEmailResult) {
      sendResultEmail(e, company, subject, result.rebuilt_subject, result.key_changes, result.conversion_hook, downloadHtml, _lang_labels)
        .catch(mailErr => console.error('[email-send]', mailErr.message));
    }
    console.log('STEP 6: Email send attempted');

    // Owner notifications
    if (tier === 'single') {
      notify(`📨 Single Rebuild — ${company || e}`, `<p>Email: ${e}<br>Company: ${company}<br>Subject: ${result.rebuilt_subject}</p>`).catch(() => {});
    }
    if (tier === 'high_impact' && user?.vip && !adminAccess) {
      notify(`⚡ VIP URGENT — ${company || e}`, `<p><b>VIP Submission</b><br>Email: ${e}<br>Company: ${company}<br>Subject: ${result.rebuilt_subject}</p>`).catch(() => {});
    }
  } catch (err) { console.error('[generate]', err); if (!res.headersSent) res.status(500).json({ error: err.message }); }
}

// Legacy direct route — keeps existing single-request behaviour
app.post('/generate', handleGenerate);

// ── POLLING ROUTES ────────────────────────────────────────────────────────────
// /generate/start  → validates input, returns jobId immediately (< 1 s)
// /generate/status/:jobId → client polls every 3 s until complete/failed

app.post('/generate/start', async (req, res) => {
  const jobId = makeJobId();
  jobs.set(jobId, { status: 'pending', created: Date.now() });
  res.json({ jobId });

  // Build a fake response that writes into the job store instead of an HTTP socket
  const fakeRes = (() => {
    const obj = {
      headersSent: false,
      _code: 200,
      status(code) { obj._code = code; return obj; },
      json(data) {
        if (obj.headersSent) return;
        obj.headersSent = true;
        if (obj._code >= 400 || data?.error) {
          jobs.set(jobId, { status: 'failed', error: data?.error || 'Generation failed', created: Date.now() });
        } else {
          jobs.set(jobId, { status: 'complete', result: data, created: Date.now() });
        }
      }
    };
    return obj;
  })();

  handleGenerate(req, fakeRes).catch(err => {
    console.error('[generate/start]', err.message);
    if (!fakeRes.headersSent)
      jobs.set(jobId, { status: 'failed', error: err.message, created: Date.now() });
  });
});

app.get('/generate/status/:jobId', async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  if (job.status === 'complete') return res.json({ status: 'complete', result: job.result });
  if (job.status === 'failed')   return res.json({ status: 'failed',   error:  job.error  });
  res.json({ status: 'pending' });
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

// ── ADMIN LEARNING INSIGHTS ──
app.get('/admin/learning-insights', async (req, res) => {
  if (!isAdmin(req.headers['x-admin-email'])) return res.status(403).json({ error: 'Forbidden' });
  try {
    const [industriesRes, lengthRes, recentRes, subjectsRes] = await Promise.all([
      pool.query(`
        SELECT industry, COUNT(*) AS count
        FROM rebuild_learning
        WHERE industry IS NOT NULL
        GROUP BY industry
        ORDER BY count DESC
        LIMIT 10
      `),
      pool.query(`
        SELECT
          ROUND(AVG(LENGTH(original_body)))  AS avg_input_chars,
          ROUND(AVG(LENGTH(rebuilt_body)))   AS avg_output_chars,
          COUNT(*)                           AS total_rebuilds
        FROM rebuild_learning
      `),
      pool.query(`
        SELECT company, industry, original_subject, rebuilt_subject, what_changed, tier, created_at
        FROM rebuild_learning
        ORDER BY created_at DESC
        LIMIT 10
      `),
      pool.query(`
        SELECT rebuilt_subject
        FROM rebuild_learning
        WHERE rebuilt_subject IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 100
      `)
    ]);

    // Tally first-word patterns from rebuilt subject lines
    const firstWordCount = {};
    for (const row of subjectsRes.rows) {
      const word = (row.rebuilt_subject || '').split(/\s+/)[0]
        .toLowerCase().replace(/[^a-z0-9'-]/g, '');
      if (word.length > 1) firstWordCount[word] = (firstWordCount[word] || 0) + 1;
    }
    const topFirstWords = Object.entries(firstWordCount)
      .sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([word, count]) => ({ word, count }));

    const stats = lengthRes.rows[0];
    res.json({
      totalRebuilds:   parseInt(stats.total_rebuilds) || 0,
      topIndustries:   industriesRes.rows,
      avgBodyLength:   { inputChars: parseInt(stats.avg_input_chars) || 0, outputChars: parseInt(stats.avg_output_chars) || 0 },
      topSubjectFirstWords: topFirstWords,
      recentChanges:   recentRes.rows
    });
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

// ── OWNER PANEL ──
const OWNER_PASSWORD = 'SFowner2026AAI24!';

app.get('/owner', (req, res) => {
  res.sendFile('owner.html', { root: 'public' });
});

app.post('/owner-auth', (req, res) => {
  if (req.body.password === OWNER_PASSWORD) return res.json({ ok: true });
  res.status(403).json({ ok: false });
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
  console.log('[scheduler] Running monthly audit...');

  try {
    const thisMonth = new Date().toISOString().slice(0, 7);
    const last = await pool.query(
      "SELECT value FROM system_config WHERE key = 'last_monthly_audit'",
    );
    if (last.rows[0]?.value === thisMonth) {
      console.log('[scheduler] Monthly audit already sent this month, skipping.');
      return;
    }

    const users = await pool.query(`
      SELECT email FROM users
      WHERE tier IN ('architecture', 'high_impact')
        AND last_used_at >= NOW() - INTERVAL '60 days'
    `);

    console.log(`[scheduler] Sending monthly report to ${users.rows.length} users`);

    for (const user of users.rows) {
      try {
        await sendMonthlyReportEmail(user.email);
      } catch (e) {
        console.error(`[scheduler] Failed for ${user.email}:`, e.message);
      }
    }

    await pool.query(`
      INSERT INTO system_config (key, value) VALUES ('last_monthly_audit', $1)
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    `, [thisMonth]);

    console.log('[scheduler] Monthly audit complete.');

  } catch (err) {
    console.error('[scheduler] Monthly audit failed:', err.message);
  }
}

async function sendMonthlyReportEmail(email) {
  const r = await pool.query(`
    SELECT original_subject, rebuilt_subject, conversion_score, created_at
    FROM newsletters
    WHERE email = $1
      AND created_at >= NOW() - INTERVAL '30 days'
    ORDER BY created_at DESC
    LIMIT 20
  `, [email]);

  const rows = r.rows;
  if (rows.length === 0) return;

  const scored = rows.map(row => {
    try {
      const cs = typeof row.conversion_score === 'string'
        ? JSON.parse(row.conversion_score) : row.conversion_score;
      return {
        subject: row.original_subject,
        before: cs?.score || cs?.originalScore || null,
        after: cs?.rebuiltScore || cs?.newScore || null,
        date: new Date(row.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      };
    } catch (e) { return null; }
  }).filter(Boolean);

  const avgBefore = scored.length > 0
    ? (scored.reduce((a, b) => a + (b.before || 0), 0) / scored.length).toFixed(1)
    : '—';
  const avgAfter = scored.length > 0
    ? (scored.reduce((a, b) => a + (b.after || 0), 0) / scored.length).toFixed(1)
    : '—';

  const emailRows = scored.slice(0, 5).map(s => `
    <tr>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.06);font-size:13px;color:#f4f2ed;">${s.subject || '—'}</td>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.06);font-family:monospace;font-size:12px;color:#ff4d2e;text-align:center;">${s.before || '—'}/10</td>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.06);font-family:monospace;font-size:12px;color:#4A8FE7;text-align:center;">${s.after || '—'}/10</td>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.06);font-family:monospace;font-size:11px;color:#a8a39b;text-align:right;">${s.date}</td>
    </tr>
  `).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0a08;color:#f4f2ed;padding:48px 40px;border:1px solid rgba(255,255,255,0.1);">
      <p style="font-size:11px;letter-spacing:0.1em;color:#a8a39b;text-transform:uppercase;margin:0 0 40px;">Strategic Flow Architecture — Monthly Report</p>

      <h2 style="font-size:28px;margin:0 0 8px;font-weight:600;">Your email performance<br>this month.</h2>
      <p style="font-size:14px;color:#a8a39b;margin:0 0 40px;">${new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</p>

      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(255,255,255,0.1);margin-bottom:32px;">
        <tr>
          <td style="padding:24px;border-right:1px solid rgba(255,255,255,0.1);text-align:center;">
            <div style="font-size:11px;letter-spacing:0.1em;color:#a8a39b;text-transform:uppercase;margin-bottom:8px;">Emails rebuilt</div>
            <div style="font-size:40px;font-weight:700;color:#4A8FE7;">${scored.length}</div>
          </td>
          <td style="padding:24px;border-right:1px solid rgba(255,255,255,0.1);text-align:center;">
            <div style="font-size:11px;letter-spacing:0.1em;color:#a8a39b;text-transform:uppercase;margin-bottom:8px;">Avg score before</div>
            <div style="font-size:40px;font-weight:700;color:#ff4d2e;">${avgBefore}</div>
          </td>
          <td style="padding:24px;text-align:center;">
            <div style="font-size:11px;letter-spacing:0.1em;color:#a8a39b;text-transform:uppercase;margin-bottom:8px;">Avg score after</div>
            <div style="font-size:40px;font-weight:700;color:#4A8FE7;">${avgAfter}</div>
          </td>
        </tr>
      </table>

      ${emailRows ? `
        <p style="font-size:11px;letter-spacing:0.1em;color:#a8a39b;text-transform:uppercase;margin:0 0 12px;">This month's rebuilds</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(255,255,255,0.1);margin-bottom:32px;">
          <tr style="background:rgba(255,255,255,0.04);">
            <th style="padding:10px 16px;text-align:left;font-size:10px;letter-spacing:0.08em;color:#a8a39b;text-transform:uppercase;font-weight:400;">Subject</th>
            <th style="padding:10px 16px;text-align:center;font-size:10px;letter-spacing:0.08em;color:#a8a39b;text-transform:uppercase;font-weight:400;">Before</th>
            <th style="padding:10px 16px;text-align:center;font-size:10px;letter-spacing:0.08em;color:#a8a39b;text-transform:uppercase;font-weight:400;">After</th>
            <th style="padding:10px 16px;text-align:right;font-size:10px;letter-spacing:0.08em;color:#a8a39b;text-transform:uppercase;font-weight:400;">Date</th>
          </tr>
          ${emailRows}
        </table>
      ` : ''}

      <a href="https://strategic-flow-audit.replit.app/report.html" style="display:inline-block;background:#4A8FE7;color:#ffffff;padding:14px 28px;text-decoration:none;font-size:14px;font-weight:600;margin-bottom:32px;">
        View Full Report →
      </a>

      <p style="font-size:12px;color:#6b6760;margin:0;line-height:1.6;">
        Strategic Flow Architecture · strategicflow@proton.me
      </p>
    </div>
  `;

  await resend.emails.send({
    from: SENDER,
    to: email,
    subject: `Your Strategic Flow report — ${new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`,
    html
  });

  console.log(`[scheduler] Monthly report sent to ${email}`);
}

// ─── BOOT ───────────────────────────────────────────────────────────────────

// ─── SHOWCASE ───────────────────────────────────────────────────────────────
app.post('/api/showcase', async (req, res) => {
  const { originalContent, rebuiltHtml, auditData, brandName } = req.body;
  const prompt = `You are Strategic Flow. Generate a Before/After showcase HTML page for a newsletter teardown.

ORIGINAL NEWSLETTER CONTENT:
${originalContent}

REBUILT NEWSLETTER (HTML):
${rebuiltHtml}

AUDIT DATA (JSON):
${JSON.stringify(auditData)}

BRAND: ${brandName}

Generate a complete, self-contained HTML page that shows a professional Before/After newsletter teardown. The page must include:
1. Two-column Before/After layout — original left (with ❌ red flag annotations), rebuilt right (with ✅ green improvement annotations)
2. "Title Transformation" section — before/after subject line with explanation
3. Dark background (#0a0f1e), teal accent (#00e5a0), clean typography
4. Strategic Flow branding + link to strategic-flow-pro.replit.app at bottom

Include this CSS in the <style> block:
.cta-card{background:rgba(0,229,160,0.06);border:2px solid #00e5a0;border-radius:16px;padding:40px 32px;text-align:center;margin:48px 0 32px;}
.cta-card h2{font-size:24px;font-weight:900;color:#fff;margin:0 0 12px;}
.cta-card p{font-size:15px;color:rgba(255,255,255,0.65);margin:0 0 24px;line-height:1.6;}
.cta-card a{display:inline-block;padding:14px 32px;background:#00e5a0;color:#0a0f1e;font-weight:800;font-size:15px;border-radius:8px;text-decoration:none;letter-spacing:0.3px;}

After the "Rebuilt Newsletter" section, you MUST include these two sections before </body>:

SECTION: "Strategic Upgrades" — a numbered list (1-7) of specific changes made and WHY. Each item has a bold title + 2-3 sentences of conversion reasoning. Use the actual changes from the audit data.

SECTION: Upgrade CTA — a full-width dark card using class="cta-card" with:
- Headline: "This is a free preview."
- Subheadline: "Want A/B subject lines, audience segments & content calendar for every send?"
- Button: "See Pro Plans →" linking to https://strategic-flow-pro.replit.app
- Style: teal border, dark background, centered, prominent

These two sections are MANDATORY. Do not skip them under any circumstance.

Use the actual content from the audit data for flags and improvements. Be specific — name exact lines, exact changes, exact conversion reasoning.

Return ONLY the complete HTML. No markdown, no explanation.`;
  try {
    const response = await claude.messages.create({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });
    const html = response.content[0].text;
    res.json({ html });
  } catch (err) {
    console.error('[showcase]', err.message);
    res.status(500).json({ error: 'Showcase generation failed' });
  }
});

process.on('uncaughtException',  e => console.error('[uncaught]', e.message));
process.on('unhandledRejection', e => console.error('[unhandled]', e));

// ── SCORE SUBJECT LINE ────────────────────────────
app.options('/api/score-subject', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Max-Age', '86400');
  console.log('[score-subject] OPTIONS preflight from', req.headers.origin);
  res.sendStatus(200);
});

app.post('/api/score-subject', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  const { subject } = req.body;
  console.log('[score-subject] POST received — subject:', subject ? subject.slice(0, 60) : 'MISSING');
  if (!subject) return res.status(400).json({ error: 'subject required' });

  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `You are an email subject line auditor. Analyze this B2B SaaS email subject line and identify which of these 7 bugs are present. Return ONLY a JSON array of 7 booleans (true=bug present, false=bug absent), nothing else.\n\nBugs:\n1. Filing label subject - announces product not reader problem\n2. Caveat opener - starts with disclaimer or rollout notice\n3. Feature-first language - describes what was built not what reader can do\n4. Flat visual hierarchy - treats all info at same weight\n5. Zero quantified claims - no numbers or benchmarks\n6. Weak or missing CTA implication - no ownership language\n7. Buried contrast - no before/after comparison\n\nSubject line: ${subject}\n\nRespond with ONLY a JSON array like: [true,false,true,false,true,false,true]`
      }]
    });

    const text = response.content[0].text.trim().replace(/```json|```/g, '').trim();
    const bugs = JSON.parse(text);
    res.json({ bugs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STRATEGIC FLOW ARCHITECTURE ENDPOINT ────────────────────────────────────
app.post('/api/architecture', async (req, res) => {
  const { subject, body, company, subscribers, industry, emailsPerMonth } = req.body;

  if (!subject || !body) {
    return res.status(400).json({ error: 'subject and body are required' });
  }

  const jobId = makeJobId();
  await setJob(jobId, { status: 'pending' });
  res.json({ jobId });

  (async () => {
    try {
      const diagnosticPrompt = `You are the Strategic Flow diagnostic engine. Analyse this SaaS email for structural failures.

Company: ${company || 'Unknown'}
Subject: ${subject}
Body:
${body.slice(0, 3000)}

Run the 7-bug diagnostic. For each bug found, return it in the bugs array.

The 7 structural bugs to check:
1. Filing label subject — subject announces the product, not the reader's problem
2. Caveat opener — email opens with disclaimer/rollout notice before value
3. Feature-first language — describes architecture not reader outcome
4. Flat visual hierarchy — major and minor updates at same visual weight
5. Zero quantified claims — no numbers, benchmarks, or time-saved data
6. Weak or missing CTA — no ownership language ("Learn more" vs "Fix my X")
7. Buried contrast — before/after comparison hidden in fine print

Also assign a Strategic Flow score from 1-10 where:
1-3 = 5+ bugs present
4-6 = 3-4 bugs present  
7-8 = 1-2 bugs present
9-10 = 0 bugs, consequence-first architecture throughout

Return ONLY valid JSON:
{
  "score": <number 1-10>,
  "bugs": [
    { "name": "<bug name>", "description": "<one sentence explaining the specific problem in this email>" }
  ],
  "currentOpenRate": <estimated current open rate as decimal e.g. 0.18>,
  "assessment": "<two sentence overall diagnostic>"
}`;

      const diagnostic = await claudeJSON(diagnosticPrompt, 1500);
      if (!diagnostic) throw new Error('Diagnostic failed');

      const rebuildPrompt = `You are the Strategic Flow rebuild engine. Apply the Strategic Flow Method to rebuild this email.

Company: ${company || 'Unknown'}
Industry: ${industry || 'saas'}
Original subject: ${subject}
Original body:
${body.slice(0, 3000)}

Diagnostic score: ${diagnostic.score}/10
Bugs found: ${(diagnostic.bugs || []).map(b => b.name).join(', ')}

Apply all 5 Strategic Flow fixes:
Fix 1: Consequence-first subject line — announces reader's problem, not the product
Fix 2: Preview text that completes the subject thought
Fix 3: Hook that names the consequence the reader is already experiencing
Fix 4: Single CTA with ownership language ("Fix my X →" not "Learn more")
Fix 5: Remove everything that doesn't move the decision

Return ONLY valid JSON:
{
  "rebuiltScore": <number 7-10>,
  "projectedOpenRate": <decimal e.g. 0.29>,
  "abSubjects": [
    { "subject": "<variant 1 — curiosity gap>", "openRate": "<e.g. 29%>" },
    { "subject": "<variant 2 — consequence-first>", "openRate": "<e.g. 31%>" },
    { "subject": "<variant 3 — specific number or name>", "openRate": "<e.g. 28%>" }
  ],
  "rebuiltBody": "<full rebuilt email body as plain HTML, consequence-first>",
  "whatChanged": [
    { "fix": "Fix 1 — Subject line", "before": "<original>", "after": "<rebuilt>", "why": "<one sentence diagnostic reason>" },
    { "fix": "Fix 2 — Preview text", "before": "<original or inferred>", "after": "<rebuilt>", "why": "<reason>" },
    { "fix": "Fix 3 — Hook", "before": "<original first line>", "after": "<rebuilt first line>", "why": "<reason>" },
    { "fix": "Fix 4 — CTA", "before": "<original CTA>", "after": "<rebuilt CTA>", "why": "<reason>" }
  ]
}`;

      const rebuild = await claudeJSON(rebuildPrompt, 2000);
      if (!rebuild) throw new Error('Rebuild failed');

      // STEP 3: CONTENT CALENDAR
      const calendarPrompt = getContentCalendarPrompt(
        company || 'Unknown',
        rebuild.abSubjects?.[0]?.subject || subject,
        rebuild.rebuiltBody || body
      );
      const calendar = await claudeJSON(calendarPrompt, 800);

      try {
        await storeLearning({
          company: company || null,
          industry: industry || null,
          audienceType: null,
          origSubject: subject,
          origBody: body.slice(0, 500),
          rebuiltSubject: (rebuild.abSubjects || [])[1]?.subject || null,
          rebuiltBody: rebuild.rebuiltBody || null,
          whatChanged: rebuild.whatChanged || null,
          tier: 'architecture',
          rebuildPath: null
        });
      } catch (e) {
        console.error('[architecture] storeLearning failed:', e.message);
      }

      const result = {
        score: diagnostic.score,
        rebuiltScore: rebuild.rebuiltScore || 9,
        bugs: diagnostic.bugs || [],
        currentOpenRate: diagnostic.currentOpenRate || 0.18,
        projectedOpenRate: rebuild.projectedOpenRate || 0.30,
        abSubjects: rebuild.abSubjects || [],
        rebuiltBody: rebuild.rebuiltBody || '',
        whatChanged: rebuild.whatChanged || [],
        assessment: diagnostic.assessment || '',
        subscribers: subscribers || 10000,
        emailsPerMonth: emailsPerMonth || 4,
        contentCalendar: calendar?.follow_ups || [],
        calendarWeeks: {
          week1: rebuild.calendarWeek1 || '',
          week2: rebuild.calendarWeek2 || '',
          week3: rebuild.calendarWeek3 || '',
          week4: rebuild.calendarWeek4 || ''
        }
      };

      await setJob(jobId, { status: 'complete', result });

    } catch (err) {
      console.error('[architecture] job failed:', err.message);
      await setJob(jobId, { status: 'failed', error: err.message });
    }
  })();
});
// ─── END ARCHITECTURE ENDPOINT ────────────────────────────────────────────────

// ─── STRIPE INTEGRATION ───────────────────────────────────────────────────────

// POST /stripe/checkout — creează Stripe Checkout Session
app.post('/stripe/checkout', async (req, res) => {
  const { email } = req.body;

  try {
    const sessionParams = {
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1
      }],
      success_url: 'https://strategic-flow-audit.replit.app/stripe/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://strategicflow-tech.github.io/showcase/enterprise.html',
      metadata: { source: 'architecture' }
    };

    if (email && email.includes('@')) {
      sessionParams.customer_email = email.toLowerCase().trim();
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });

  } catch (err) {
    console.error('[stripe/checkout] error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// GET /stripe/success — post-payment redirect page
app.get('/stripe/success', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Payment Successful — Strategic Flow</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Serif+Display:ital@0;1&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0a0a08;
    color: #f4f2ed;
    font-family: 'DM Mono', monospace;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .card {
    max-width: 480px;
    width: 100%;
    border: 1px solid rgba(244,242,237,0.12);
    padding: 48px 40px;
    text-align: center;
  }
  .icon { font-size: 40px; margin-bottom: 24px; display: block; }
  h1 { font-family: 'DM Serif Display', serif; font-size: 32px; margin-bottom: 16px; }
  h1 em { font-style: italic; color: #4A8FE7; }
  p { font-size: 13px; color: #a8a39b; line-height: 1.8; margin-bottom: 12px; }
  p strong { color: #f4f2ed; }
  .divider { height: 1px; background: rgba(244,242,237,0.12); margin: 28px 0; }
  .note { font-size: 12px; color: #6b6760; }
</style>
</head>
<body>
<div class="card">
  <span class="icon">✓</span>
  <h1>You're in.<br><em>Welcome.</em></h1>
  <p>Payment confirmed. Your Strategic Flow Architecture workspace is being set up.</p>
  <p><strong>Check your email</strong> — you'll receive a sign-in link within the next 2 minutes.</p>
  <div class="divider"></div>
  <p class="note">strategicflow@proton.me · strategic-flow-audit.replit.app</p>
</div>
</body>
</html>`);
});

// POST /stripe/webhook — handle Stripe events
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[stripe/webhook] signature verification failed:', err.message);
    return res.status(400).send('Webhook signature verification failed');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email || session.customer_details?.email;

    if (!email) {
      console.error('[stripe/webhook] No email in session:', session.id);
      return res.json({ received: true });
    }

    console.log('[stripe/webhook] New Architecture subscriber:', email);

    try {
      await upsertUser(email, {
        tier: 'architecture',
        vip: true,
        company: session.customer_details?.name || null
      });

      const token = crypto.randomBytes(32).toString('hex');
      const expires = Date.now() + 24 * 60 * 60 * 1000;
      magicTokens.set(token, { email, expires });

      const baseUrl = process.env.APP_URL || 'https://strategic-flow-audit.replit.app';
      const magicLink = `${baseUrl}/auth/verify/${token}`;

      await resend.emails.send({
        from: SENDER,
        to: email,
        subject: 'Welcome to Strategic Flow Architecture — here\'s your access link',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#0a0a08;color:#f4f2ed;padding:48px 40px;border:1px solid rgba(255,255,255,0.1);">
            <p style="font-size:11px;letter-spacing:0.1em;color:#a8a39b;text-transform:uppercase;margin:0 0 40px;">Strategic Flow Architecture</p>
            <h2 style="font-size:28px;margin:0 0 20px;font-weight:600;line-height:1.2;">Your workspace is ready.</h2>
            <p style="font-size:15px;color:#a8a39b;margin:0 0 12px;line-height:1.7;">Click below to sign in. This link is valid for 24 hours.</p>
            <a href="${magicLink}" style="display:inline-block;background:#4A8FE7;color:#ffffff;padding:16px 32px;text-decoration:none;font-size:14px;font-weight:600;margin:24px 0 32px;">
              Access my workspace →
            </a>
            <div style="border-top:1px solid rgba(255,255,255,0.1);padding-top:28px;margin-top:8px;">
              <p style="font-size:13px;color:#a8a39b;margin:0 0 8px;line-height:1.7;"><strong style="color:#f4f2ed;">What happens next:</strong></p>
              <p style="font-size:13px;color:#a8a39b;margin:0 0 6px;line-height:1.7;">→ Sign in and run your first assessment today</p>
              <p style="font-size:13px;color:#a8a39b;margin:0 0 6px;line-height:1.7;">→ Alex will reach out within 24 hours to schedule your onboarding call</p>
              <p style="font-size:13px;color:#a8a39b;margin:0 0 24px;line-height:1.7;">→ Slack access will be set up during onboarding</p>
            </div>
            <p style="font-size:12px;color:#6b6760;margin:0;line-height:1.6;">
              Questions? Reply to this email or reach out at strategicflow@proton.me
            </p>
          </div>
        `
      });

      await notify(
        'New Architecture subscriber — ' + email,
        `<p>New paying client: <strong>${email}</strong></p>
         <p>Stripe session: ${session.id}</p>
         <p>Amount: $${(session.amount_total / 100).toFixed(2)}</p>
         <p>Magic link sent automatically.</p>`
      );

      console.log('[stripe/webhook] Welcome email sent to:', email);

    } catch (err) {
      console.error('[stripe/webhook] post-payment processing failed:', err.message);
    }
  }

  res.json({ received: true });
});

// ─── END STRIPE BLOCK ─────────────────────────────────────────────────────────

// ─── DEMO ENDPOINT ────────────────────────────────────────────────────────────

app.post('/api/demo', async (req, res) => {
  const { email, subject, body, company, subscribers } = req.body;

  if (!email || !subject || !body) {
    return res.status(400).json({ error: 'email, subject and body required' });
  }

  const emailLower = email.toLowerCase().trim();
  const bypass = isAdmin(emailLower);

  if (!bypass) {
    try {
      const r = await pool.query(
        'SELECT audit_count FROM audit_usage WHERE email = $1',
        [emailLower]
      );
      if (r.rows.length > 0 && r.rows[0].audit_count >= 1) {
        return res.json({ alreadyUsed: true });
      }
    } catch (e) {
      console.error('[api/demo] check usage error:', e.message);
    }
  }

  if (!bypass) {
    try {
      await pool.query(`
        INSERT INTO audit_usage (email, audit_count, first_audit_at, last_audit_at)
        VALUES ($1, 1, NOW(), NOW())
        ON CONFLICT (email) DO UPDATE SET
          audit_count = audit_usage.audit_count + 1,
          last_audit_at = NOW()
      `, [emailLower]);
    } catch (e) {
      console.error('[api/demo] record usage error:', e.message);
    }
  }

  const jobId = makeJobId();
  await setJob(jobId, { status: 'pending' });
  res.json({ jobId });

  (async () => {
    try {
      const combinedPrompt = `You are the Strategic Flow diagnostic and rebuild engine.

Company: ${company || 'Unknown'}
Subject: ${subject}
Body: ${body.slice(0, 1000)}

Do BOTH diagnostic and rebuild in one response. Check ALL 7 structural bugs:
1. Filing label subject — subject announces the product, not the reader's problem
2. Caveat opener — email opens with disclaimer/rollout notice before value
3. Feature-first language — describes architecture not reader outcome
4. Flat visual hierarchy — major and minor updates at same visual weight
5. Zero quantified claims — no numbers, benchmarks, or time-saved data
6. Weak or missing CTA — no ownership language ("Learn more" vs "Fix my X")
7. Buried contrast — before/after comparison hidden in fine print or absent

Return ONLY valid JSON:
{
  "score": <number 1-10>,
  "bugs": [
    { "name": "<bug name>", "description": "<specific problem in THIS email, one sentence>" }
  ],
  "currentOpenRate": <decimal e.g. 0.18>,
  "rebuiltScore": <number 7-10>,
  "projectedOpenRate": <decimal e.g. 0.29>,
  "abSubjects": [
    { "subject": "<variant 1 — curiosity gap>", "openRate": "<e.g. 29%>" },
    { "subject": "<variant 2 — consequence-first>", "openRate": "<e.g. 31%>" },
    { "subject": "<variant 3 — number or name>", "openRate": "<e.g. 28%>" }
  ],
  "whatChanged": [
    { "fix": "Fix 1 — Subject line", "before": "<original subject>", "after": "<rebuilt subject>", "why": "<one sentence>" },
    { "fix": "Fix 2 — Preview text", "before": "<original or inferred>", "after": "<rebuilt>", "why": "<one sentence>" },
    { "fix": "Fix 3 — Hook", "before": "<original first line>", "after": "<rebuilt>", "why": "<one sentence>" },
    { "fix": "Fix 4 — CTA", "before": "<original CTA>", "after": "<rebuilt CTA with ownership language>", "why": "<one sentence>" }
  ]
}`;

      const combined = await claudeJSON(combinedPrompt, 1200);
      if (!combined) throw new Error('Assessment failed');

      const diagnostic = combined;
      const rebuild = combined;

      try {
        await notify(
          'New demo — ' + emailLower,
          `<p>Demo run by: <strong>${emailLower}</strong></p>
           <p>Company: ${company || 'Unknown'}</p>
           <p>Subject: "${subject}"</p>
           <p>Score: ${diagnostic.score}/10 → ${rebuild.rebuiltScore}/10</p>
           <p>Subscribers: ${subscribers || 'not provided'}</p>`
        );
      } catch (e) {
        console.error('[api/demo] notify error:', e.message);
      }

      const result = {
        score: diagnostic.score,
        rebuiltScore: rebuild.rebuiltScore || 9,
        bugs: diagnostic.bugs || [],
        currentOpenRate: diagnostic.currentOpenRate || 0.18,
        projectedOpenRate: rebuild.projectedOpenRate || 0.30,
        abSubjects: rebuild.abSubjects || [],
        whatChanged: rebuild.whatChanged || [],
        originalSubject: subject
      };

      await setJob(jobId, { status: 'complete', result });

    } catch (err) {
      console.error('[api/demo] job failed:', err.message);
      await setJob(jobId, { status: 'failed', error: err.message });
    }
  })();
});

// ─── END DEMO ENDPOINT ────────────────────────────────────────────────────────

app.get('/checkout', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: 'https://strategic-flow-audit.replit.app/stripe/success',
      cancel_url: 'https://strategicflow-tech.github.io/showcase/enterprise.html',
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error('[checkout]', err.message);
    res.redirect('https://strategicflow-tech.github.io/showcase/enterprise.html');
  }
});

app.post('/api/demo-sync', async (req, res) => {
  const { email, subject, body, company, subscribers } = req.body;
  if (!email || !subject || !body) return res.status(400).json({ error: 'Missing fields' });
  const emailLower = email.toLowerCase().trim();
  const bypass = isAdmin(emailLower);
  if (!bypass) {
    try {
      const r = await pool.query('SELECT audit_count FROM audit_usage WHERE email = $1', [emailLower]);
      if (r.rows.length > 0 && r.rows[0].audit_count >= 1) return res.json({ alreadyUsed: true });
    } catch(e) {}
    try {
      await pool.query(`INSERT INTO audit_usage (email, audit_count, first_audit_at, last_audit_at) VALUES ($1, 1, NOW(), NOW()) ON CONFLICT (email) DO UPDATE SET audit_count = audit_usage.audit_count + 1, last_audit_at = NOW()`, [emailLower]);
    } catch(e) {}
  }
  const jobId = makeJobId();
  await setJob(jobId, { status: 'pending' });
  res.json({ jobId });
  (async () => {
    try {
      const prompt = `Strategic Flow diagnostic. Return ONLY JSON, no text.
Subject: ${subject}
Body: ${(body || '').slice(0, 300)}
Return ONLY valid JSON:
{
  "score": <1-10>, "rebuiltScore": <7-10>,
  "currentOpenRate": <decimal>, "projectedOpenRate": <decimal>,
  "bugs": [{"name":"<name>","description":"<one sentence>"}],
  "abSubjects": [{"subject":"<v1>","openRate":"<e.g.29%>"},{"subject":"<v2>","openRate":"<e.g.31%>"},{"subject":"<v3>","openRate":"<e.g.28%>"}],
  "whatChanged": [{"fix":"Subject line","before":"<orig>","after":"<rebuilt>","why":"<one sentence>"},{"fix":"Hook","before":"<orig>","after":"<rebuilt>","why":"<one sentence>"},{"fix":"CTA","before":"<orig>","after":"<rebuilt>","why":"<one sentence>"}]
}`;
      const result = await claudeJSON(prompt, 500);
      if (!result) throw new Error('Claude returned null');
      await setJob(jobId, { status: 'complete', result });
      try { await notify('Demo — ' + emailLower, `<p>${emailLower} · score ${result.score}→${result.rebuiltScore}</p>`); } catch(e) {}
    } catch(err) {
      console.error('[api/demo-sync]', err.message);
      await setJob(jobId, { status: 'failed', error: err.message });
    }
  })();
});

// ─── BATCH SINGLE ENDPOINT ────────────────────────────────────────────────────
app.post('/api/batch-single', async (req, res) => {
  if (!req.session || !req.session.userEmail) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const { subject, body } = req.body;

  if (!subject || !body) {
    return res.status(400).json({ error: 'subject and body required' });
  }

  try {
    const prompt = `You are the Strategic Flow diagnostic and rebuild engine.

Subject: ${subject}
Body: ${(body || '').slice(0, 1000)}

Return ONLY valid JSON:
{
  "score": <1-10>,
  "rebuiltScore": <7-10>,
  "currentOpenRate": <decimal e.g. 0.18>,
  "projectedOpenRate": <decimal e.g. 0.29>,
  "bugs": [
    {"name":"<bug name>","description":"<one sentence specific to this email>"}
  ],
  "abSubjects": [
    {"subject":"<best rebuilt subject>","openRate":"<e.g. 31%>"}
  ]
}`;

    const result = await claudeJSON(prompt, 800);
    if (!result) throw new Error('Claude returned null');

    res.json({ result });

  } catch (err) {
    console.error('[api/batch-single]', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── END BATCH SINGLE ENDPOINT ───────────────────────────────────────────────

// ─── MONTHLY REPORT ENDPOINT ─────────────────────────────────────────────────
app.get('/api/monthly-report', async (req, res) => {
  if (!req.session || !req.session.userEmail) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const email = req.session.userEmail;

  try {
    const r = await pool.query(`
      SELECT
        original_subject,
        rebuilt_subject,
        company,
        conversion_score,
        ab_subjects,
        content_calendar,
        created_at
      FROM newsletters
      WHERE email = $1
        AND created_at >= NOW() - INTERVAL '60 days'
      ORDER BY created_at DESC
      LIMIT 100
    `, [email]);

    const rows = r.rows;

    if (rows.length === 0) {
      return res.json({ hasData: false });
    }

    const scores = rows.map(row => {
      try {
        const cs = typeof row.conversion_score === 'string'
          ? JSON.parse(row.conversion_score)
          : row.conversion_score;
        return {
          before: cs?.score || cs?.originalScore || cs?.before || null,
          after: cs?.rebuiltScore || cs?.newScore || cs?.after || null,
          subject: row.original_subject,
          rebuiltSubject: row.rebuilt_subject,
          date: row.created_at,
          company: row.company
        };
      } catch (e) {
        return { before: null, after: null, subject: row.original_subject, date: row.created_at };
      }
    }).filter(s => s.before !== null);

    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const thisMonth = scores.filter(s => new Date(s.date) >= thisMonthStart);
    const lastMonth = scores.filter(s => new Date(s.date) >= lastMonthStart && new Date(s.date) < thisMonthStart);

    const avg = arr => arr.length > 0 ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null;

    const thisAvgBefore = avg(thisMonth.map(s => s.before));
    const thisAvgAfter = avg(thisMonth.map(s => s.after).filter(Boolean));
    const lastAvgBefore = avg(lastMonth.map(s => s.before));
    const lastAvgAfter = avg(lastMonth.map(s => s.after).filter(Boolean));

    const worstThisMonth = [...thisMonth].sort((a, b) => (a.before || 10) - (b.before || 10))[0] || null;
    const bestThisMonth = [...thisMonth].sort((a, b) => ((b.after || 0) - (b.before || 0)) - ((a.after || 0) - (a.before || 0)))[0] || null;

    res.json({
      hasData: true,
      thisMonth: {
        count: thisMonth.length,
        avgScoreBefore: thisAvgBefore,
        avgScoreAfter: thisAvgAfter,
        scores: thisMonth.slice(0, 10)
      },
      lastMonth: {
        count: lastMonth.length,
        avgScoreBefore: lastAvgBefore,
        avgScoreAfter: lastAvgAfter
      },
      trend: {
        direction: thisAvgAfter && lastAvgAfter
          ? parseFloat(thisAvgAfter) > parseFloat(lastAvgAfter) ? 'up' : 'down'
          : 'neutral',
        delta: thisAvgAfter && lastAvgAfter
          ? (parseFloat(thisAvgAfter) - parseFloat(lastAvgAfter)).toFixed(1)
          : null
      },
      worstThisMonth,
      bestThisMonth,
      totalRebuilds: rows.length
    });

  } catch (err) {
    console.error('[api/monthly-report]', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── END MONTHLY REPORT ENDPOINT ─────────────────────────────────────────────

// ─── CALENDAR ENDPOINT ────────────────────────────────────────────────────────
app.get('/api/calendar', async (req, res) => {
  if (!req.session || !req.session.userEmail) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const email = req.session.userEmail;

  try {
    const r = await pool.query(`
      SELECT
        original_subject,
        company,
        conversion_score,
        rebuilt_subject,
        content_calendar,
        key_changes,
        created_at
      FROM newsletters
      WHERE email = $1
        AND content_calendar IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 50
    `, [email]);

    const entries = r.rows.map(row => {
      let contentCalendar = [];
      let calendarWeeks = {};
      let score = null;
      let rebuiltScore = null;

      try {
        const cal = typeof row.content_calendar === 'string'
          ? JSON.parse(row.content_calendar)
          : row.content_calendar;

        if (cal && cal.follow_ups) {
          contentCalendar = cal.follow_ups;
        } else if (Array.isArray(cal)) {
          contentCalendar = cal;
        }
      } catch (e) {}

      try {
        const cs = typeof row.conversion_score === 'string'
          ? JSON.parse(row.conversion_score)
          : row.conversion_score;

        if (cs) {
          score = cs.score || cs.originalScore || cs.before || null;
          rebuiltScore = cs.rebuiltScore || cs.newScore || cs.after || null;
        }
      } catch (e) {}

      try {
        const kc = typeof row.key_changes === 'string'
          ? JSON.parse(row.key_changes)
          : row.key_changes;

        if (kc && kc.calendarWeeks) {
          calendarWeeks = kc.calendarWeeks;
        } else if (kc && kc.week1) {
          calendarWeeks = kc;
        }
      } catch (e) {}

      return {
        originalSubject: row.original_subject,
        company: row.company,
        score,
        rebuiltScore,
        contentCalendar,
        calendarWeeks,
        createdAt: row.created_at
      };
    });

    res.json({ entries });

  } catch (err) {
    console.error('[api/calendar] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── END CALENDAR ENDPOINT ────────────────────────────────────────────────────

// ─── CHANGELOG AUDIT ENDPOINT ─────────────────────────────────────────────────
function getLangInstruction(lang) {
  var map = { en: 'English', es: 'Spanish', sv: 'Swedish', fr: 'French', ro: 'Romanian', de: 'German' };
  var full = map[lang] || 'English';
  return 'Respond entirely in ' + full + '. All diagnostic text, rebuilt content, and explanations must be in ' + full + '.';
}
// CORS is handled globally (line ~86) for strategicflow-tech.github.io.
// This endpoint is intentionally outside PROTECTED_PATHS — no session required.
const CHANGELOG_AUDIT_SYSTEM_PROMPT = `You are the Strategic Flow Changelog Audit engine. Analyze SaaS changelog pages and apply the Strategic Flow Method: 7 structural bug diagnostics and full rebuild. Return ONLY valid JSON, no markdown, no backticks, no preamble.

JSON schema:
{
  "company": "string",
  "original_score": number,
  "rebuilt_score": number,
  "bugs_found": number,
  "original_title": "string",
  "rebuilt_title": "string",
  "original_lead": "string",
  "rebuilt_lead": "string",
  "entry1_title": "string",
  "entry1_before": "string",
  "entry1_after": "string",
  "stat1_num": "string",
  "stat1_label": "string",
  "stat2_num": "string",
  "stat2_label": "string",
  "stat3_num": "string",
  "stat3_label": "string",
  "cta_before": "string",
  "cta_after": "string",
  "before_contrast": "string",
  "after_contrast": "string",
  "wc": [
    {"fix": "string", "before": "string", "after": "string"},
    {"fix": "string", "before": "string", "after": "string"},
    {"fix": "string", "before": "string", "after": "string"},
    {"fix": "string", "before": "string", "after": "string"},
    {"fix": "string", "before": "string", "after": "string"},
    {"fix": "string", "before": "string", "after": "string"},
    {"fix": "string", "before": "string", "after": "string"}
  ],
  "bugs": [{"number": 1, "title": "string", "body": "string"}],
  "fixes": [{"number": 1, "title": "string", "body": "string"}]
}

IMPORTANT: wc array must always contain exactly 7 objects, one for each of the 7 bugs diagnosed. Each object must have all three fields populated with non-empty strings:
- fix: the name of the structural fix applied (e.g. 'Consequence-first title')
- before: a short quote or paraphrase of the original problematic text
- after: the rebuilt version of that same element
Never return empty strings for any wc field. If the original content does not have a clear before/after for a specific bug, synthesize a representative example based on the content provided.

CRITICAL LANGUAGE RULE: You will receive a language instruction at the start of this prompt. Every single string value in your JSON output must be written in that language — including titles, hooks, CTAs, bug titles, bug descriptions, fix descriptions, rebuilt content, before/after fields, and all wc/bugs/fixes array items. The structural examples above are templates only. Do not reproduce their English wording. Translate everything into the specified language.

The 7 bugs: 1. Filing Label Title 2. No Lead Consequence 3. Feature-First Language 4. Flat Hierarchy 5. Zero Numbers 6. Dead-End CTA 7. Buried Before/After.`;

app.get('/changelog-audit-test', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.json({ status: 'ok', message: 'changelog audit endpoint is live' });
});

app.get('/clear-test', (req, res) => {
  const page = req.query.page === 'onboarding' ? '/onboarding-audit-page' : '/changelog-audit-page';
  res.send(`<!DOCTYPE html><html><body><script>localStorage.clear();window.location.href="${page}";<\/script></body></html>`);
});

app.get('/changelog-audit-page', (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:");
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'changelog-audit.html'));
});

app.post('/changelog-audit/check-email', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const email = (req.body.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const PAYING_TIERS = ['architecture', 'lite', 'growth', 'high_impact'];

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS changelog_audit_leads (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        allowed_download BOOLEAN DEFAULT FALSE
      )
    `);

    let allowed = false;
    let tier = null;

    if (isAdmin(email)) {
      allowed = true;
      tier = 'admin';
    } else {
      const user = await getUser(email);
      if (user && PAYING_TIERS.includes(user.tier)) {
        allowed = true;
        tier = user.tier;
      }
    }

    await pool.query(
      `INSERT INTO changelog_audit_leads (email, allowed_download)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [email, allowed]
    );

    if (!allowed) {
      const source = (req.body.source || 'audit_gate').replace(/[<>]/g, '');
      const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
      resend.emails.send({
        from: 'Strategic Flow <onboarding@resend.dev>',
        to: 'strategicflow@proton.me',
        subject: `New audit lead — ${email} via ${source}`,
        text: `New lead captured:\n\nEmail: ${email}\nSource: ${source}\nDate: ${dateStr}\nTier: free\n\nAction needed: send pitch within 24h.`
      }).catch(err => console.error('[lead-notify]', err.message));
    }

    return res.json({ allowed, tier });
  } catch (e) {
    console.error('[changelog-audit/check-email]', e.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/onboarding-audit/check-email', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const email = (req.body.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const PAYING_TIERS = ['architecture', 'lite', 'growth', 'high_impact'];

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS onboarding_audit_leads (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        allowed_download BOOLEAN DEFAULT FALSE
      )
    `);

    let allowed = false;
    let tier = null;

    if (isAdmin(email)) {
      allowed = true;
      tier = 'admin';
    } else {
      const user = await getUser(email);
      if (user && PAYING_TIERS.includes(user.tier)) {
        allowed = true;
        tier = user.tier;
      }
    }

    await pool.query(
      `INSERT INTO onboarding_audit_leads (email, allowed_download)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [email, allowed]
    );

    if (!allowed) {
      const source = (req.body.source || 'onboarding_audit_gate').replace(/[<>]/g, '');
      const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
      resend.emails.send({
        from: 'Strategic Flow <onboarding@resend.dev>',
        to: 'strategicflow@proton.me',
        subject: `New audit lead — ${email} via ${source}`,
        text: `New lead captured:\n\nEmail: ${email}\nSource: ${source}\nDate: ${dateStr}\nTier: free\n\nAction needed: send pitch within 24h.`
      }).catch(err => console.error('[lead-notify]', err.message));
    }

    return res.json({ allowed, tier });
  } catch (e) {
    console.error('[onboarding-audit/check-email]', e.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.options('/changelog-audit', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

app.post('/changelog-audit', async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).send('');
    return;
  }
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  console.log('CHANGELOG AUDIT HIT - body:', JSON.stringify(req.body));
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.json({ error: 'No body received', received: req.body });
  }
  const { url, text: rawText, lang } = req.body;
  if (!rawText || rawText.length < 50) {
    return res.status(400).json({ error: 'No text provided' });
  }

  let content = rawText.trim();

  // If text is short and a URL was provided, attempt server-side fetch
  if (content.length < 100 && url) {
    console.log('[changelog-audit] text too short, fetching URL:', url);
    try {
      const page = await fetchWithCache(url);
      if (page && page.text && page.text.length >= 100) {
        content = [
          page.title ? `Title: ${page.title}` : '',
          page.meta  ? `Description: ${page.meta}` : '',
          page.text,
        ].filter(Boolean).join('\n\n');
        console.log('[changelog-audit] fetched content length:', content.length);
      }
    } catch (fetchErr) {
      console.error('[changelog-audit] fetch failed:', fetchErr.message);
    }
  }

  // Only block if URL was provided but fetch still failed to get enough content
  if (content.length < 100 && url) {
    const errBody = { error: 'Could not fetch URL content. The site may be blocking automated requests.' };
    console.log('[changelog-audit] response (422):', JSON.stringify(errBody));
    return res.status(422).json(errBody);
  }

  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: getLangInstruction(lang) + '\n\n' + CHANGELOG_AUDIT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Analyze this SaaS changelog page:\n\n${content.slice(0, 8000)}` }],
    });

    const raw = (response.content[0].text || '').trim().replace(/^```json\s*|^```\s*|```$/g, '').trim();
    const result = safeParseJSON(raw);
    if (!result) {
      console.error('[changelog-audit] JSON parse failed. Raw:', raw.slice(0, 300));
      return res.status(500).json({ error: 'Claude returned invalid JSON' });
    }
    console.log('CHANGELOG RESPONSE:', JSON.stringify(result, null, 2));
    console.log('[changelog-audit] response (200): company=', result.company, 'bugs_found=', result.bugs_found);
    res.json(result);
  } catch (err) {
    console.error('[changelog-audit] Claude error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── END CHANGELOG AUDIT ENDPOINT ─────────────────────────────────────────────

// ─── ONBOARDING AUDIT ENDPOINT ────────────────────────────────────────────────
const ONBOARDING_AUDIT_SYSTEM_PROMPT = `You are the Strategic Flow Onboarding Audit engine. Analyze SaaS onboarding copy and return ONLY a valid JSON object. No markdown, no backticks, no explanation.

CRITICAL LANGUAGE RULE: You will receive a language instruction at the start of this prompt. Every single string value in your JSON output must be written in that language — including titles, hooks, CTAs, bug titles, bug descriptions, fix descriptions, rebuilt content, before/after fields, and all wc/bugs/fixes array items. The structural examples below are templates only. Do not reproduce their English wording. Translate everything into the specified language.

JSON fields: company, original_score, rebuilt_score, bugs_found, original_title, rebuilt_title, original_lead, rebuilt_lead, entry1_title, entry1_before, entry1_after, stat1_num, stat1_label, stat2_num, stat2_label, stat3_num, stat3_label, cta_before, cta_after, before_contrast, after_contrast, wc (array of 7 objects with fix/before/after), bugs (array of 7 with number/title/body), fixes (array of 7 with number/title/body).

IMPORTANT: wc array must always contain exactly 7 objects, one for each of the 7 bugs diagnosed. Each object must have all three fields populated with non-empty strings:
- fix: the name of the structural fix applied (e.g. 'Consequence-first title')
- before: a short quote or paraphrase of the original problematic text
- after: the rebuilt version of that same element
Never return empty strings for any wc field. If the original content does not have a clear before/after for a specific bug, synthesize a representative example based on the content provided.

Scores 1-10. Diagnose these 7 bugs: 1.Welcome Without Consequence 2.Useless Progress Indicator 3.Generic CTA 4.Empty State Without Direction 5.Feature Not Outcome 6.Too Many Steps Before Value 7.Invisible Microcopy.`;

app.get('/onboarding-audit-page', (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:");
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'onboarding-audit.html'));
});

app.options('/onboarding-audit', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

app.post('/onboarding-audit', async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).send('');
    return;
  }
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  console.log('ONBOARDING AUDIT HIT - body:', JSON.stringify(req.body));
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.json({ error: 'No body received', received: req.body });
  }
  const { url, text: rawText, lang } = req.body;
  if (!rawText || rawText.length < 50) {
    return res.status(400).json({ error: 'No text provided' });
  }

  let content = rawText.trim();

  if (content.length < 100 && url) {
    console.log('[onboarding-audit] text too short, fetching URL:', url);
    try {
      const page = await fetchWithCache(url);
      if (page && page.text && page.text.length >= 100) {
        content = [
          page.title ? `Title: ${page.title}` : '',
          page.meta  ? `Description: ${page.meta}` : '',
          page.text,
        ].filter(Boolean).join('\n\n');
        console.log('[onboarding-audit] fetched content length:', content.length);
      }
    } catch (fetchErr) {
      console.error('[onboarding-audit] fetch failed:', fetchErr.message);
    }
  }

  if (content.length < 100 && url) {
    const errBody = { error: 'Could not fetch URL content. The site may be blocking automated requests.' };
    console.log('[onboarding-audit] response (422):', JSON.stringify(errBody));
    return res.status(422).json(errBody);
  }

  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: getLangInstruction(lang) + '\n\n' + ONBOARDING_AUDIT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Analyze this SaaS onboarding copy:\n\n${content.slice(0, 8000)}` }],
    });

    const raw = (response.content[0].text || '').trim().replace(/^```json\s*|^```\s*|```$/g, '').trim();
    const result = safeParseJSON(raw);
    if (!result) {
      console.error('[onboarding-audit] JSON parse failed. Raw:', raw.slice(0, 300));
      return res.status(500).json({ error: 'Claude returned invalid JSON' });
    }
    console.log('[onboarding-audit] response (200): company=', result.company, 'bugs_found=', result.bugs_found);
    res.json(result);
  } catch (err) {
    console.error('[onboarding-audit] Claude error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── END ONBOARDING AUDIT ENDPOINT ───────────────────────────────────────────

// ─── LINKEDIN AUDIT ENDPOINT ──────────────────────────────────────────────────
const LINKEDIN_AUDIT_SYSTEM_PROMPT = `You are the Strategic Flow LinkedIn Post Audit engine. Analyze SaaS LinkedIn posts and apply the Strategic Flow Method: 7 structural bug diagnostics and full rebuild. Return ONLY valid JSON, no markdown, no backticks, no preamble.

Use the same JSON schema as /changelog-audit. JSON fields: company, original_score, rebuilt_score, bugs_found, original_title, rebuilt_title, original_lead, rebuilt_lead, entry1_title, entry1_before, entry1_after, stat1_num, stat1_label, stat2_num, stat2_label, stat3_num, stat3_label, cta_before, cta_after, before_contrast, after_contrast, wc (array of 7 objects with fix/before/after), bugs (array of 7 with number/title/body), fixes (array of 7 with number/title/body). Scores 1-10.

IMPORTANT: wc array must always contain exactly 7 objects, one for each of the 7 bugs diagnosed. Each object must have all three fields populated with non-empty strings:
- fix: the name of the structural fix applied (e.g. 'Consequence-first title')
- before: a short quote or paraphrase of the original problematic text
- after: the rebuilt version of that same element
Never return empty strings for any wc field. If the original content does not have a clear before/after for a specific bug, synthesize a representative example based on the content provided.

CRITICAL LANGUAGE RULE: You will receive a language instruction at the start of this prompt. Every single string value in your JSON output must be written in that language — including titles, hooks, CTAs, bug titles, bug descriptions, fix descriptions, rebuilt content, before/after fields, and all wc/bugs/fixes array items. The structural examples above are templates only. Do not reproduce their English wording. Translate everything into the specified language.

The 7 bugs:
1. Hook Without Consequence — first line announces feature or company, not reader's operational problem
2. Feature-First Body — describes what product does technically, not what user no longer has to do
3. Zero Specificity — no numbers, no benchmarks, no concrete verifiable claims
4. Wall of Text — paragraphs too long, no white space, no rhythm
5. Absent or Generic CTA — no clear direction or "Link in comments" without context
6. No Proof No Stakes — no real client, no impact number, no consequence of not acting
7. Wrong Audience Signal — written for everyone, ideal reader does not recognize themselves`;

app.get('/linkedin-audit-page', (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:");
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'linkedin-audit.html'));
});

app.options('/linkedin-audit', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

app.post('/linkedin-audit', async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).send('');
    return;
  }
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  console.log('LINKEDIN AUDIT HIT - body:', JSON.stringify(req.body));
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.json({ error: 'No body received', received: req.body });
  }
  const { url, text: rawText, lang } = req.body;
  if (!rawText || rawText.length < 50) {
    return res.status(400).json({ error: 'No text provided' });
  }

  let content = rawText.trim();

  if (content.length < 100 && url) {
    console.log('[linkedin-audit] text too short, fetching URL:', url);
    try {
      const page = await fetchWithCache(url);
      if (page && page.text && page.text.length >= 100) {
        content = [
          page.title ? `Title: ${page.title}` : '',
          page.meta  ? `Description: ${page.meta}` : '',
          page.text,
        ].filter(Boolean).join('\n\n');
        console.log('[linkedin-audit] fetched content length:', content.length);
      }
    } catch (fetchErr) {
      console.error('[linkedin-audit] fetch failed:', fetchErr.message);
    }
  }

  if (content.length < 100 && url) {
    const errBody = { error: 'Could not fetch URL content. The site may be blocking automated requests.' };
    console.log('[linkedin-audit] response (422):', JSON.stringify(errBody));
    return res.status(422).json(errBody);
  }

  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: getLangInstruction(lang) + '\n\n' + LINKEDIN_AUDIT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Analyze this LinkedIn post:\n\n${content.slice(0, 8000)}` }],
    });

    const raw = (response.content[0].text || '').trim().replace(/^```json\s*|^```\s*|```$/g, '').trim();
    const result = safeParseJSON(raw);
    if (!result) {
      console.error('[linkedin-audit] JSON parse failed. Raw:', raw.slice(0, 300));
      return res.status(500).json({ error: 'Claude returned invalid JSON' });
    }
    console.log('[linkedin-audit] response (200): company=', result.company, 'bugs_found=', result.bugs_found);
    res.json(result);
  } catch (err) {
    console.error('[linkedin-audit] Claude error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── END LINKEDIN AUDIT ENDPOINT ─────────────────────────────────────────────

setupDB().then(async () => {
  await runMonthlyAudit();
  const PORT = process.env.PORT || 3000;

  app.use((req, res, next) => {
    res.setTimeout(180000);
    next();
  });

  const server = app.listen(PORT, '0.0.0.0', () => console.log(`[server] Strategic Flow ready on :${PORT} — model: ${MODEL}`));
  server.timeout = 180000;
  server.keepAliveTimeout = 180000;

  // Keep-alive ping every 4 minutes
  if (process.env.APP_URL) {
    setInterval(async () => {
      try {
        await fetch(process.env.APP_URL + '/auth/me');
      } catch(e) {}
    }, 4 * 60 * 1000);
  }
}).catch(e => { console.error('[startup]', e); process.exit(1); });

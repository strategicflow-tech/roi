// server.js — Activation Intelligence
// Node.js + Express + PostgreSQL + Resend + Anthropic + Stripe

'use strict';

const express      = require('express');
const session      = require('express-session');
const connectPg    = require('connect-pg-simple')(session);
const { Pool }     = require('pg');
const Anthropic    = require('@anthropic-ai/sdk');
const { Resend }   = require('resend');
const Stripe       = require('stripe');
const crypto       = require('crypto');
const path         = require('path');

const app     = express();
const pool    = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const ai      = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend  = new Resend(process.env.RESEND_API_KEY);
const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY || '');

const SENDER      = 'noreply@strategicflow.cc';
const BASE_URL    = process.env.APP_URL || 'https://strategic-flow-activation.replit.app';
const MODEL       = 'claude-sonnet-5';

// In-memory magic link token store
const magicTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of magicTokens) { if (v.expires < now) magicTokens.delete(k); }
}, 5 * 60 * 1000);

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────

// Stripe webhook needs raw body — must be before express.json()
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new connectPg({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'sf-activation-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));

app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE SETUP ────────────────────────────────────────────────────────────

async function setupDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      email       TEXT UNIQUE NOT NULL,
      tier        TEXT DEFAULT 'free',
      access_type TEXT,
      expires_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      usage_count INTEGER DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sequences (
      id           SERIAL PRIMARY KEY,
      user_email   TEXT NOT NULL,
      uploaded_at  TIMESTAMPTZ DEFAULT NOW(),
      raw_content  TEXT,
      goal         TEXT,
      days         TEXT,
      status       TEXT DEFAULT 'processing',
      result_json  JSONB
    )
  `);
  console.log('[DB] Tables ready');
}

// ── AUTH HELPERS ──────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session && req.session.email) return next();
  if (req.accepts('html')) return res.redirect('/login.html');
  return res.status(401).json({ error: 'Unauthorized' });
}

async function ensureUser(email) {
  await pool.query(
    `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
    [email.toLowerCase().trim()]
  );
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────

// POST /auth/magic — send magic link
app.post('/auth/magic', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  magicTokens.set(token, { email, expires: Date.now() + 15 * 60 * 1000 });

  const link = `${BASE_URL}/auth/verify/${token}`;

  try {
    await resend.emails.send({
      from: SENDER,
      to: email,
      subject: 'Your Activation Intelligence sign-in link',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0a0a08;color:#f4f2ed;padding:40px 32px;border:1px solid rgba(255,255,255,0.1);">
          <p style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#6b6760;margin:0 0 32px;">Activation Intelligence</p>
          <p style="font-size:15px;color:#a8a39b;margin:0 0 24px;line-height:1.7;">Click below to sign in. This link expires in 15 minutes.</p>
          <a href="${link}" style="display:inline-block;background:#4A8FE7;color:#ffffff;padding:16px 32px;text-decoration:none;font-size:14px;font-weight:600;">
            Sign in →
          </a>
          <p style="font-size:12px;color:#6b6760;margin:28px 0 0;line-height:1.6;">If you didn't request this, ignore this email.</p>
        </div>
      `
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth/magic] email send error:', err.message);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// GET /auth/verify/:token — validate token, set session
app.get('/auth/verify/:token', async (req, res) => {
  const entry = magicTokens.get(req.params.token);
  if (!entry || entry.expires < Date.now()) {
    return res.redirect('/login.html?error=expired');
  }
  magicTokens.delete(req.params.token);
  await ensureUser(entry.email);
  req.session.email = entry.email;
  res.redirect('/dashboard');
});

// GET /auth/me — session check
app.get('/auth/me', (req, res) => {
  if (req.session && req.session.email) {
    return res.json({ signedIn: true, email: req.session.email });
  }
  res.json({ signedIn: false });
});

// POST /auth/logout
app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ── PAGE ROUTES ───────────────────────────────────────────────────────────────

// GET / — redirect to login or dashboard
app.get('/', (req, res) => {
  if (req.session && req.session.email) return res.redirect('/dashboard');
  res.redirect('/login.html');
});

// GET /dashboard
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// GET /upload
app.get('/upload', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'upload.html'));
});

// GET /results/:id
app.get('/results/:id', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'results.html'));
});

// ── SEQUENCE API ──────────────────────────────────────────────────────────────

// GET /api/sequences — list sequences for logged-in user
app.get('/api/sequences', requireAuth, async (req, res) => {
  const email = req.session.email;
  try {
    const result = await pool.query(
      `SELECT id, uploaded_at, raw_content, status FROM sequences
       WHERE user_email = $1 ORDER BY uploaded_at DESC LIMIT 50`,
      [email]
    );
    res.json({ sequences: result.rows });
  } catch (err) {
    console.error('[api/sequences] error:', err.message);
    res.status(500).json({ error: 'Failed to load sequences' });
  }
});

// GET /api/sequences/:id — get single sequence result
app.get('/api/sequences/:id', requireAuth, async (req, res) => {
  const email = req.session.email;
  try {
    const result = await pool.query(
      `SELECT id, uploaded_at, raw_content, goal, status, result_json
       FROM sequences WHERE id = $1 AND user_email = $2`,
      [req.params.id, email]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[api/sequences/:id] error:', err.message);
    res.status(500).json({ error: 'Failed to load sequence' });
  }
});

// POST /upload — save sequence and trigger analysis
app.post('/upload', requireAuth, async (req, res) => {
  const email    = req.session.email;
  const sequence = (req.body.sequence || '').trim();
  const goal     = (req.body.goal || '').trim();
  const days     = (req.body.days || '').trim();

  if (!sequence || sequence.length < 50) {
    return res.status(400).json({ error: 'Sequence content too short' });
  }

  try {
    const insert = await pool.query(
      `INSERT INTO sequences (user_email, raw_content, goal, days, status)
       VALUES ($1, $2, $3, $4, 'processing') RETURNING id`,
      [email, sequence, goal || null, days || null]
    );
    const id = insert.rows[0].id;

    // Increment usage count
    await pool.query(`UPDATE users SET usage_count = usage_count + 1 WHERE email = $1`, [email]);

    // Kick off async analysis (don't await — return id immediately)
    runAnalysis(id, sequence, goal, days).catch(err => {
      console.error('[analysis] async error for id', id, ':', err.message);
    });

    res.json({ id });
  } catch (err) {
    console.error('[upload] error:', err.message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ── ANALYSIS ENGINE ───────────────────────────────────────────────────────────

async function runAnalysis(id, sequence, goal, days) {
  const prompt = `You are the Activation Intelligence engine.
Analyze this onboarding email sequence and deliver a full activation diagnostic.

SEQUENCE:
${sequence}

ACTIVATION GOAL: ${goal || 'Not specified'}
SEQUENCE DURATION: ${days || 'Not specified'}

Deliver your analysis in this exact JSON structure (no markdown, no code fences — raw JSON only):
{
  "health_score": <number 1-10>,
  "gaps": [
    {
      "position": "between email X and email Y",
      "severity": "CRITICAL|MAJOR|MINOR",
      "description": "what the reader experiences here",
      "missing_email_brief": {
        "title": "",
        "goal": "",
        "subject_variants": ["", "", ""],
        "hook_direction": "",
        "cta": ""
      }
    }
  ],
  "failure_patterns": [
    {
      "email_number": <number>,
      "pattern": "Feature-First Bias|Filing Label Subject|Consequence-After-Caveat|Missing Hierarchy|Zero Social Proof|Generic Urgency Theatre|CTA Fatigue",
      "severity": "CRITICAL|MAJOR|MINOR",
      "exact_line": "the exact line that triggers it",
      "fix": "one sentence fix"
    }
  ],
  "cta_fatigue": {
    "verdict": "FATIGUED|VARIED|CRITICAL",
    "repeated_verbs": ["verb1", "verb2"],
    "affected_emails": [1, 2, 3]
  },
  "rebuilt_emails": [
    {
      "email_number": <number>,
      "original_subject": "",
      "rebuilt_subject": "",
      "rebuilt_preview": "",
      "rebuilt_body": "",
      "rebuilt_cta": ""
    }
  ],
  "psychology_map": [
    {
      "day": "Day 1|Day 3|Day 7",
      "user_thought": "",
      "friction": "",
      "objection": ""
    }
  ],
  "recommended_first_fix": "exact pattern name and exact email number"
}`;

  try {
    const message = await ai.messages.create({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0]?.text || '';
    let parsed;
    try {
      // Strip any accidental markdown fences
      const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      console.error('[analysis] JSON parse failed for id', id, ':', e.message);
      console.error('[analysis] raw response:', raw.substring(0, 500));
      await pool.query(`UPDATE sequences SET status = 'error' WHERE id = $1`, [id]);
      return;
    }

    await pool.query(
      `UPDATE sequences SET status = 'done', result_json = $1 WHERE id = $2`,
      [JSON.stringify(parsed), id]
    );
    console.log('[analysis] completed for id:', id);

  } catch (err) {
    console.error('[analysis] Claude error for id', id, ':', err.message);
    await pool.query(`UPDATE sequences SET status = 'error' WHERE id = $1`, [id]);
  }
}

// ── STRIPE WEBHOOK ────────────────────────────────────────────────────────────

app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[webhook/stripe] signature verification failed:', err.message);
    return res.status(400).send('Webhook signature verification failed');
  }

  console.log('[webhook/stripe] received event:', event.type);

  // Always 200 immediately
  res.json({ received: true });

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email   = session.customer_email || session.customer_details?.email;

      if (!email) {
        console.error('[webhook/stripe] checkout — no email in session:', session.id);
        return;
      }

      const amount = session.amount_total;
      let tier = 'activation_one_time';
      if (amount === 15000) tier = 'activation_retainer';  // $150
      else if (amount === 35000) tier = 'activation_one_time'; // $350

      console.log('[webhook/stripe] checkout completed — email:', email, 'tier:', tier, 'amount:', amount);

      await pool.query(
        `INSERT INTO users (email, tier, access_type)
         VALUES ($1, $2, $2)
         ON CONFLICT (email) DO UPDATE SET tier = $2, access_type = $2, expires_at = NULL`,
        [email.toLowerCase().trim(), tier]
      );

      await resend.emails.send({
        from: SENDER,
        to: email,
        subject: 'Your Activation Intelligence access is ready',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;padding:40px 32px;">
            <p style="margin:0 0 16px;">Hi,</p>
            <p style="margin:0 0 16px;">Your access is ready. Log in here:<br>
              <a href="${BASE_URL}/login.html" style="color:#4A8FE7;">${BASE_URL}/login.html</a>
            </p>
            <p style="margin:0 0 16px;">Enter this email address and click the magic link we send you.</p>
            <p style="margin:0 0 16px;">Questions? Reply to this email.</p>
            <p style="margin:0;">Alex<br>Strategic Flow</p>
          </div>`
      });

      console.log('[webhook/stripe] welcome email sent to:', email);

    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      let email = null;
      try {
        const customer = await stripe.customers.retrieve(sub.customer);
        email = customer.deleted ? null : customer.email;
      } catch (e) {
        console.error('[webhook/stripe] customer lookup failed:', e.message);
      }

      if (!email) {
        console.error('[webhook/stripe] subscription.deleted — no email for customer:', sub.customer);
        return;
      }

      await pool.query(
        `UPDATE users SET tier = 'expired', expires_at = NOW() WHERE email = $1`,
        [email.toLowerCase().trim()]
      );

      await resend.emails.send({
        from: SENDER,
        to: email,
        subject: 'Your Activation Intelligence subscription has been cancelled',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;padding:40px 32px;">
            <p style="margin:0 0 16px;">Your Activation Intelligence subscription has been cancelled. Your access has been removed.</p>
            <p style="margin:0 0 16px;">Reply to this email if this was a mistake.</p>
            <p style="margin:0;">Alex<br>Strategic Flow</p>
          </div>`
      });

      console.log('[webhook/stripe] subscription cancelled, tier expired for:', email);

    } else {
      console.log('[webhook/stripe] unhandled event (ignored):', event.type);
    }

  } catch (err) {
    console.error('[webhook/stripe] internal error (200 already sent):', err.message);
  }
});

// ── START ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
setupDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] Activation Intelligence ready on :${PORT}`);
  });
}).catch(err => {
  console.error('[server] DB setup failed:', err.message);
  process.exit(1);
});

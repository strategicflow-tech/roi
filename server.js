// server.js — Strategic Flow Multi-Tier SaaS Platform
'use strict';

const express    = require('express');
const { Pool }   = require('pg');
const Anthropic  = require('@anthropic-ai/sdk');
const { Resend } = require('resend');

const {
  TIER_CONFIGS, getAuditPrompt, getABSubjectsPrompt, getConversionScorePrompt,
  getAudienceSegmentsPrompt, getContentCalendarPrompt, getCohesionCheckPrompt,
  getEmailTypePrompt, getVoiceAnalysisPrompt,
  getEmailScorePrompt, getMicroImprovementsPrompt,
  getWeaknessVerifyPrompt, getSectionPatchPrompt, getPromoGridSubjectHeroPrompt
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

// ── IN-MEMORY JOB STORE (for polling-based generation) ──────────────────────
// Each job: { status:'pending'|'complete'|'failed', result, error, created }
const jobs = new Map();
function makeJobId() { return Math.random().toString(36).slice(2,10) + Date.now().toString(36); }
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs) { if (job.created < cutoff) jobs.delete(id); }
}, 10 * 60 * 1000);

app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

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
  // Add new columns to existing tables without breaking existing rows
  await pool.query(`
    ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS key_changes JSONB;
    ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS conversion_hook TEXT;
    ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS original_score JSONB;
    ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS rebuild_path VARCHAR(20);
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
    .replace(/[^\x00-\x7F]/g, ' ');   // ALL remaining non-ASCII → space (not empty)
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
  // Layer 4: all attempts failed — return null so callers can show a clean error
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
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const msg = await claude.messages.create({
        model: MODEL, max_tokens: maxTokens,
        system: JSON_SYSTEM_INSTRUCTION,
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = msg.content[0].text.trim();
      return safeParseJSON(raw);
    } catch (err) {
      if (attempt === 1) {
        console.error('[claudeJSON] both attempts failed:', err.message);
        return null; // callers must check for null and surface a user-facing error
      }
      await new Promise(r => setTimeout(r, 400));
    }
  }
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
    .replace(/color:\s*#222222/g,                   'color:#f0f0f0')
    .replace(/color:\s*#333333/g,                   'color:#e0e0e0')
    .replace(/color:\s*#333\b/g,                    'color:#e0e0e0')
    .replace(/color:\s*#1a1a1a/g,                   'color:#ffffff')
    .replace(/color:\s*#555555/g,                   'color:#aaaaaa')
    .replace(/color:\s*#555\b/g,                    'color:#aaaaaa')
    .replace(/color:\s*#777777/g,                   'color:#888888')
    .replace(/background:\s*#f5f5f5/g,              'background:#1e1e1e')
    .replace(/background-color:\s*#f5f5f5/g,        'background-color:#1e1e1e')
    .replace(/background:\s*#ffffff/gi,             'background:#111111')
    .replace(/background:\s*#fff\b/gi,              'background:#111111')
    .replace(/background:\s*white\b/gi,             'background:#111111')
    .replace(/background-color:\s*#ffffff/gi,       'background-color:#111111')
    .replace(/background-color:\s*#fff\b/gi,        'background-color:#111111')
    .replace(/bgcolor=["']#?(?:ffffff|fff|white)["']/gi, 'bgcolor="#111111"')
    .replace(/height:1px;background:#e0e0e0/g,      'height:1px;background:#2a2a2a');
}

// Strip Resend click-tracking wrappers from HTML links after generation.
// Resend may still wrap hrefs server-side despite clickTracking:false — this is a
// post-generation safety net so the downloaded HTML always has clean, original URLs.
function stripResendTracking(html) {
  if (!html) return html;
  return html.replace(
    /https?:\/\/[a-z0-9-]+\.resend-clicks\.com\/CL[^"'\s]*/g,
    (match) => {
      try {
        const decoded = decodeURIComponent(match);
        // Find the first non-Resend URL embedded inside the wrapper
        const urlMatch = decoded.match(/https?:\/\/(?!(?:[a-z0-9-]+\.)?resend)[^\s"']+/);
        return urlMatch ? urlMatch[0] : match;
      } catch (_) { return match; }
    }
  );
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

function buildNewsletterHTML(company, subject, body, brandDNA, options = {}) {
  // Guard all critical inputs — never render the string "undefined" or "null" in output HTML
  company = safeVal(company) || 'Your Company';
  subject = safeVal(subject);
  body    = safeVal(body);
  // Abort immediately if either critical field is blank — caller should have already validated
  if (!subject && !body) return '<!-- buildNewsletterHTML: missing subject and body -->';
  const { tier = 'free_trial', originalBody = '', ctaHref = 'https://strategic-flow-audit.replit.app', heroKeyword = '', contentStyle = '' } = options;
  const { primaryColor, accentColor, bgColor, containerBg, textColor, mutedText, cardBg, dividerColor, primaryText, accentText, isDark, headerBg, headerText } = getEmailColors(brandDNA);

  // Header content: show logo OR company name — never both.
  // brandDNA.logo has already been verified (HEAD request) in the route handler before this
  // function is called — if the URL was broken, logo was set to null upstream.
  const logoInHeader = (() => {
    if (brandDNA?.logoSvg) {
      const svgConstrained = brandDNA.logoSvg
        .replace(/\s(width|height)=["'][^"']*["']/gi, '')
        .replace('<svg', '<svg height="40" style="display:inline-block;vertical-align:middle;"');
      return `<div style="text-align:center;line-height:1;">${svgConstrained}</div>`;
    }
    if (brandDNA?.logo) {
      // URL already verified valid by verifyImageUrl() in the route handler
      return `<img src="${brandDNA.logo}" alt="${company} logo" style="max-height:40px;width:auto;display:block;margin:0 auto;" />`;
    }
    return '';
  })();
  // Show company name text only when no verified logo is available
  const headerContent = logoInHeader
    ? logoInHeader
    : `<span style="font-size:20px;font-weight:700;color:${headerText};">${company}</span>`;

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
  // Use og:image from the fetched URL when available — it's always the article's real cover.
  // Fall back to the topic/industry keyword-matched Unsplash image otherwise.
  const heroSrc = options.heroImageUrl || buildHeroSrc(company, brandDNA, options.heroKeyword);
  const heroRow = `<tr>
  <td align="center" valign="top" style="padding:0;margin:0;font-size:0;line-height:0;border-collapse:collapse;">
    <img src="${heroSrc}" width="620" height="300" border="0" alt="${company}" style="display:block;width:620px;height:300px;max-width:620px;min-width:620px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />
  </td>
</tr>`;

  // Footer logo (small, centered)
  const footerLogo = brandDNA?.logo
    ? `<img src="${brandDNA.logo}" alt="${company}" style="max-height:32px;display:block;margin:0 auto 10px;" />`
    : '';

  // Footer colors defined early — also used by the promotional-grid wave divider
  const footerBg     = isDark ? '#111111' : '#f4f4f7';
  const footerBorder = isDark ? '#2a2a2a' : '#e8e8e8';
  const footerText   = isDark ? '#888888' : '#999999';
  const footerMuted  = isDark ? '#666666' : '#bbbbbb';

  // If Claude returned structured HTML (new format), inject it directly after substituting
  // the CTABGCOLOR / CTATEXTCOLOR placeholders with real brand colours.
  // Otherwise fall back to the legacy newline-based formatter.
  const rawBody = (body || '').trim();
  const isHtmlBody = rawBody.startsWith('<');

  let bodyContent;
  if (isHtmlBody) {
    let processed = rawBody
      .replace(/CTABGCOLOR/g, primaryColor)
      .replace(/CTATEXTCOLOR/g, primaryText)
      .replace(/href="#" target="_blank"/g, `href="${ctaHref}" target="_blank"`);
    // For longform or steps content, strip any emoji box tables Claude may have added despite instructions
    if (contentStyle === 'longform' || contentStyle === 'steps') {
      processed = stripEmojiBoxTables(processed);
    }
    if (isDark) processed = adaptBodyForDarkTheme(processed);
    bodyContent = processed;
  } else {
    // Legacy plain-text path — split, detect CTA, format paragraphs
    const lines = rawBody.split('\n').map(l => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] || '';
    const looksLikeCTA = lastLine.length > 0 && lastLine.length < 80 && !lastLine.endsWith('.');
    const ctaText   = looksLikeCTA ? lastLine : '';
    const bodyLines = looksLikeCTA ? lines.slice(0, -1) : lines;
    const formattedBody = bodyLines.join('\n')
      .replace(/\n\n/g, `</p><p style="font-size:16px;color:${textColor};line-height:1.75;margin:0 0 20px;">`)
      .replace(/\n/g, '<br>');
    const ctaBlock = ctaText
      ? `<table cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 8px;"><tr><td align="center" bgcolor="${primaryColor}" style="background:${primaryColor};border-radius:4px;"><a href="${ctaHref}" target="_blank" style="display:inline-block;background:${primaryColor};color:${primaryText};font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;text-decoration:none;padding:14px 32px;border-radius:4px;-webkit-text-size-adjust:none;mso-padding-alt:0;">${ctaText}</a></td></tr></table>`
      : '';
    bodyContent = `<p style="font-size:16px;color:${textColor};line-height:1.75;margin:0 0 20px;">${formattedBody}</p>${ctaBlock}`;
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
          ${item.image ? `<tr><td style="padding:0;line-height:0;"><img src="${item.image}" width="100%" height="140" alt="${item.name}" style="display:block;width:100%;height:140px;object-fit:cover;border-radius:8px 8px 0 0;" /></td></tr>` : ''}
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
  // ────────────────────────────────────────────────────────────────────────────

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:${bgColor};font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${bgColor};padding:40px 20px;">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="background:${containerBg};border-radius:8px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,${isDark ? '0.4' : '0.08'});">
  <!-- HEADER -->
  <tr><td style="background:${headerBg};padding:28px 40px;text-align:center;">
    ${headerContent}
  </td></tr>
  <!-- HERO IMAGE -->
  ${heroRow}
  <!-- BODY -->
  <tr><td style="background:${containerBg};padding:40px;">
    <h1 style="font-size:22px;color:${accentColor};margin:0 0 24px;line-height:1.35;">${subject}</h1>
    ${bodyContent}
  </td></tr>
  <!-- FOOTER -->
  <tr><td style="background:${footerBg};padding:28px 40px;text-align:center;border-top:1px solid ${footerBorder};">
    ${footerLogo}
    ${['lite','growth','high_impact'].includes(tier)
      ? `<p style="font-size:12px;font-weight:600;color:${mutedText};margin:0 0 8px;">${company}</p>
    <p style="font-size:11px;color:${footerMuted};margin:0;"><a href="#" style="color:${footerMuted};text-decoration:underline;">Unsubscribe</a> &nbsp;·&nbsp; <a href="#" style="color:${footerMuted};text-decoration:underline;">Manage preferences</a></p>`
      : `<p style="font-size:11px;color:${footerText};margin:0 0 8px;">Rebuilt by <a href="https://strategic-flow-audit.replit.app" style="color:${accentColor};text-decoration:none;">Strategic Flow</a> &nbsp;·&nbsp; strategic-flow-audit.replit.app</p>
    <p style="font-size:11px;color:${footerMuted};margin:0;"><a href="#" style="color:${footerMuted};text-decoration:underline;">Unsubscribe</a> &nbsp;·&nbsp; <a href="#" style="color:${footerMuted};text-decoration:underline;">Manage preferences</a></p>`}
  </td></tr>
</table></td></tr></table></body></html>`;
}

async function notify(subject, html) {
  try { await resend.emails.send({ from: SENDER, to: OWNER_EMAIL, subject, html }); }
  catch (e) { console.error('[email]', e.message); }
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
async function sendResultEmail(to, company, origSubject, rebuiltSubject, keyChanges, convHook, downloadHtml) {
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
      <tr><td style="padding:8px 12px;background:#fff;border:1px solid #e0e0e0;font-size:12px;color:#888;width:110px;">Original</td><td style="padding:8px 12px;background:#fff;border:1px solid #e0e0e0;font-size:14px;color:#222;">${origSubject}</td></tr>
      <tr><td style="padding:8px 12px;background:#e8fffe;border:1px solid #b2f0ee;font-size:12px;color:#00a09a;width:110px;">Rebuilt</td><td style="padding:8px 12px;background:#e8fffe;border:1px solid #b2f0ee;font-size:14px;font-weight:700;color:#007a75;">${rebuiltSubject}</td></tr>
    </table>
    ${changesHtml ? `<p style="color:#444;font-weight:600;margin-bottom:8px;">What changed &amp; why:</p><ul style="color:#444;line-height:1.8;margin:0 0 20px;padding-left:20px;">${changesHtml}</ul>` : ''}
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

async function fetchPageContent(rawUrl) {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const fetch = (await import('node-fetch')).default;
  const resp = await fetch(url, {
    timeout: 12000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StrategicFlow/1.0)' }
  });
  if (!resp.ok) throw new Error(`Page returned ${resp.status}`);
  const html = await resp.text();

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g,' ').trim() : '';

  const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i)
    || html.match(/<meta[^>]*content=["']([^"']{20,})[^>]*name=["']description["']/i);
  const meta = metaMatch ? metaMatch[1].trim() : '';

  // Extract the article's own cover image. Priority order:
  //   1. og:image (standard Open Graph)
  //   2. twitter:image (Twitter card — common fallback)
  //   3. First large <img> inside <article> or <main> (for sites that render meta server-side but skip OG)
  const ogImage = (() => {
    // og:image — content attr can appear before or after property attr
    const og = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i)?.[1];
    if (og && og.startsWith('http')) return og;

    // twitter:image
    const tw = html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i)?.[1];
    if (tw && tw.startsWith('http')) return tw;

    // First <img> with absolute URL inside <article> or <main> (static renders without OG meta)
    const articleBlock = html.match(/<(?:article|main)[^>]*>([\s\S]{0,8000}?)<\/(?:article|main)>/i)?.[1] || '';
    const imgSrc = articleBlock.match(/src=["'](https:\/\/[^"']+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"']*)?)/i)?.[1];
    if (imgSrc) return imgSrc;

    return null;
  })();

  // Strip scripts, styles, nav, footer elements then pull plain text
  const stripped = sanitizeForJSON(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(nav|header|footer|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
      .replace(/\s+/g,' ').trim()
  ).slice(0, 2000);

  return { title, meta, text: stripped, url, ogImage };
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

    // If a page URL was provided and body is absent/minimal, fetch the page and extract content
    if (pageUrl && pageUrl.trim() && (!body || body.trim().length < 30)) {
      try {
        const page = await fetchPageContent(pageUrl);
        body = [
          page.title ? `Headline: ${page.title}` : '',
          page.meta  ? `Summary: ${page.meta}` : '',
          page.text
        ].filter(Boolean).join('\n\n');
        analyzedPage = true;
        if (page.ogImage) req.body._ogImage = page.ogImage;
        console.log(`[pageUrl] fetched ${page.url} — ${body.length} chars, ogImage: ${page.ogImage ? 'yes' : 'none'}`);
      } catch (fetchErr) {
        console.error('[pageUrl]', fetchErr.message);
        return res.json({ error: 'url_fetch_failed' });
      }
      // FIX 3 — too little content extracted (bot-blocked page returns skeleton HTML)
      if (!body || body.trim().length < 200) {
        return res.json({ error: 'url_fetch_empty' });
      }
    }

    if (!body || body.trim().length < 10) return res.status(400).json({ error: 'email, subject, body required' });

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
    // free_trial generates at single-tier quality
    const promptTier = tier === 'free_trial' ? 'single' : tier;

    if (!adminAccess) {
      const lim = checkLimit(user);
      if (!lim.allowed) {
        // Free-trial users who already used their rebuild: return cached last result
        // instead of a hard block, so they see value and are prompted to upgrade.
        if (lim.reason === 'trial_used') {
          const cached = await pool.query(
            'SELECT * FROM newsletters WHERE email = $1 ORDER BY created_at DESC LIMIT 1',
            [e]
          );
          if (cached.rows.length > 0) {
            const n = cached.rows[0];
            const cachedDNA = n.brand_dna || null;
            const { primaryColor: pa, primaryText: pat } = getEmailColors(cachedDNA);
            const previewBody = (n.rebuilt_body || '')
              .replace(/CTABGCOLOR/g, pa)
              .replace(/CTATEXTCOLOR/g, pat);
            const downloadHtml = stripResendTracking(buildNewsletterHTML(
              n.company || 'Your Company', n.rebuilt_subject, n.rebuilt_body, cachedDNA,
              { tier: n.tier || 'free_trial', originalBody: n.original_body || '',
                ctaHref: cachedDNA?.url || 'https://strategic-flow-audit.replit.app' }
            ));
            return res.json({
              rebuilt_subject: n.rebuilt_subject,
              rebuilt_body:    n.rebuilt_body,
              previewBody,
              downloadHtml,
              tier:            n.tier || 'free_trial',
              emailType:       n.email_type || null,
              key_changes:     n.key_changes || [],
              conversion_hook: n.conversion_hook || '',
              cached:          true
            });
          }
        }
        return res.status(403).json({ error: 'limit_reached', reason: lim.reason, used: lim.used, limit: lim.limit });
      }
    }

    // When no brandDNA was provided (user skipped the website URL field), infer
    // brand signals automatically from the email content + a company URL guess.
    let effectiveBrandDNA  = brandDNA  || null;
    let effectiveVoice     = voiceProfile || null;

    // Detect dark theme from body keywords BEFORE inference so Claude's default
    // light bgColor response cannot override it later.
    const forceDark = detectDarkFromEmailBody(body);

    if (!effectiveBrandDNA) {
      try {
        const inferred = await inferBrandFromContent(company, subject, body, pageUrl);
        if (inferred) {
          effectiveBrandDNA = inferred;
          if (inferred.voiceProfile && !effectiveVoice) effectiveVoice = inferred.voiceProfile;
          console.log(`[brand-infer] source=${inferred.source} colors=${inferred.colors?.length}`);
        }
      } catch (inferErr) { console.error('[brand-infer]', inferErr.message); }
    }

    // Apply forceDark AFTER inference — body keyword match wins over Claude's inferred bgColor
    if (forceDark) {
      effectiveBrandDNA = effectiveBrandDNA || {};
      effectiveBrandDNA = { ...effectiveBrandDNA, theme: 'dark' };
      console.log('[dark-detect] body keyword match → theme forced dark');
    }

    console.log('STEP 2: Brand DNA extracted');

    // High-Impact: detect type if not provided
    let detectedType = emailType || null;
    if (tier === 'high_impact' && !detectedType) {
      try { detectedType = (await claudeJSON(getEmailTypePrompt(subject, body), 200))?.type || null; } catch (_) {}
    }

    const industry = effectiveBrandDNA?.industry || null;
    const priorExamples = await getIndustryExamples(industry);

    // ── SCORING + ANALYSIS: score the original email AND extract specific weaknesses ──
    let originalScore = null;
    let rebuildPath = 'rebuilt'; // default: full rebuild
    let analysis = { weaknesses: [], directives: [] };
    try {
      const raw = await claudeJSON(getEmailScorePrompt(subject, body), 900);
      if (raw) {
        const total = (raw.subject_score || 0) + (raw.hook_score || 0) +
                      (raw.structure_score || 0) + (raw.cta_score || 0) + (raw.voice_score || 0);
        originalScore = { ...raw, total, percentage: Math.round(total / 10 * 100) };
        rebuildPath = total >= 7 ? 'preserved' : 'rebuilt';
        // Extract weakness analysis produced by the scoring call
        analysis = {
          weaknesses: Array.isArray(raw.weaknesses) ? raw.weaknesses : [],
          directives: Array.isArray(raw.directives) ? raw.directives : []
        };
        console.log(`[score] ${company} → ${total}/10 (${originalScore.percentage}%) → path: ${rebuildPath} | weaknesses: ${analysis.weaknesses.length}`);
      } else {
        console.warn('[score] null response from Claude — using default rebuild path');
      }
    } catch (scoreErr) {
      console.error('[score]', scoreErr.message);
    }

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

    // ── PROMPT DISPATCH: micro-improvements for strong emails, full rebuild otherwise ──
    let result;
    if (promoGridResult) {
      result = promoGridResult;
    } else if (rebuildPath === 'preserved') {
      const microPrompt = getMicroImprovementsPrompt({
        company: company || 'Your Company', goal, subject, body,
        brandDNA: effectiveBrandDNA, voiceProfile: effectiveVoice,
        score: originalScore, priorExamples
      });
      result = await claudeJSON(microPrompt, 2500);
    } else {
      // Pass the strategic analysis into the rebuild prompt — closed loop
      const prompt = getAuditPrompt({ tier: promptTier, company: company || 'Your Company', goal, subject, body, brandDNA: effectiveBrandDNA, voiceProfile: effectiveVoice, emailType: detectedType, roadmapNotes, priorExamples, analysis });
      result = await claudeJSON(prompt, 2500);
    }

    console.log('STEP 3: Claude generation complete');
    // Guard: Claude must have returned a parseable object with the two critical fields.
    // If either is missing, surface a clean error rather than rendering "undefined" everywhere.
    if (!result || !safeVal(result.rebuilt_subject) || !safeVal(result.rebuilt_body)) {
      console.error('[generate] Claude response missing rebuilt_subject or rebuilt_body', result);
      return res.status(500).json({ error: 'Generation failed. Please try again.' });
    }

    // ── VERIFY + PATCH: check each weakness was addressed; fix any that weren't ──
    // Only runs for full rebuilds with identified weaknesses (not micro-improvement or promo-grid path).
    if (!promoGridResult && rebuildPath === 'rebuilt' && analysis.weaknesses.length > 0) {
      try {
        const verify = await claudeJSON(
          getWeaknessVerifyPrompt(analysis.weaknesses, result.rebuilt_subject, result.rebuilt_body), 600
        );
        const unaddressed = (verify?.results || []).filter(r => !r.addressed);
        if (unaddressed.length > 0) {
          console.log(`[verify] ${unaddressed.length} weakness(es) unaddressed — patching`);
          for (const item of unaddressed) {
            const { section } = item;
            // Find corresponding directive for this weakness
            const idx = analysis.weaknesses.indexOf(item.weakness);
            const directive = idx >= 0 ? (analysis.directives[idx] || item.weakness) : item.weakness;
            const patchPrompt = getSectionPatchPrompt(section, item.weakness, directive, subject, result.rebuilt_subject, result.rebuilt_body);
            if (!patchPrompt) continue;
            try {
              const patch = await claudeJSON(patchPrompt, 300);
              if (!patch) continue;
              if (section === 'subject' && patch.patched_subject) {
                result.rebuilt_subject = patch.patched_subject;
                console.log(`[patch] subject rewritten`);
              } else if (section === 'hook' && patch.patched_hook) {
                // Replace the first <p ...> block in rebuilt_body with the new hook
                result.rebuilt_body = result.rebuilt_body.replace(/<p[^>]*>[\s\S]*?<\/p>/, patch.patched_hook);
                console.log(`[patch] hook replaced`);
              } else if (section === 'cta' && patch.patched_cta_text) {
                // Replace CTA link text inside the button — text between last > and </a>
                result.rebuilt_body = result.rebuilt_body.replace(
                  /(<a[^>]*?>)([^<]{2,60})(<\/a>)/,
                  (_, open, _old, close) => `${open}${patch.patched_cta_text}${close}`
                );
                console.log(`[patch] CTA text replaced: ${patch.patched_cta_text}`);
              }
            } catch (patchErr) {
              console.error(`[patch] ${section} failed:`, patchErr.message);
            }
          }
        } else {
          console.log(`[verify] all ${analysis.weaknesses.length} weakness(es) addressed`);
        }
      } catch (verifyErr) {
        console.error('[verify] skipped:', verifyErr.message);
      }
    }

    // Safety net: if brand DNA still has no colours after the earlier inference pass,
    // make one final targeted attempt using the rebuilt subject + body (richer signal
    // than the original). The #00d4c8 teal inside buildNewsletterHTML is a true
    // last resort and should never appear in practice after this guard.
    if (!effectiveBrandDNA?.colors?.length) {
      try {
        const colorHint = await claudeJSON(
          `You are a brand colour specialist. Based on this email, suggest the most appropriate brand colour palette.
Return ONLY valid JSON: {"primaryColor":"#XXXXXX","accentColor":"#XXXXXX","bgColor":"#XXXXXX"}
Rules: never use #00d4c8, #3498db, or plain grey. Infer colours specific to the industry and tone evident in the content.

Company: ${company || 'Unknown'}
Subject: ${result.rebuilt_subject}
Body: ${(result.rebuilt_body || '').slice(0, 900)}`, 150);

        const hex6 = v => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;
        const p = hex6(colorHint?.primaryColor);
        const a = hex6(colorHint?.accentColor);
        const b = hex6(colorHint?.bgColor);
        if (p) {
          effectiveBrandDNA = {
            ...(effectiveBrandDNA || {}),
            source: 'rebuilt-content-fallback',
            colors: [
              { type: 'inferred:primary', value: p },
              ...(a ? [{ type: 'inferred:accent', value: a }] : []),
              ...(b ? [{ type: 'inferred:bg',     value: b }] : [])
            ]
          };
          console.log(`[brand-fallback] colours inferred from rebuilt content: ${p}`);
        }
      } catch (fbErr) { console.error('[brand-fallback]', fbErr.message); }
    }

    // Clean up any stray markdown that Claude may have included
    result.rebuilt_body = stripMarkdown(result.rebuilt_body);

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
    // Condition: theme is not already confirmed dark — overrides the default 'light' set by inferBrandFromContent.
    // Previously used !effectiveBrandDNA.theme which was always false because inferBrandFromContent
    // always sets theme:'light' as default — that was a dead branch. Fixed to !== 'dark'.
    if (effectiveBrandDNA && effectiveBrandDNA.theme !== 'dark' && body) {
      const textDarkSignals = [
        /#[01][0-9a-fA-F]{5}/gi,
        /background.{0,20}#1[0-9a-fA-F]{5}/gi,
        /color.{0,20}white/gi,
        /dark.{0,10}theme/gi,
        /background.{0,20}black/gi
      ];
      const darkHits = textDarkSignals.filter(p => { p.lastIndex = 0; return p.test(body); }).length;
      if (darkHits >= 1) {
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
    // Priority: explicit primaryCtaUrl → source page URL (article/landing page) → brand url → known brand → fallback
    // knownBrands fallback is only used when NO source URL was provided by the user
    const ctaHref = effectiveBrandDNA?.primaryCtaUrl
      || (pageUrl && pageUrl.trim())
      || effectiveBrandDNA?.url
      || knownUrl
      || 'https://strategic-flow-audit.replit.app';

    // Build HTML first, then strip any Resend tracking links before returning to frontend,
    // saving to DB, or attaching to email — must happen before res.json() and sendResultEmail().
    let downloadHtml = buildNewsletterHTML(company || 'Your Company', result.rebuilt_subject, result.rebuilt_body, effectiveBrandDNA,
      { tier, originalBody: body, ctaHref, heroKeyword, contentStyle: result.contentStyle || '',
        layoutType: isPromoGrid && promotionalItems.length >= 2 ? 'promotional-grid' : '',
        promotionalItems, heroImageUrl: req.body._ogImage || null });
    downloadHtml = stripResendTracking(downloadHtml);
    console.log('STEP 4: HTML built');

    // Build a preview-ready body with the CTABGCOLOR/CTATEXTCOLOR placeholders already
    // replaced by real brand colours — the frontend injects this as innerHTML directly.
    const { primaryColor: previewAccent, primaryText: previewAccentText } = getEmailColors(effectiveBrandDNA);
    const previewBody = (result.rebuilt_body || '')
      .replace(/CTABGCOLOR/g, previewAccent)
      .replace(/CTATEXTCOLOR/g, previewAccentText);

    // Prefer email type returned by Claude in the generation JSON; fall back to separately detected type
    const finalEmailType = result.emailType || detectedType;
    const brandDNASource = effectiveBrandDNA?.source || null;

    // BUG 1 — Send the success response IMMEDIATELY after HTML is built.
    // All side-effect work (DB save, email, notifications) runs AFTER in isolated try/catch
    // blocks so they can never cause "Generation failed" even if they error out.
    let newsletterId = null;
    res.json({ ...result, newsletterId, emailType: finalEmailType, downloadHtml, previewBody, tier, analyzedPage, rebuildPath, originalScore, inferredBrandDNA: brandDNASource ? effectiveBrandDNA : undefined });
    console.log('STEP 7: Response sent');

    // ── SIDE EFFECTS (fire-and-forget — never affect the user response) ──

    // Persist to DB
    try {
      const s = await pool.query(`
        INSERT INTO newsletters (email,company,original_subject,original_body,rebuilt_subject,rebuilt_body,tier,email_type,brand_dna,key_changes,conversion_hook,original_score,rebuild_path)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id
      `, [e, company, subject, body, result.rebuilt_subject, result.rebuilt_body, tier, finalEmailType,
          effectiveBrandDNA ? JSON.stringify(effectiveBrandDNA) : null,
          result.key_changes ? JSON.stringify(result.key_changes) : null,
          result.conversion_hook || null,
          originalScore ? JSON.stringify(originalScore) : null,
          rebuildPath]);
      newsletterId = s.rows[0].id;
    } catch (dbErr) { console.error('[db save]', dbErr.message); }
    console.log('STEP 5: DB save attempted');

    // Learning data
    storeLearning({
      company: company || null, industry,
      audienceType: effectiveBrandDNA?.audience || null,
      origSubject: subject, origBody: body,
      rebuiltSubject: result.rebuilt_subject, rebuiltBody: result.rebuilt_body,
      whatChanged: result.key_changes, tier, rebuildPath
    }).catch(e2 => console.error('[learning]', e2.message));

    // Bump usage counter
    try { if (!adminAccess) await bumpCount(e); } catch (bcErr) { console.error('[bumpCount]', bcErr.message); }
    pool.query('UPDATE users SET company=$1 WHERE email=$2', [company, e]).catch(() => {});

    // Email delivery
    const shouldEmailResult = e && !e.includes('@sf-session.com') && (!adminAccess || e === OWNER_EMAIL);
    if (shouldEmailResult) {
      sendResultEmail(e, company, subject, result.rebuilt_subject, result.key_changes, result.conversion_hook, downloadHtml)
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

app.get('/generate/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  if (job.status === 'complete') return res.json({ status: 'complete', result: job.result });
  if (job.status === 'failed')   return res.json({ status: 'failed',   error:  job.error  });
  res.json({ status: 'pending' });
});

// ── A/B SUBJECTS (Lite+) ──
app.post('/ab-subjects', async (req, res) => {
  try {
    const { email } = req.body;
    const company = sanitizeInput(req.body.company);
    const subject = sanitizeInput(req.body.subject);
    const body    = sanitizeInput(req.body.body, 12000);
    const u = await getUser((email || '').toLowerCase());
    if (!isAdmin(email) && !['lite','growth','high_impact'].includes(u?.tier)) return res.status(403).json({ error: 'Lite+ required' });
    res.json(await claudeJSON(getABSubjectsPrompt(company, subject, body), 1000));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CONVERSION SCORE (Lite+) ──
app.post('/conversion-score', async (req, res) => {
  try {
    const { email } = req.body;
    const originalSubject = sanitizeInput(req.body.originalSubject);
    const originalBody    = sanitizeInput(req.body.originalBody, 12000);
    const rebuiltSubject  = sanitizeInput(req.body.rebuiltSubject);
    const rebuiltBody     = sanitizeInput(req.body.rebuiltBody, 12000);
    const u = await getUser((email || '').toLowerCase());
    if (!isAdmin(email) && !['lite','growth','high_impact'].includes(u?.tier)) return res.status(403).json({ error: 'Lite+ required' });
    res.json(await claudeJSON(getConversionScorePrompt(originalSubject, originalBody, rebuiltSubject, rebuiltBody), 1000));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AUDIENCE SEGMENTS (Growth+) ──
app.post('/audience-segments', async (req, res) => {
  try {
    const { email } = req.body;
    const company = sanitizeInput(req.body.company);
    const subject = sanitizeInput(req.body.subject);
    const body    = sanitizeInput(req.body.body, 12000);
    const u = await getUser((email || '').toLowerCase());
    if (!isAdmin(email) && !['growth','high_impact'].includes(u?.tier)) return res.status(403).json({ error: 'Growth+ required' });
    res.json(await claudeJSON(getAudienceSegmentsPrompt(company, subject, body), 900));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CONTENT CALENDAR (Growth+) ──
app.post('/content-calendar', async (req, res) => {
  try {
    const { email } = req.body;
    const company = sanitizeInput(req.body.company);
    const subject = sanitizeInput(req.body.subject);
    const body    = sanitizeInput(req.body.body, 12000);
    const u = await getUser((email || '').toLowerCase());
    if (!isAdmin(email) && !['growth','high_impact'].includes(u?.tier)) return res.status(403).json({ error: 'Growth+ required' });
    res.json(await claudeJSON(getContentCalendarPrompt(company, subject, body), 900));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── COHESION CHECK (High-Impact) ──
app.post('/cohesion-check', async (req, res) => {
  try {
    const { email } = req.body;
    const subject = sanitizeInput(req.body.subject);
    const body    = sanitizeInput(req.body.body, 12000);
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

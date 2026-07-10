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
const cron    = require('node-cron');

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

const MODEL          = 'claude-sonnet-5';
const OWNER_EMAIL    = 'strategicflow@proton.me';
const SENDER         = 'noreply@strategicflow.tech';
const BYPASS_EMAILS  = new Set(['strategicflow@proton.me', 'consultantcalatorii@gmail.com']);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'sfadmin2026';

// ── DECISION FRICTION INDEX ──────────────────────────────────────────────────
const INDEX_ADMIN_KEY = process.env.INDEX_ADMIN_KEY || '';
const INDEX_CANONICAL_PATTERNS = [
  'Filing Label Subject',
  'Feature-First Bias',
  'Guest Language CTA',
  'Consequence-After-Caveat',
  'Missing Visual Hierarchy',
  'Zero/Buried Social Proof'
];

const INDEX_SEVEN_CHECKS = [
  { name: 'Subject line / headline construction', explanation: 'Does the subject or headline lead with an outcome the reader cares about, rather than a feature name or internal label?' },
  { name: 'Lead construction', explanation: 'Does the opening line hook the reader with a concrete stake or benefit before any setup or preamble?' },
  { name: 'Feature-to-outcome translation', explanation: 'Are features explained in terms of what the reader can now do or achieve, not just what was shipped?' },
  { name: 'Visual hierarchy', explanation: 'Does formatting (headings, spacing, emphasis) guide the eye to the most important information first?' },
  { name: 'Before/after contrast or concreteness', explanation: 'Does the content use specific, concrete before/after framing rather than vague or abstract claims?' },
  { name: 'Social proof', explanation: 'Is there evidence — numbers, quotes, customer names — that others have used or validated this?' },
  { name: 'CTA language', explanation: 'Does the call to action use ownership language ("Get your X") rather than guest language ("Learn more", "Submit")?' }
];

function buildIndexScoringPrompt(contentType, content) {
  return `You are WHY., a friction diagnostic tool, scoring content for the public Decision Friction Index. Analyze the following ${contentType} and return a JSON object with this exact structure:

{
  "score": <number 1-10, one decimal allowed, where 10 = excellent structural quality (low decision friction) and 1 = severe structural failure (high decision friction)>,
  "patterns": [<array of 1-4 labels, ONLY from this exact canonical list, no others: ${INDEX_CANONICAL_PATTERNS.map(p => `"${p}"`).join(', ')}>],
  "diagnosis_summary": "<2-3 sentences, clinical tone, referencing the actual content>",
  "input_quality": "<clean | polluted>",
  "checks": [<array of EXACTLY 7 objects, one per diagnostic point below, IN THIS EXACT ORDER, each shaped { "check": "<name>", "verdict": "<pass | weak | fail>", "note": "<one sentence, specific to this content>" }:
    ${INDEX_SEVEN_CHECKS.map((c, i) => `${i + 1}. "${c.name}"`).join(', ')}
  >]
}

Rules:
- patterns must contain ONLY labels from the canonical list above, spelled exactly as given. Do not invent new labels. Pick the ones that genuinely apply, ranked by severity (most severe first).
- Be brutally specific in diagnosis_summary — reference actual phrases or structural decisions in the content.
- checks MUST contain exactly 7 objects, in the fixed order given above, with "check" spelled exactly as given. Each "note" must be one sentence and reference something specific in this content, not a generic statement.
- Set "input_quality" to "polluted" if the provided content appears to be mostly navigation menus, footer templates, cookie banners, or site chrome rather than the actual email/changelog/blog/landing page content. Otherwise set it to "clean".
- The content may be truncated at the end due to technical limits. Never penalize or mention an abrupt ending, incomplete final sentence, or missing conclusion — evaluate only the structure of what is present.
- Return ONLY valid JSON, no markdown, no backticks, no explanation.

Content to analyze:
${content}`;
}

async function scoreContentWithClaude(prompt) {
  const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await apiResp.json();
  const textBlock = data.content?.find(b => b.type === 'text');
  const text = textBlock?.text || '';
  const clean = text.replace(/```json|```/g, '').trim();
  const result = safeParseJSON(clean);
  if (!result) throw new Error('parse_failed');
  return result;
}

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

app.use('/stripe/webhook',          express.raw({ type: 'application/json' }));
app.use('/webhook/stripe',          express.raw({ type: 'application/json' }));
app.use('/api/why-stripe-webhook',  express.raw({ type: 'application/json' }));
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
  '/architecture.html',
  '/architecture-dashboard',
  '/assessment.html',
  '/api/architecture'
];

function requireAuth(req, res, next) {
  const open = ['/login.html', '/magic.html', '/auth/magic', '/auth/verify', '/auth/logout', '/generate/status', '/api/demo', '/api/demo-rebuild', '/api/mcp/audit'];
  if (open.some(p => req.path.startsWith(p))) return next();

  // ?preview=free bypasses auth for HTML page viewing only (not API calls)
  if (req.query.preview === 'free' && (req.path.endsWith('.html') || req.path === '/')) return next();

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

app.get('/patterns', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public/patterns.html'));
});

app.get('/pattern-intelligence', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public/pattern-intelligence.html'));
});

app.get('/ai-visibility', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public/ai-visibility.html'));
});


async function callPerplexityVisibility(brand, domain, query) {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return { found: false, context: null, error: 'no_key' };
  try {
    const resp = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: query }],
        max_tokens: 400,
        search_recency_filter: 'month'
      }),
      signal: AbortSignal.timeout(20000)
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error('[perplexity]', resp.status, err.slice(0, 200));
      return { found: false, context: null, error: `http_${resp.status}` };
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';
    const brandLower = brand.toLowerCase();
    const domainLower = domain.toLowerCase();
    const found = text.toLowerCase().includes(brandLower) || text.toLowerCase().includes(domainLower);
    let context = null;
    if (found) {
      const sentences = text.match(/[^.!?]*[.!?]/g) || [text];
      const hit = sentences.find(s =>
        s.toLowerCase().includes(brandLower) || s.toLowerCase().includes(domainLower)
      );
      context = hit ? hit.trim() : text.slice(0, 200).trim();
    }
    return { found, context, rawLength: text.length };
  } catch (e) {
    console.error('[perplexity]', e.message);
    return { found: false, context: null, error: e.message };
  }
}

async function callAIVisibility(domain, brand, query) {
  const prompt = `A professional asks you: "${query}"

Answer naturally and helpfully in 4-6 sentences. Recommend specific tools or products you actually know about.

Return ONLY this JSON, no other text:
{
  "answer": "<your 4-6 sentence natural answer>",
  "mentions_brand": <true or false — does your answer mention "${brand}" or "${domain}" anywhere?>,
  "mentions_affirmatively": <true or false — ONLY true if your answer demonstrates genuine knowledge of ${brand} as a real product/tool (e.g. you describe what it does, recommend it, or reference it as a known entity). Set false if you say you are unfamiliar with it, cannot find it, don't recognise the name, or if it is not mentioned at all.>,
  "mentions_correctly": <true or false — if you mentioned it affirmatively, is your description of what they do accurate based on what you know? false if not mentioned or if you denied knowing it>
}`;
  const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(30000)
  });
  const data = await apiResp.json();
  const textBlock = data.content?.find(b => b.type === 'text');
  const raw = (textBlock?.text || '').replace(/```json|```/g, '').trim();
  return safeParseJSON(raw);
}

async function fetchVisibilityTech(domain) {
  const AI_BOTS = ['gptbot', 'claudebot', 'ccbot', 'anthropic-ai', 'google-extended', 'cohere-ai', 'ai2bot', 'perplexitybot'];
  let robotsBlocked = false, robotsFetched = false, schemaPresent = false, blockedAgents = [], jsOnly = false;

  try {
    const r = await fetch(`https://${domain}/robots.txt`, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StrategicFlow/1.0)' }
    });
    if (r.ok) {
      robotsFetched = true;
      const lines = (await r.text()).toLowerCase().split(/\r?\n/);
      let agents = [];
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) { agents = []; continue; }
        if (line.startsWith('user-agent:')) {
          agents.push(line.replace('user-agent:', '').trim());
        } else if (line.startsWith('disallow:') && line.replace('disallow:', '').trim() === '/') {
          for (const agent of agents) {
            if (agent === '*') {
              AI_BOTS.forEach(b => { if (!blockedAgents.includes(b)) blockedAgents.push(b); });
              robotsBlocked = true;
            } else if (AI_BOTS.includes(agent)) {
              if (!blockedAgents.includes(agent)) blockedAgents.push(agent);
              robotsBlocked = true;
            }
          }
        }
      }
    }
  } catch {}

  try {
    const r = await fetch(`https://${domain}/`, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StrategicFlow/1.0)' }
    });
    if (r.ok) {
      const html = await r.text();
      schemaPresent = html.includes('application/ld+json') || html.includes('"@context"') || html.includes('itemtype=');
      const stripped = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ').trim();
      jsOnly = stripped.length < 400;
    }
  } catch {}

  return { robotsBlocked, robotsFetched, schemaPresent, blockedAgents, jsOnly };
}

app.post('/api/ai-visibility', async (req, res) => {
  const { domain: rawDomain, category } = req.body;
  if (!rawDomain) return res.status(400).json({ error: 'Domain required' });

  const domain = rawDomain.trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./i, '')
    .toLowerCase();
  if (!domain || !domain.includes('.'))
    return res.status(400).json({ error: 'Enter a valid domain — e.g. example.com' });

  const brandRaw = domain.split('.')[0].replace(/-/g, ' ');
  const brand = brandRaw.replace(/\b\w/g, c => c.toUpperCase());
  const cat = (category || '').trim();

  const q1 = cat
    ? `best ${cat} tool for B2B SaaS teams in 2026`
    : `what does ${brand} do and who is it for`;
  const q2 = cat
    ? `${cat} software experts recommend for growth teams`
    : `${brand} — worth using for a growing SaaS company`;

  try {
    const pxQuery = cat
      ? `best ${cat} tools for B2B SaaS teams in 2026`
      : `what does ${brand} (${domain}) do and who is it for`;

    const [r1raw, r2raw, tech, px] = await Promise.all([
      callAIVisibility(domain, brand, q1).catch(() => null),
      callAIVisibility(domain, brand, q2).catch(() => null),
      fetchVisibilityTech(domain).catch(() => ({
        robotsBlocked: false, robotsFetched: false, schemaPresent: false, blockedAgents: [], jsOnly: false
      })),
      callPerplexityVisibility(brand, domain, pxQuery).catch(() => ({ found: false, context: null, error: 'catch' }))
    ]);

    const r1 = r1raw || { mentions_brand: false, mentions_affirmatively: false, mentions_correctly: false, answer: 'Response unavailable.' };
    const r2 = r2raw || { mentions_brand: false, mentions_affirmatively: false, mentions_correctly: false, answer: 'Response unavailable.' };

    // Extract competitor product names via a dedicated AI call — structured output,
    // not regex parsing of capitalized words (which produces false positives like "Common", "Book", "Acid").
    let competitors = [];
    const combinedAnswers = [r1.answer, r2.answer].filter(a => a && a !== 'Response unavailable.').join('\n\n');
    if (combinedAnswers) {
      try {
        const extractPrompt = `From the text below, list only the specific software product or brand names that are mentioned as tools, platforms, or services. One name per line. Use the exact name as written in the text (e.g. "Email on Acid" not just "Acid"). No explanations, no bullets, no numbering. If no product names are mentioned, output NONE.\n\nText:\n${combinedAnswers}`;
        const extractResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: MODEL, max_tokens: 300, messages: [{ role: 'user', content: extractPrompt }] }),
          signal: AbortSignal.timeout(15000)
        });
        const extractData = await extractResp.json();
        const extractText = (extractData.content?.find(b => b.type === 'text')?.text || '').trim();
        if (extractText && extractText.toUpperCase() !== 'NONE') {
          competitors = extractText
            .split('\n')
            .map(l => l.trim().replace(/^[-*•]\s*/, ''))
            .filter(l => l.length > 1 && l.toLowerCase() !== brand.toLowerCase() && l.toLowerCase() !== domain.toLowerCase())
            .slice(0, 5);
        }
      } catch (e) { /* competitor extraction is non-critical, skip silently */ }
    }

    // mentions_affirmatively guards against false positives where the model names the brand
    // only to deny knowing it (e.g. "I'm not familiar with a tool called [Brand]").
    const brandMentioned = !!(r1.mentions_affirmatively || r2.mentions_affirmatively);
    const citedCorrectly = !!((r1.mentions_affirmatively && r1.mentions_correctly) || (r2.mentions_affirmatively && r2.mentions_correctly));
    const crawlable = tech.schemaPresent && !tech.robotsBlocked;
    const mentionCount = (r1.mentions_affirmatively ? 1 : 0) + (r2.mentions_affirmatively ? 1 : 0);
    // Track denial separately for diagnostic messaging
    const brandDenied = !brandMentioned && !!(r1.mentions_brand || r2.mentions_brand);

    let score = 0;
    if (brandMentioned) score += 4;
    if (citedCorrectly) score += 3;
    if (crawlable) score += 3;

    let benchmarkAvg = null, benchmarkCategory = null;
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS visibility_checks (
          id SERIAL PRIMARY KEY,
          domain TEXT, category TEXT, score INTEGER,
          checked_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await pool.query(
        `INSERT INTO visibility_checks (domain, category, score) VALUES ($1, $2, $3)`,
        [domain, (cat || 'general').toLowerCase(), score]
      );
      if (cat) {
        const catR = await pool.query(
          `SELECT ROUND(AVG(score)::numeric,1) AS avg, COUNT(*) AS cnt
           FROM visibility_checks WHERE LOWER(category) = LOWER($1)`,
          [cat]
        );
        const row = catR.rows[0];
        if (row && parseInt(row.cnt) >= 10) {
          benchmarkAvg = parseFloat(row.avg);
          benchmarkCategory = cat;
        }
      }
      if (benchmarkAvg === null) {
        const allR = await pool.query(
          `SELECT ROUND(AVG(score)::numeric,1) AS avg, COUNT(*) AS cnt FROM visibility_checks`
        );
        const row = allR.rows[0];
        if (row && parseInt(row.cnt) >= 2) {
          benchmarkAvg = parseFloat(row.avg);
        }
      }
    } catch (e) { console.error('[vis-benchmark]', e.message); }

    const reasons = [
      brandMentioned
        ? `${brand} appeared in ${mentionCount}/2 AI responses for "${cat || 'brand'}" queries`
        : brandDenied
          ? `${brand} named in AI response but model explicitly denied knowing it — no recognition credit awarded`
          : `${brand} not found in either AI response for "${(cat ? `best ${cat} tool` : `what does ${brand} do`).slice(0, 50)}"`,
      citedCorrectly
        ? 'Described with accurate product context in AI response'
        : brandMentioned
          ? 'Mentioned but product/offer context incomplete or inaccurate'
          : brandDenied
            ? 'Model mentioned brand only to deny familiarity — not counted as recognition'
            : 'No product description — brand unknown to model',
      tech.schemaPresent
        ? 'schema.org markup detected on homepage — machine-readable'
        : tech.jsOnly
          ? 'Homepage appears JS-rendered — limited crawlable text content'
          : '0 schema.org types on homepage — no structured data for AI crawlers',
      ...(tech.robotsBlocked && tech.blockedAgents.length
        ? [`${tech.blockedAgents.length} AI crawler(s) blocked in robots.txt: ${tech.blockedAgents.slice(0, 3).join(', ')}`]
        : !tech.robotsFetched
          ? ['robots.txt not accessible — crawler permissions unknown']
          : [])
    ];

    res.json({
      score, brandMentioned, citedCorrectly, crawlable, brandDenied,
      schemaPresent: tech.schemaPresent, robotsBlocked: tech.robotsBlocked,
      blockedAgents: tech.blockedAgents, robotsFetched: tech.robotsFetched, jsOnly: tech.jsOnly,
      q1, q2, brand, domain, reasons,
      q1Answer: r1.answer, q2Answer: r2.answer,
      q1Mentioned: !!r1.mentions_affirmatively, q2Mentioned: !!r2.mentions_affirmatively,
      benchmarkAvg, benchmarkCategory,
      pxFound: px.found, pxContext: px.context || null, pxError: px.error || null,
      competitors
    });
  } catch (err) {
    console.error('[ai-visibility]', err.message);
    res.status(500).json({ error: 'Check failed. Please try again.' });
  }
});

app.get('/api/teardown-count', async (req, res) => {
  const MAIN_PAGES = new Set([
    'index.html','teardowns.html','glossary.html','scorecard.html','architecture.html',
    'why-saas-emails-get-opened-but-not-clicked.html','how-to-fix-saas-email-ctr.html',
    'saas-email-conversion-failure.html','email-architecture-audit.html',
  ]);
  try {
    const ghRes = await fetch('https://api.github.com/repos/strategicflow-tech/showcase/contents/', {
      headers: { Authorization: `token ${process.env.GITHUB_TOKEN}`, 'User-Agent': 'strategic-flow' }
    });
    const files = await ghRes.json();
    const count = Array.isArray(files)
      ? files.filter(f => f.type === 'file' && f.name.endsWith('.html') && !MAIN_PAGES.has(f.name)).length
      : 0;
    return res.json({ count });
  } catch {}
  // Fallback: DB → env
  try {
    const r = await pool.query(`SELECT value FROM system_config WHERE key = 'teardown_count'`);
    if (r.rows.length) return res.json({ count: parseInt(r.rows[0].value, 10) });
  } catch {}
  res.json({ count: parseInt(process.env.TEARDOWN_COUNT, 10) || 0 });
});

app.use(express.static('public'));

// ── ROOT — always serve app (no auth wall for free users) ─────────────────────
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// ── POST /auth/magic — send magic link ───────────────────────────────────────
app.post('/auth/magic', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 15 * 60 * 1000;
  magicTokens.set(token, { email, expires });

  const baseUrl = process.env.APP_URL || 'https://strategic-flow-audit.replit.app';
  const magicLink = `${baseUrl}/auth/verify/${token}`;

  try {
    const sendResult = await resend.emails.send({
      from: 'Strategic Flow <noreply@strategicflow.tech>',
      to: email,
      subject: 'Your Strategic Flow sign-in link',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#ffffff;color:#111111;padding:40px 32px;border:1px solid #e5e7eb;">
          <p style="font-size:11px;letter-spacing:0.1em;color:#6b7280;text-transform:uppercase;margin:0 0 32px;">Strategic Flow</p>
          <h2 style="font-size:24px;margin:0 0 16px;font-weight:600;color:#111111;">Your sign-in link</h2>
          <p style="font-size:15px;color:#6b7280;margin:0 0 32px;line-height:1.6;">Click the button below to sign in. This link expires in 15 minutes and can only be used once.</p>
          <a href="${magicLink}" style="display:inline-block;background:#4A8FE7;color:#ffffff;padding:14px 28px;text-decoration:none;font-size:14px;font-weight:600;margin-bottom:32px;">Sign in to Strategic Flow →</a>
          <p style="font-size:12px;color:#9ca3af;margin:0;line-height:1.6;">If you didn't request this, ignore this email. Your account is safe.<br>Link expires: ${new Date(expires).toUTCString()}</p>
        </div>
      `
    });
    console.log('[auth/magic] Magic link sent to:', email, '| Resend ID:', sendResult?.data?.id || JSON.stringify(sendResult));
  } catch (e) {
    console.error('[auth/magic] Resend error:', e.message, e);
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
  if (BYPASS_EMAILS.has(data.email)) {
    return res.redirect('/architecture-dashboard');
  }
  try {
    const r = await pool.query('SELECT tier, expires_at, access_type FROM users WHERE email = $1', [data.email.toLowerCase().trim()]);
    const row = r.rows[0];
    if (row?.tier === 'architecture') {
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return res.redirect('/access-expired');
      }
      return res.redirect('/architecture-dashboard');
    }
  } catch (e) {
    console.error('[auth/verify] tier check error:', e.message);
  }
  res.redirect('/');
});

// ── GET /architecture-dashboard ──────────────────────────────────────────────
app.get('/architecture-dashboard', async (req, res) => {
  if (!req.session || !req.session.userEmail) return res.redirect('/login.html');
  if (BYPASS_EMAILS.has(req.session.userEmail)) {
    return res.sendFile('architecture-dashboard.html', { root: path.join(__dirname, 'public') });
  }
  try {
    const r = await pool.query('SELECT tier, expires_at FROM users WHERE email = $1', [req.session.userEmail.toLowerCase().trim()]);
    const row = r.rows[0];
    if (row?.tier === 'architecture') {
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return res.redirect('/access-expired');
      }
      return res.sendFile('architecture-dashboard.html', { root: path.join(__dirname, 'public') });
    }
  } catch (e) {
    console.error('[architecture-dashboard] tier check error:', e.message);
  }
  res.redirect('/');
});

// ── GET /fatigue-detector ─────────────────────────────────────────────────────
app.get('/fatigue-detector', async (req, res) => {
  if (!req.session || !req.session.userEmail) return res.redirect('/login.html');
  if (BYPASS_EMAILS.has(req.session.userEmail)) {
    return res.sendFile('fatigue-detector.html', { root: path.join(__dirname, 'public') });
  }
  try {
    const r = await pool.query('SELECT tier, expires_at FROM users WHERE email = $1', [req.session.userEmail.toLowerCase().trim()]);
    const row = r.rows[0];
    if (row?.tier === 'architecture') {
      if (row.expires_at && new Date(row.expires_at) < new Date()) return res.redirect('/access-expired');
      return res.sendFile('fatigue-detector.html', { root: path.join(__dirname, 'public') });
    }
  } catch (e) { console.error('[fatigue-detector] tier check:', e.message); }
  res.redirect('/');
});

// ── GET /access-expired ───────────────────────────────────────────────────────
app.get('/access-expired', (req, res) => {
  res.sendFile('access-expired.html', { root: path.join(__dirname, 'public') });
});

// ── GET /admin ────────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  if (!req.session || !req.session.userEmail) return res.redirect('/login.html');
  if (!BYPASS_EMAILS.has(req.session.userEmail)) return res.redirect('/');
  res.sendFile('index.html', { root: path.join(__dirname, 'public') });
});

// ── GET /predict ──────────────────────────────────────────────────────────────
app.get('/predict', (req, res) => res.redirect(301, 'https://strategic-flow-pro.replit.app/predict'));

// ── Audit page redirects (.html → -page) ──────────────────────────────────────
app.get('/changelog-audit.html', (req, res) => res.redirect(301, '/changelog-audit-page'));
app.get('/onboarding-audit.html', (req, res) => res.redirect(301, '/onboarding-audit-page'));
app.get('/linkedin-audit.html', (req, res) => res.redirect(301, '/linkedin-audit-page'));

// ── POST /auth/logout ─────────────────────────────────────────────────────────
app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
app.get('/auth/me', (req, res) => {
  if (req.session && req.session.userEmail) {
    const email = req.session.userEmail;
    return res.json({ email, signedIn: true, isAdmin: BYPASS_EMAILS.has(email) });
  }
  res.json({ signedIn: false, isAdmin: false });
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
  // Add guest trial columns if not present (idempotent)
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS access_type VARCHAR(50) DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS expires_at  TIMESTAMP  DEFAULT NULL;
  `);
  // Insert/update guest trial user
  await pool.query(`
    INSERT INTO users (email, tier, access_type, expires_at, vip)
    VALUES ('leah.miranda@zapier.com', 'architecture', 'guest_trial', NOW() + INTERVAL '3 days', false)
    ON CONFLICT (email) DO UPDATE SET
      tier        = 'architecture',
      access_type = 'guest_trial',
      expires_at  = NOW() + INTERVAL '3 days'
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      source        TEXT DEFAULT 'checklist',
      subscribed_at TIMESTAMPTZ DEFAULT NOW(),
      sent          BOOLEAN DEFAULT FALSE
    )
  `).catch(e => console.error('[DB] subscribers:', e.message));
  await pool.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS seq1_sent BOOLEAN DEFAULT FALSE`).catch(()=>{});
  await pool.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS seq2_sent BOOLEAN DEFAULT FALSE`).catch(()=>{});
  await pool.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS seq3_sent BOOLEAN DEFAULT FALSE`).catch(()=>{});
  await pool.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS seq4_sent BOOLEAN DEFAULT FALSE`).catch(()=>{});
  await pool.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS seq5_sent BOOLEAN DEFAULT FALSE`).catch(()=>{});
  await pool.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS seq6_sent BOOLEAN DEFAULT FALSE`).catch(()=>{});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demo_rebuilds (
      hash TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(e => console.error('[DB] demo_rebuilds:', e.message));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pro_users (
      id                      SERIAL PRIMARY KEY,
      email                   TEXT UNIQUE NOT NULL,
      stripe_customer_id      TEXT,
      stripe_subscription_id  TEXT,
      status                  TEXT DEFAULT 'active',
      magic_token             TEXT,
      magic_token_expires_at  TIMESTAMPTZ,
      created_at              TIMESTAMPTZ DEFAULT NOW(),
      last_login_at           TIMESTAMPTZ
    )
  `).catch(e => console.error('[DB] pro_users:', e.message));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS why_analyses (
      id                SERIAL PRIMARY KEY,
      user_email        TEXT NOT NULL REFERENCES pro_users(email) ON DELETE CASCADE,
      action_type       TEXT NOT NULL DEFAULT 'analyze',
      content_type      TEXT,
      input_excerpt     TEXT,
      diagnosis_summary TEXT,
      score             INTEGER,
      full_result_json  TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(e => console.error('[DB] why_analyses:', e.message));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS index_companies (
      id                SERIAL PRIMARY KEY,
      slug              TEXT UNIQUE NOT NULL,
      name              TEXT NOT NULL,
      domain            TEXT NOT NULL,
      content_type      TEXT NOT NULL,
      score             NUMERIC(3,1) NOT NULL,
      patterns          JSONB NOT NULL,
      diagnosis_summary TEXT NOT NULL,
      input_excerpt     TEXT,
      checks            JSONB,
      content_length    INTEGER,
      scored_at         TIMESTAMPTZ DEFAULT now()
    )
  `).catch(e => console.error('[DB] index_companies:', e.message));
  await pool.query(`ALTER TABLE index_companies ADD COLUMN IF NOT EXISTS checks JSONB`).catch(e => console.error('[DB] index_companies.checks:', e.message));
  await pool.query(`ALTER TABLE index_companies ADD COLUMN IF NOT EXISTS content_length INTEGER`).catch(e => console.error('[DB] index_companies.content_length:', e.message));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS index_content_samples (
      id                SERIAL PRIMARY KEY,
      company_slug      TEXT NOT NULL REFERENCES index_companies(slug) ON DELETE CASCADE,
      content_type      TEXT NOT NULL,
      score             NUMERIC(3,1) NOT NULL,
      patterns          JSONB NOT NULL,
      checks            JSONB,
      diagnosis_summary TEXT NOT NULL,
      input_excerpt     TEXT,
      content_length    INTEGER,
      source_url        TEXT,
      scored_at         TIMESTAMPTZ DEFAULT now()
    )
  `).catch(e => console.error('[DB] index_content_samples:', e.message));
  await pool.query(`
    INSERT INTO index_content_samples (company_slug, content_type, score, patterns, checks, diagnosis_summary, input_excerpt, content_length, scored_at)
    SELECT c.slug, c.content_type, c.score, c.patterns, c.checks, c.diagnosis_summary, c.input_excerpt, c.content_length, c.scored_at
    FROM index_companies c
    WHERE NOT EXISTS (
      SELECT 1 FROM index_content_samples s WHERE s.company_slug = c.slug
    )
  `).catch(e => console.error('[DB] index_content_samples backfill:', e.message));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS why_jobs (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      status        TEXT NOT NULL DEFAULT 'pending',
      job_type      TEXT NOT NULL,
      content_type  TEXT,
      input_excerpt TEXT,
      result_json   TEXT,
      error_message TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      completed_at  TIMESTAMPTZ
    )
  `).catch(e => console.error('[DB] why_jobs:', e.message));

  await pool.query(`ALTER TABLE why_jobs ADD COLUMN IF NOT EXISTS raw_response_snippet TEXT`)
    .catch(e => console.error('[DB] why_jobs raw_response_snippet col:', e.message));

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
    return newsletter_count < 2 ? { allowed: true } : { allowed: false, reason: tier === 'free_trial' ? 'trial_used' : 'single_used' };
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
  // Layer 5: depth-tracking brace extractor — catches trailing prose after a valid JSON object.
  // Returns null for genuinely truncated JSON (depth never returns to 0).
  try {
    const start = raw.indexOf('{');
    if (start !== -1) {
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = start; i < raw.length; i++) {
        const c = raw[i];
        if (esc) { esc = false; continue; }
        if (c === '\\' && inStr) { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end !== -1) return JSON.parse(raw.slice(start, end + 1));
    }
  } catch (_) {}
  // Layer 6: all attempts failed — return null so callers can show a clean error
  const _r = raw || '';
  console.warn('[safeParseJSON] all layers failed. Length:', _r.length,
    '\n  FIRST 400:', _r.slice(0, 400),
    '\n  LAST  400:', _r.slice(-400));
  return null;
}

// Guard that converts any value to a safe string for HTML injection.
// Returns '' for null, undefined, 'undefined', 'null', or NaN values.
const safeVal = (val) => {
  if (val === null || val === undefined || val === 'undefined' || val === 'null' || (typeof val === 'number' && isNaN(val))) return '';
  return String(val).trim();
};

const JSON_SYSTEM_INSTRUCTION = 'Return ONLY valid JSON. Use straight ASCII quotes only — no curly quotes (\u201C\u201D\u2018\u2019), no em dashes (\u2014), no en dashes (\u2013), no ellipsis characters (\u2026), no non-breaking spaces, no other Unicode. No markdown fences. No text before or after the JSON object.';

async function claudeJSON(prompt, maxTokens = 2000, debugTag = null) {
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
      console.log(`[claudeJSON] response length=${raw.length} stop_reason=${msg.stop_reason}`);
      if (debugTag) {
        console.error(`[${debugTag}] RAW_RESPONSE:`, raw.slice(0, 800));
      }
      if (msg.stop_reason === 'max_tokens') {
        console.warn('[claudeJSON] TRUNCATED — hit max_tokens limit. Response cut off. Increase max_tokens or shorten prompt.');
      }
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
    return `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${statBorderColor};border-radius:8px;margin:0;"><tr class="stat-row">${cells}</tr></table>`;
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
  .email-outer-td { padding: 0 !important; }
  .email-section-pad { padding: 20px 16px !important; }
  .stat-row td { display:block !important; width:100% !important; border-left:none !important; text-align:center !important; }
  h1 { font-size:20px !important; }
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
    ${['lite','growth','high_impact','architecture'].includes(tier)
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
      if (user.newsletter_count >= 2) {
        return res.json({ status: 'trial_used' });
      }
      return res.json({ status: 'free_trial', tier: 'free_trial', used: user.newsletter_count, limit: 2, tierName: 'Free Trial' });
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

    // Prefer <article> or <main> content to avoid sidebar/ticker contamination.
    // Falls back to full-page extraction only when no semantic block is found.
    const _articleBlock = html.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i)?.[1];
    const _extractSrc = _articleBlock || html;
    const stripped = sanitizeForJSON(
      _extractSrc
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
    const ALLOWED_TIERS = new Set(['free_trial','single','lite','growth','high_impact','architecture']);

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
    const promptTier = (tier === 'free_trial' || tier === 'architecture') ? 'high_impact' : tier;

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
          claudeJSON(prompt, 8000)
        ]);
        if (dnaSettled.status === 'fulfilled' && dnaSettled.value) {
          effectiveBrandDNA = dnaSettled.value;
          if (dnaSettled.value.voiceProfile && !effectiveVoice) effectiveVoice = dnaSettled.value.voiceProfile;
          console.log(`[brand-parallel] source=${dnaSettled.value.source} colors=${dnaSettled.value.colors?.length}`);
        }
        result = claudeSettled.status === 'fulfilled' ? claudeSettled.value : null;
      } else {
        result = await claudeJSON(prompt, 8000);
      }
      console.log('[generate] parsed result keys:', result ? Object.keys(result) : 'NULL',
        '| has headline:', !!result?.headline,
        '| has body[]:', Array.isArray(result?.body),
        '| has rebuilt_subject:', !!result?.rebuilt_subject,
        '| has rebuilt_body:', !!result?.rebuilt_body);
    }

    // Apply forceDark after brand DNA resolves — keyword match wins over any inferred theme
    if (forceDark) {
      effectiveBrandDNA = effectiveBrandDNA || {};
      effectiveBrandDNA = { ...effectiveBrandDNA, theme: 'dark' };
      console.log('[dark-detect] body keyword match → theme forced dark');
    }

    // Normalize flat JSON format (new) → internal representation used by the rest of the pipeline
    // Also handles featureCards-only types (thought_leadership, event_announcement, product_update)
    // where Claude is explicitly told NOT to return body[] — featureCards replaces body[] in those cases.
    if (result && result.headline && (Array.isArray(result.body) || Array.isArray(result.featureCards))) {
      result.body = Array.isArray(result.body) ? result.body : [];
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

    // Safety net: if Claude returned a headline but rebuilt_subject is still missing
    // (e.g. featureCards path, or Claude omitted the field), fall back to original subject.
    if (result && result.headline && !result.rebuilt_subject) {
      result.rebuilt_subject = result.subject || subject;
      console.log('[generate] rebuilt_subject fallback applied from original subject');
    }

    console.log('STEP 3: Claude generation complete');
    // Guard: Claude must have returned a parseable object with the two critical fields.
    // If either is missing, surface a clean error rather than rendering "undefined" everywhere.
    if (!result || !safeVal(result.rebuilt_subject) || (!safeVal(result.rebuilt_body) && !result._flatFields)) {
      console.error('[generate] Guard fired — result null or missing critical fields.',
        'result=', result === null ? 'NULL' : JSON.stringify(Object.keys(result || {})),
        'rebuilt_subject=', result?.rebuilt_subject,
        'rebuilt_body length=', (result?.rebuilt_body || '').length,
        '_flatFields=', !!result?._flatFields);
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
        originalBody:   (() => {
          const _ob = _pastedBody || body || '';
          if (_ob.length >= 100) return _ob.length > 600 ? _ob.slice(0, 600) + '...' : _ob;
          // When only a URL was submitted (no pasted body), fall back to the fetched article content
          const _fb = typeof effectiveBody === 'string'
            ? effectiveBody.replace(/^(?:Headline|Summary):[^\n]+\n*/gm, '').trim()
            : '';
          return _fb.length > 600 ? _fb.slice(0, 600) + '...' : _fb;
        })(),
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
    const _newCount = adminAccess ? user.newsletter_count : user.newsletter_count + 1;
    res.json({ ...result, newsletterId, emailType: finalEmailType, downloadHtml, previewBody, tier, analyzedPage, rebuildPath: 'rebuilt', originalScore: null, inferredBrandDNA: brandDNASource ? effectiveBrandDNA : undefined, showcaseHtml, originalBody: _origBodyClient, newsletterCount: _newCount });
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
    if ((tier === 'high_impact' || tier === 'architecture') && user?.vip && !adminAccess) {
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
      model: MODEL,
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
  const { subject, body, company, subscribers, industry, emailsPerMonth, contentType, url } = req.body;
  const ct = contentType || 'email';
  const contentTypeLabel = { email: 'SaaS email', blog_post: 'blog post', product_update: 'product update announcement', feature_guide: 'feature guide' }[ct] || 'SaaS email';

  if (!subject || !body) {
    return res.status(400).json({ error: 'subject and body are required' });
  }

  const jobId = makeJobId();
  await setJob(jobId, { status: 'pending' });
  res.json({ jobId });

  (async () => {
    try {
      const bugsByType = {
        email: `1. Filing label subject — subject announces the product, not the reader's problem
2. Caveat opener — email opens with disclaimer/rollout notice before value
3. Feature-first language — describes architecture not reader outcome
4. Flat visual hierarchy — major and minor updates at same visual weight
5. Zero quantified claims — no numbers, benchmarks, or time-saved data
6. Weak or missing CTA — no ownership language ("Learn more" vs "Fix my X")
7. Buried contrast — before/after comparison hidden in fine print`,

        blog_post: `1. Filing label title — title announces the topic, not the reader's problem
2. Caveat opener — post opens with context or disclaimer before reader consequence
3. Feature-first language — describes what the product does, not what the reader gains
4. Flat section hierarchy — all sections at equal weight, no clear priority
5. Zero quantified claims — no numbers, benchmarks, or specific outcomes
6. Weak or missing CTA — no ownership language
7. Buried contrast — benefit comparison hidden deep in the post`,

        product_update: `1. Filing label title — title announces the feature, not the unblocked problem
2. Caveat opener — opens with rollout notice before user consequence
3. Feature-first language — describes the feature not the workflow outcome
4. Flat hierarchy — all updates at same visual weight regardless of impact
5. Zero quantified claims — no time saved, no specific improvement data
6. Weak or missing CTA — no ownership language
7. Buried contrast — improvement over old behaviour not surfaced`,

        feature_guide: `1. Filing label title — title announces capability, not the reader's pain
2. Caveat opener — opens with technical context before naming the reader's problem
3. Feature-first language — explains what the feature does before what changes for the user
4. Flat section hierarchy — sections organised by product taxonomy, not reader situation
5. Zero quantified claims — no workflows named, no time saved, no user outcome
6. Weak or missing CTA — brand offer language not reader action language
7. Buried contrast — no comparison to reader's current manual or broken workflow`,
      };

      const diagnosticPrompt = `You are the Strategic Flow diagnostic engine. Analyse this ${contentTypeLabel} for structural failures.

Company: ${company || 'Unknown'}
${url ? `URL: ${url}` : ''}
Title/Subject: ${subject}
Body:
${body.slice(0, 3000)}

Run the 7-bug diagnostic. For each bug found, return it in the bugs array.

The 7 structural bugs to check:
${bugsByType[ct] || bugsByType.email}

Also assign a Strategic Flow score from 1-10 where:
1-3 = 5+ bugs present
4-6 = 3-4 bugs present
7-8 = 1-2 bugs present
9-10 = 0 bugs, consequence-first architecture throughout

Return ONLY valid JSON:
{
  "score": <number 1-10>,
  "bugs": [
    { "name": "<bug name>", "description": "<one sentence explaining the specific problem in this ${contentTypeLabel}>" }
  ],
  "currentOpenRate": <estimated engagement rate as decimal e.g. 0.18>,
  "assessment": "<two sentence overall diagnostic>"
}`;

      const diagnostic = await claudeJSON(diagnosticPrompt, 2000);
      if (!diagnostic) throw new Error('Diagnostic failed');

      const rebuildPrompt = `You are the Strategic Flow rebuild engine. Apply the Strategic Flow Method to rebuild this ${contentTypeLabel}.

Company: ${company || 'Unknown'}
Industry: ${industry || 'saas'}
${url ? `Original URL: ${url}` : ''}
Original title/subject: ${subject}
Original body:
${body.slice(0, 3000)}

Diagnostic score: ${diagnostic.score}/10
Bugs found: ${(diagnostic.bugs || []).map(b => b.name).join(', ')}

Apply all 5 Strategic Flow fixes:
Fix 1: Consequence-first title — announces reader's failure state, not the product
Fix 2: Subtitle or preview text that completes the title thought
Fix 3: Hook that names the consequence the reader is already experiencing
Fix 4: Single CTA with ownership language ("Connect my AI to my apps" not "Get started free")
Fix 5: Sections organised by reader situation, not by product feature taxonomy

Return ONLY valid JSON:
{
  "rebuiltScore": <number 7-10>,
  "projectedOpenRate": <decimal e.g. 0.29>,
  "abSubjects": [
    { "subject": "<variant 1 — curiosity gap>", "openRate": "<e.g. 29%>" },
    { "subject": "<variant 2 — consequence-first>", "openRate": "<e.g. 31%>" },
    { "subject": "<variant 3 — specific number or name>", "openRate": "<e.g. 28%>" }
  ],
  "rebuiltBody": "<full rebuilt ${contentTypeLabel} body as plain HTML, consequence-first>",
  "whatChanged": [
    { "fix": "Fix 1 — Title", "before": "<original>", "after": "<rebuilt>", "why": "<one sentence diagnostic reason>" },
    { "fix": "Fix 2 — Preview / subtitle", "before": "<original or inferred>", "after": "<rebuilt>", "why": "<reason>" },
    { "fix": "Fix 3 — Hook", "before": "<original first line>", "after": "<rebuilt first line>", "why": "<reason>" },
    { "fix": "Fix 4 — CTA", "before": "<original CTA>", "after": "<rebuilt CTA>", "why": "<reason>" }
  ]
}`;

      const rebuild = await claudeJSON(rebuildPrompt, 3500, 'REBUILD');
      console.error('[REBUILD] parsed keys:', rebuild ? Object.keys(rebuild).join(', ') : 'null — parse failed');
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
        },
        contentType: ct,
        url: url || null
      };

      await setJob(jobId, { status: 'complete', result });

      // Persist to newsletters so /api/monthly-report can read it
      const archEmail = req.session?.userEmail || null;
      if (archEmail) {
        try {
          await pool.query(`
            INSERT INTO newsletters
              (email, company, original_subject, original_body, rebuilt_subject, rebuilt_body,
               tier, rebuild_path, conversion_score, ab_subjects, content_calendar)
            VALUES ($1,$2,$3,$4,$5,$6,'architecture','architecture',$7,$8,$9)
          `, [
            archEmail,
            company || null,
            subject,
            body ? body.slice(0, 5000) : null,
            rebuild.abSubjects?.[0]?.subject || null,
            rebuild.rebuiltBody ? rebuild.rebuiltBody.slice(0, 10000) : null,
            JSON.stringify({ score: diagnostic.score, rebuiltScore: rebuild.rebuiltScore || 9 }),
            rebuild.abSubjects ? JSON.stringify(rebuild.abSubjects) : null,
            calendar?.follow_ups ? JSON.stringify(calendar.follow_ups) : null
          ]);
        } catch (dbErr) {
          console.error('[architecture] newsletters save failed:', dbErr.message);
        }
      }

    } catch (err) {
      console.error('[architecture] job failed:', err.message);
      await setJob(jobId, { status: 'failed', error: err.message });
    }
  })();
});
// ─── END ARCHITECTURE ENDPOINT ────────────────────────────────────────────────

// ─── FATIGUE DETECTOR ─────────────────────────────────────────────────────────
app.post('/api/fatigue-detector', async (req, res) => {
  const { emails } = req.body;
  if (!Array.isArray(emails) || emails.length < 2) {
    return res.status(400).json({ error: 'At least 2 emails are required.' });
  }
  const clipped = emails.slice(0, 12);

  const emailsText = clipped.map((e, i) =>
    `EMAIL ${i + 1}:\nSubject: ${e.subject || '(no subject)'}\nBody:\n${(e.body || '(no body)').slice(0, 1500)}`
  ).join('\n\n---\n\n');

  const prompt = `You are the Strategic Flow Fatigue Detector. Analyze the following email sequence (${clipped.length} emails) as a unit and return a complete diagnostic.

${emailsText}

Return ONLY valid JSON with this exact structure:
{
  "sequenceScore": {
    "overall": <number 1-10>,
    "coherence": <number 1-10 — how well emails build on each other>,
    "ctaVariety": <number 1-10 — 10 = fully varied CTAs, 1 = all identical>,
    "hookDiversity": <number 1-10 — 10 = all opening lines structurally distinct>,
    "cadenceRisk": <number 1-10 — 10 = low fatigue risk, 1 = critical fatigue risk>,
    "summary": "<2-3 sentence overall sequence diagnostic>"
  },
  "ctaFatigue": {
    "verdict": "<VARIED | FATIGUED | CRITICAL>",
    "ctaList": [
      { "email": <email number>, "cta": "<exact CTA text>", "verb": "<opening verb>" }
    ],
    "duplicates": [
      { "verb": "<verb>", "emails": [<email numbers using this verb>] }
    ]
  },
  "narrativeDrift": {
    "driftDetected": <true | false>,
    "breakEmail": <email number where drift starts, or null>,
    "summary": "<1-2 sentence explanation of drift or coherence>",
    "findings": [
      { "label": "<short label>", "text": "<finding>", "detail": "<optional extra context>", "severity": "<ok | warning | critical>" }
    ]
  },
  "hookRecycling": {
    "summary": "<1-2 sentence summary of hook diversity>",
    "recycledPatterns": [
      { "pattern": "<the recycled opening structure or phrase>", "emails": [<email numbers>] }
    ]
  },
  "cadenceRisk": {
    "rating": "<LOW | MEDIUM | HIGH | CRITICAL>",
    "summary": "<1-2 sentence overall cadence assessment>",
    "recommendations": [
      { "label": "<short label>", "text": "<specific actionable recommendation>", "severity": "<info | warning | critical>" }
    ]
  }
}`;

  try {
    const result = await claudeJSON(prompt, 2000);
    if (!result) return res.status(500).json({ error: 'Analysis failed — no response from Claude.' });
      res.json(result);
  } catch (err) {
    console.error('[api/fatigue-detector]', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── END FATIGUE DETECTOR ─────────────────────────────────────────────────────

// ── GET /audience-mirror ──────────────────────────────────────────────────────
app.get('/audience-mirror', async (req, res) => {
  if (BYPASS_EMAILS.has(req.session.userEmail)) {
    return res.sendFile('audience-mirror.html', { root: path.join(__dirname, 'public') });
  }
  try {
    const row = await db.oneOrNone('SELECT tier FROM users WHERE email=$1', [req.session.userEmail]);
    if (row?.tier === 'architecture') {
      return res.sendFile('audience-mirror.html', { root: path.join(__dirname, 'public') });
    }
  } catch (e) { console.error('[audience-mirror] tier check:', e.message); }
  res.redirect('/');
});

app.post('/api/audience-mirror', async (req, res) => {
  const { customerText, productContext } = req.body;
  if (!customerText || customerText.trim().length < 30) {
    return res.status(400).json({ error: 'Please provide at least 5 lines of customer language.' });
  }

  const contextLine = productContext
    ? `\nProduct context provided by the team: "${productContext.slice(0, 200)}"`
    : '\nNo product context provided.';

  const prompt = `You are the Strategic Flow Audience Mirror. Analyze the following raw customer language and extract actionable email copy elements.

CUSTOMER LANGUAGE INPUT:
${customerText.slice(0, 6000)}
${contextLine}

Return ONLY valid JSON with this exact structure:
{
  "languageMap": {
    "signalStrength": "<STRONG | MODERATE | WEAK>",
    "summary": "<1-2 sentence overview of the most dominant language patterns>",
    "phrases": [
      { "phrase": "<exact verbatim phrase or word cluster from customer text>", "frequency": <number of times pattern appears or is implied> }
    ]
  },
  "painHierarchy": {
    "signalStrength": "<STRONG | MODERATE | WEAK>",
    "pains": [
      {
        "label": "<short pain name, 3-6 words>",
        "frequency": "<High | Medium | Low>",
        "intensity": "<High | Medium | Low>",
        "specificity": "<Specific | Vague>",
        "quote": "<exact verbatim quote from input that best represents this pain>"
      }
    ]
  },
  "beforeAfterVocab": {
    "signalStrength": "<STRONG | MODERATE | WEAK>",
    "before": ["<exact phrase describing life WITH the problem>"],
    "after": ["<exact phrase describing life AFTER solving it>"],
    "note": "<1 sentence on how to use these in email copy>"
  },
  "wordsToAvoid": {
    "summary": "<1 sentence>",
    "flagged": [
      { "word": "<marketing word from product context>", "reason": "Your team says \\"X\\". Your customers never do." }
    ]
  },
  "hooks": [
    { "text": "<subject line hook built from customer language — not from marketing copy>", "type": "<curiosity gap | consequence-first | social proof>" }
  ]
}

Rules:
- languageMap.phrases: minimum 5, maximum 12, ranked by frequency descending. Extract verbatim phrases — do NOT paraphrase.
- painHierarchy.pains: exactly 3, ranked by combined frequency + intensity.
- beforeAfterVocab: minimum 3 phrases per column. Extract verbatim from input.
- wordsToAvoid.flagged: only flag words that appear in the product context but are absent from customer language. If no product context, return empty array.
- hooks: exactly 5, each with a different type tag. Built strictly from customer vocabulary, never from marketing language.`;

  try {
    const result = await claudeJSON(prompt, 2500);
    if (!result) return res.status(500).json({ error: 'Analysis failed — no response from Claude.' });
      res.json(result);
  } catch (err) {
    console.error('[api/audience-mirror]', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── END AUDIENCE MIRROR ──────────────────────────────────────────────────────

// ── GET /dead-email-resurrector ───────────────────────────────────────────────
app.get('/dead-email-resurrector', async (req, res) => {
  if (BYPASS_EMAILS.has(req.session.userEmail)) {
    return res.sendFile('dead-email-resurrector.html', { root: path.join(__dirname, 'public') });
  }
  try {
    const row = await db.oneOrNone('SELECT tier FROM users WHERE email=$1', [req.session.userEmail]);
    if (row?.tier === 'architecture') {
      return res.sendFile('dead-email-resurrector.html', { root: path.join(__dirname, 'public') });
    }
  } catch (e) { console.error('[dead-email-resurrector] tier check:', e.message); }
  res.redirect('/');
});

app.post('/api/dead-email-resurrector', async (req, res) => {
  const { subject, body, openRate, clickRate, goal } = req.body;
  if (!subject || !body) {
    return res.status(400).json({ error: 'Subject line and email body are required.' });
  }

  const perfLine = [
    openRate ? `Open rate: ${openRate}` : null,
    clickRate ? `Click rate: ${clickRate}` : null,
    goal ? `Email goal: ${goal}` : null,
  ].filter(Boolean).join(' · ') || 'No performance data provided.';

  const prompt = `You are the Strategic Flow Dead Email Resurrector. Diagnose why this email underperformed using the 6 Strategic Flow failure patterns, then deliver a complete rebuilt version.

ORIGINAL EMAIL:
Subject: ${subject}
Body:
${body.slice(0, 3000)}

Performance data: ${perfLine}

The 6 Strategic Flow failure patterns:
1. Filing Label Subject — subject announces topic, names no consequence
2. Feature Dump — lists capabilities instead of translating to outcomes
3. Buried Lead — buries the most important point after preamble
4. Weak CTA — uses passive verbs (learn, discover, explore) instead of ownership verbs
5. Context Overload — too much background before the point
6. Single-Reader Blindspot — written for the company, not for the specific reader's situation

Return ONLY valid JSON with this exact structure:
{
  "causeOfDeath": {
    "summary": "<1-2 sentence overall diagnosis>",
    "patterns": [
      {
        "name": "<exact pattern name from the 6 above>",
        "severity": "<CRITICAL | MAJOR | MINOR>",
        "quote": "<exact line from original email that triggered this pattern>",
        "why": "<one sentence explaining why this pattern killed performance>"
      }
    ]
  },
  "resurrectionScore": {
    "originalScore": <number 1-10>,
    "projectedScore": <number 1-10>,
    "openRateLift": "<e.g. +4-6%>",
    "clickRateLift": "<e.g. +0.8-1.2%>",
    "note": "<optional 1-sentence caveat about the estimates>"
  },
  "rebuiltEmail": {
    "subject": "<new subject line — curiosity gap or consequence-first, under 55 chars>",
    "previewText": "<preview text that extends subject, never repeats it, under 90 chars>",
    "lead": "<rebuilt lead — consequence before context, max 2 sentences>",
    "body": "<rebuilt body — feature-to-outcome translation, 3-5 sentences>",
    "cta": "<rebuilt CTA — ownership verb + specific outcome, max 6 words>"
  },
  "whatChanged": [
    "<what was wrong → what was fixed → why it improves performance — specific to this email, never generic>"
  ]
}

Rules:
- causeOfDeath.patterns: minimum 2, maximum 5. Only include patterns actually present in this email.
- resurrectionScore: originalScore must reflect actual quality; projectedScore must be realistically higher.
- rebuiltEmail: write a complete, ready-to-send email. No placeholders. Subject under 55 chars.
- whatChanged: 3-5 items, each formatted as "What was wrong → what was fixed → why it improves performance." Specific to this email only.`;

  try {
    const result = await claudeJSON(prompt, 2500);
    if (!result) return res.status(500).json({ error: 'Resurrection failed — no response from Claude.' });
      res.json(result);
  } catch (err) {
    console.error('[api/dead-email-resurrector]', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── END DEAD EMAIL RESURRECTOR ───────────────────────────────────────────────

// ── GET /best-send-window ─────────────────────────────────────────────────────
app.get('/best-send-window', async (req, res) => {
  if (BYPASS_EMAILS.has(req.session.userEmail)) {
    return res.sendFile('best-send-window.html', { root: path.join(__dirname, 'public') });
  }
  try {
    const row = await db.oneOrNone('SELECT tier FROM users WHERE email=$1', [req.session.userEmail]);
    if (row?.tier === 'architecture') {
      return res.sendFile('best-send-window.html', { root: path.join(__dirname, 'public') });
    }
  } catch (e) { console.error('[best-send-window] tier check:', e.message); }
  res.redirect('/');
});

app.post('/api/best-send-window', async (req, res) => {
  const { emailType, industry, geography, listSize, knownData } = req.body;
  if (!emailType || !industry || !geography || !listSize) {
    return res.status(400).json({ error: 'Email type, industry, geography, and list size are required.' });
  }

  const knownLine = knownData ? `\nAdditional context from the team: ${knownData.slice(0, 400)}` : '';

  const prompt = `You are the Strategic Flow Best Send Window calculator. Based on the inputs below, calculate the optimal send window and output a complete scheduling recommendation.

Email type: ${emailType}
Industry: ${industry}
Audience geography: ${geography}
List size: ${listSize}${knownLine}

Return ONLY valid JSON with this exact structure:
{
  "optimalWindow": {
    "primary": {
      "day": "<day of week>",
      "timeWindow": "<e.g. 9:00–10:30 AM recipient local time>",
      "confidence": "<HIGH | MEDIUM | VARIES BY SEGMENT>"
    },
    "secondary": {
      "day": "<day of week>",
      "timeWindow": "<time range>",
      "confidence": "<HIGH | MEDIUM | VARIES BY SEGMENT>"
    }
  },
  "whyThisWindow": [
    "<specific reason tied to email type and industry — not generic. 1-2 sentences each.>"
  ],
  "daysToAvoid": [
    { "slot": "<e.g. Monday before 9am>", "reason": "<specific reason why this slot underperforms for this email type and audience>" }
  ],
  "weeklyCal": {
    "mon": { "morning": "<green|amber|red>", "afternoon": "<green|amber|red>", "evening": "<green|amber|red>" },
    "tue": { "morning": "<green|amber|red>", "afternoon": "<green|amber|red>", "evening": "<green|amber|red>" },
    "wed": { "morning": "<green|amber|red>", "afternoon": "<green|amber|red>", "evening": "<green|amber|red>" },
    "thu": { "morning": "<green|amber|red>", "afternoon": "<green|amber|red>", "evening": "<green|amber|red>" },
    "fri": { "morning": "<green|amber|red>", "afternoon": "<green|amber|red>", "evening": "<green|amber|red>" },
    "sat": { "morning": "<green|amber|red>", "afternoon": "<green|amber|red>", "evening": "<green|amber|red>" },
    "sun": { "morning": "<green|amber|red>", "afternoon": "<green|amber|red>", "evening": "<green|amber|red>" }
  },
  "segmentSplit": {
    "singleSend": "<if list under 10K: one sentence single send recommendation — otherwise set this to null>",
    "intro": "<if list 10K+: 1 sentence intro explaining the split strategy — otherwise omit>",
    "segments": [
      { "label": "<segment description e.g. Most Engaged>", "sendTime": "<day + time>", "description": "<1 sentence on why this timing for this segment>" }
    ]
  }
}

Rules:
- whyThisWindow: exactly 3-4 reasons, each specific to the email type + industry combination provided.
- daysToAvoid: exactly 3-4 slots with specific reasoning.
- weeklyCal: every cell must be green, amber, or red. Reflect the specific email type and industry — not generic patterns.
- segmentSplit: if listSize is "Under 1K" or "1K-10K", set singleSend to a recommendation string and segments to []. If 10K+, set singleSend to null and provide 3 segments (Most Engaged, Less Engaged, Dormant).`;

  try {
    const result = await claudeJSON(prompt, 2000);
    if (!result) return res.status(500).json({ error: 'Analysis failed — no response from Claude.' });
      res.json(result);
  } catch (err) {
    console.error('[api/best-send-window]', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── END BEST SEND WINDOW ─────────────────────────────────────────────────────

// ── GET /sequence-gap-finder ──────────────────────────────────────────────────
app.get('/sequence-gap-finder', async (req, res) => {
  if (BYPASS_EMAILS.has(req.session.userEmail)) {
    return res.sendFile('sequence-gap-finder.html', { root: path.join(__dirname, 'public') });
  }
  try {
    const row = await db.oneOrNone('SELECT tier FROM users WHERE email=$1', [req.session.userEmail]);
    if (row?.tier === 'architecture') {
      return res.sendFile('sequence-gap-finder.html', { root: path.join(__dirname, 'public') });
    }
  } catch (e) { console.error('[sequence-gap-finder] tier check:', e.message); }
  res.redirect('/');
});

app.post('/api/sequence-gap-finder', async (req, res) => {
  const { emails, activationGoal, sequenceDays } = req.body;
  if (!emails || emails.length < 2) {
    return res.status(400).json({ error: 'At least 2 emails are required to detect gaps.' });
  }
  if (!activationGoal) {
    return res.status(400).json({ error: 'Activation goal is required.' });
  }

  const emailList = emails.map(e => `  Email ${e.number}: Subject: "${e.subject || '(no subject)'}" | Goal: "${e.goal || '(no goal)'}"`).join('\n');
  const daysLine = sequenceDays ? `\nSequence duration: ${sequenceDays}` : '';

  const prompt = `You are the Strategic Flow Sequence Gap Finder. Analyze the email sequence below and return a complete gap analysis.

Activation goal: ${activationGoal}${daysLine}
Number of emails: ${emails.length}

Sequence:
${emailList}

Return ONLY valid JSON with this exact structure:
{
  "narrativeArc": "<One sentence describing the overall narrative arc and where it breaks down. Example: 'Your sequence takes the reader from awareness to feature discovery but never bridges the gap between discovery and first action.'>",
  "journeyMap": [
    {
      "number": 1,
      "subject": "<email subject>",
      "readerState": "<Where is the reader mentally after receiving this email? One sentence. Specific to this email's content and goal.>",
      "status": "<green|amber|red>"
    }
  ],
  "gaps": [
    {
      "location": "<e.g. 'Between Email 3 and Email 4'>",
      "readerState": "<What the reader experiences at this gap — what they know, what they're missing, why momentum stalls. 1-2 sentences.>",
      "severity": "<CRITICAL|MAJOR|MINOR>",
      "recommendedEmail": "<Title and goal of the email to insert. e.g. 'What happens after your first Zap runs — activation trigger email that names the immediate outcome'>"
    }
  ],
  "transitions": [
    {
      "location": "<e.g. 'Email 1 → Email 2'>",
      "quality": "<Strong|Weak|Broken>",
      "description": "<One sentence on whether this transition sets up the next email or breaks the narrative.>"
    }
  ],
  "missingBriefs": [
    {
      "position": "<e.g. 'After Email 3 — becomes Email 4'>",
      "subjectVariants": [
        { "type": "Curiosity gap", "line": "<subject line>" },
        { "type": "Consequence-first", "line": "<subject line>" },
        { "type": "Social proof", "line": "<subject line>" }
      ],
      "goal": "<What the reader should do or feel after this email.>",
      "hookDirection": "<What problem or desire to open with — one sentence.>",
      "cta": "<Exact ownership-language CTA recommendation.>",
      "whyNeeded": "<One sentence on the activation impact of this missing email.>"
    }
  ],
  "healthScore": {
    "overall": <integer 1-10>,
    "narrativeCoherence": <integer 1-10>,
    "transitionStrength": <integer 1-10>,
    "activationClarity": <integer 1-10>,
    "gaps": {
      "total": <integer>,
      "critical": <integer>,
      "major": <integer>
    },
    "improvementPotential": "<One sentence estimate of activation improvement if critical gaps are filled. Be specific: name the number of emails and percentage point estimate.>"
  }
}

Rules:
- journeyMap: one entry per email in the sequence. status = green (reader moving toward activation), amber (neutral, no clear direction), red (losing context or momentum).
- gaps: only list real narrative gaps — missing transitions, topic jumps, activation dead ends. CRITICAL = activation will stall here. MAJOR = significant momentum loss. MINOR = smooth but suboptimal.
- transitions: one entry per adjacent pair (Email 1→2, 2→3, etc.). Strong = email A creates expectation email B fulfils. Weak = new topic without connection. Broken = contradicts prior promise.
- missingBriefs: only for CRITICAL and MAJOR gaps. Match the number of missing briefs to the number of critical+major gaps.
- healthScore.overall: honest composite. Below 5 = serious structural problems. 5-7 = needs targeted work. 8-10 = strong sequence with minor gaps.
- improvementPotential: specific, credible. Reference the gap count and realistic activation lift.`;

  try {
    const result = await claudeJSON(prompt, 4000);
    if (!result) return res.status(500).json({ error: 'Analysis failed — no response from Claude.' });
      res.json(result);
  } catch (err) {
    console.error('[api/sequence-gap-finder]', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── END SEQUENCE GAP FINDER ──────────────────────────────────────────────────

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
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-7TV731EJTB"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}

  gtag('consent', 'default', {
    'ad_storage': 'denied',
    'ad_user_data': 'denied',
    'ad_personalization': 'denied',
    'analytics_storage': 'denied',
    'wait_for_update': 500
  });

  gtag('js', new Date());
  gtag('config', 'G-7TV731EJTB');
</script>
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
  #cookie-banner{position:fixed;left:0;right:0;bottom:0;z-index:10000;background:#161614;border-top:1px solid rgba(255,255,255,0.1);padding:18px 48px;display:none;}
  #cookie-banner.visible{display:flex;}
  .cookie-inner{display:flex;align-items:center;justify-content:space-between;gap:24px;max-width:1100px;margin:0 auto;width:100%;flex-wrap:wrap;}
  .cookie-text{font-size:13px;color:#ddddd8;line-height:1.6;max-width:680px;}
  .cookie-text a{color:#4A8FE7;text-decoration:underline;}
  .cookie-actions{display:flex;gap:10px;flex-shrink:0;}
  .cookie-btn{font-family:'DM Mono',monospace;font-size:12px;letter-spacing:.04em;text-transform:uppercase;padding:10px 18px;border-radius:6px;cursor:pointer;border:1px solid rgba(255,255,255,0.1);background:transparent;color:#ddddd8;transition:all .2s;}
  .cookie-btn:hover{border-color:#4A8FE7;color:#4A8FE7;}
  .cookie-btn.accept{background:#4A8FE7;color:#fff;border-color:#4A8FE7;}
  .cookie-btn.accept:hover{background:#2D6BE4;}
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
<!-- COOKIE CONSENT BANNER -->
<div id="cookie-banner">
  <div class="cookie-inner">
    <div class="cookie-text">
      This site uses cookies for analytics (Google Analytics). We don't sell or share your data. See our <a href="https://strategic-flow-pro.replit.app/terms.html" target="_blank">Terms</a> for details.
    </div>
    <div class="cookie-actions">
      <button class="cookie-btn" id="cookie-decline">Decline</button>
      <button class="cookie-btn accept" id="cookie-accept">Accept</button>
    </div>
  </div>
</div>
<script>
(function() {
  var STORAGE_KEY = 'sf_consent';
  var stored = localStorage.getItem(STORAGE_KEY);
  var banner = document.getElementById('cookie-banner');
  function grant() {
    gtag('consent', 'update', {
      'ad_storage': 'granted',
      'ad_user_data': 'granted',
      'ad_personalization': 'granted',
      'analytics_storage': 'granted'
    });
  }
  if (stored === 'granted') {
    grant();
  } else if (stored !== 'denied') {
    banner.classList.add('visible');
  }
  document.getElementById('cookie-accept').addEventListener('click', function() {
    localStorage.setItem(STORAGE_KEY, 'granted');
    grant();
    banner.classList.remove('visible');
  });
  document.getElementById('cookie-decline').addEventListener('click', function() {
    localStorage.setItem(STORAGE_KEY, 'denied');
    banner.classList.remove('visible');
  });
})();
</script>
</body>
</html>`);
});

// ─── WHY PRO ──────────────────────────────────────────────────────────────────

async function sendWhyProMagicLink(email, token) {
  const baseUrl = process.env.APP_URL || 'https://strategic-flow-audit.replit.app';
  const link = `${baseUrl}/why/login?token=${token}`;
  const sendResult = await resend.emails.send({
    from: 'Strategic Flow <noreply@strategicflow.tech>',
    to: email,
    subject: 'Your WHY Pro sign-in link',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#ffffff;color:#111111;padding:40px 32px;border:1px solid #e5e7eb;">
        <p style="font-size:11px;letter-spacing:0.1em;color:#6b7280;text-transform:uppercase;margin:0 0 24px;">WHY Pro — Strategic Flow</p>
        <h2 style="font-size:22px;margin:0 0 14px;font-weight:700;color:#111111;">Your sign-in link</h2>
        <p style="font-size:14px;color:#6b7280;margin:0 0 28px;line-height:1.6;">Click the button below to access WHY Pro. This link expires in 15 minutes and can only be used once.</p>
        <a href="${link}" style="display:inline-block;background:#FF4422;color:#ffffff;padding:14px 28px;text-decoration:none;font-size:14px;font-weight:700;margin-bottom:28px;letter-spacing:0.02em;">Access WHY Pro →</a>
        <p style="font-size:12px;color:#9ca3af;margin:0;line-height:1.6;">If you didn't request this, you can safely ignore this email.<br>Link expires 15 minutes after it was sent.</p>
      </div>
    `
  });
  console.log('[why-pro] magic link sent to:', email, '| Resend ID:', sendResult?.data?.id || 'n/a');
}

function whyProExpiredPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>WHY Pro — Link Expired</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0A0A0A;color:#FFF;font-family:'Space Grotesk',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px 20px;text-align:center;}
.wrap{max-width:420px;}
.wm{font-family:'Space Grotesk',sans-serif;font-size:32px;font-weight:700;color:#FFFFFF;letter-spacing:-0.04em;line-height:1;margin-bottom:32px;}
.wm-dot{color:#FF4422;display:inline-block;}.wm-tm{font-size:0.28em;vertical-align:super;color:#666;letter-spacing:0;font-weight:400;}
.label{font-size:11px;color:#FF4422;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:16px;font-weight:600;}
h1{font-size:24px;font-weight:700;margin-bottom:12px;}p{font-size:14px;color:#AAAAAA;line-height:1.6;margin-bottom:28px;}
a{display:inline-block;background:#FF4422;color:#FFF;font-size:14px;font-weight:700;padding:14px 28px;text-decoration:none;letter-spacing:0.02em;}</style>
</head><body><div class="wrap">
<div class="wm">WHY<span class="wm-dot">.</span><sup class="wm-tm">™</sup></div>
<div class="label">Link Expired</div>
<h1>This link has expired.</h1>
<p>Magic links expire after 15 minutes and can only be used once. Request a new one below.</p>
<a href="/why/login">Request a new link →</a>
</div></body></html>`;
}

// GET /why/login — login page (no token) or token verification (with ?token=XXX)
app.get('/why/login', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WHY Pro — Sign In</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0A0A0A;color:#FFFFFF;font-family:'Space Grotesk',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px 20px;}
.wrap{max-width:420px;width:100%;}
.wm{font-family:'Space Grotesk',sans-serif;font-size:32px;font-weight:700;color:#FFFFFF;letter-spacing:-0.04em;line-height:1;margin-bottom:40px;}
.wm-dot{color:#FF4422;display:inline-block;}
.wm-tm{font-size:0.28em;vertical-align:super;color:#666;letter-spacing:0;font-weight:400;}
h1{font-size:28px;font-weight:700;letter-spacing:-0.02em;margin-bottom:10px;}
.sub{font-size:14px;color:#AAAAAA;margin-bottom:32px;line-height:1.6;}
input[type="email"]{width:100%;background:#141414;border:1px solid #2A2A2A;color:#FFFFFF;font-family:'Space Grotesk',sans-serif;font-size:15px;padding:14px 18px;outline:none;margin-bottom:12px;transition:border-color 0.2s;}
input[type="email"]:focus{border-color:#FF4422;}
input[type="email"]::placeholder{color:#555;}
button{width:100%;background:#FF4422;color:#FFF;font-family:'Space Grotesk',sans-serif;font-size:15px;font-weight:700;padding:14px;border:none;cursor:pointer;letter-spacing:0.02em;transition:opacity 0.2s;}
button:hover{opacity:0.9;}
button:disabled{opacity:0.4;cursor:not-allowed;}
.msg{font-family:'Space Mono',monospace;font-size:12px;color:#22CC88;margin-top:16px;display:none;line-height:1.8;padding:16px;background:#0D1F16;border:1px solid #22CC8830;}
.err{font-family:'Space Mono',monospace;font-size:12px;color:#FF4422;margin-top:14px;display:none;}
.back{display:block;margin-top:28px;font-family:'Space Mono',monospace;font-size:11px;color:#555;text-decoration:none;letter-spacing:0.1em;}
.back:hover{color:#AAAAAA;}
.cta-new{display:block;margin-top:24px;padding-top:24px;border-top:1px solid #1A1A1A;font-size:13px;color:#666;}
.cta-new a{color:#FF4422;text-decoration:none;}
</style>
</head>
<body>
<div class="wrap">
  <div class="wm">WHY<span class="wm-dot">.</span><sup class="wm-tm">™</sup></div>
  <h1>Sign in to WHY Pro</h1>
  <p class="sub">Enter your email and we'll send you a magic link — no password needed.</p>
  <form id="form">
    <input type="email" id="email" placeholder="your@email.com" required autocomplete="email">
    <button type="submit" id="btn">Send me a login link</button>
  </form>
  <div class="msg" id="msg">If this email has an active WHY Pro subscription, a login link has been sent.<br><br>Check your inbox (and spam folder if needed).</div>
  <div class="err" id="err"></div>
  <p class="cta-new">Not a Pro subscriber yet? <a href="https://buy.stripe.com/9B67sL8A0d7HdBHdNF7wA0d">Get WHY Pro — $19/month →</a></p>
  <a href="/why.html" class="back">← Back to WHY.</a>
</div>
<script>
document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value.trim();
  const btn = document.getElementById('btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  document.getElementById('err').style.display = 'none';
  try {
    await fetch('/api/why-request-magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    document.getElementById('form').style.display = 'none';
    document.getElementById('msg').style.display = 'block';
  } catch(err) {
    document.getElementById('err').textContent = 'Network error. Please try again.';
    document.getElementById('err').style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Send me a login link';
  }
});
</script>
</body>
</html>`);
  }

  // ── Token verification ──
  try {
    const result = await pool.query('SELECT * FROM pro_users WHERE magic_token = $1', [token]);
    if (!result.rows.length) return res.send(whyProExpiredPage());
    const user = result.rows[0];
    if (!user.magic_token_expires_at || new Date() > new Date(user.magic_token_expires_at)) {
      return res.send(whyProExpiredPage());
    }
    if (user.status !== 'active') {
      return res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>WHY Pro — Subscription Inactive</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0A0A0A;color:#FFF;font-family:'Space Grotesk',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px 20px;text-align:center;}
.wrap{max-width:420px;}
.wm{font-family:'Space Grotesk',sans-serif;font-size:32px;font-weight:700;color:#FFFFFF;letter-spacing:-0.04em;line-height:1;margin-bottom:32px;}
.wm-dot{color:#FF4422;display:inline-block;}.wm-tm{font-size:0.28em;vertical-align:super;color:#666;letter-spacing:0;font-weight:400;}
.label{font-size:11px;color:#FF4422;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:16px;font-weight:600;}
h1{font-size:24px;font-weight:700;margin-bottom:12px;}p{font-size:14px;color:#AAAAAA;line-height:1.6;margin-bottom:28px;}
a{display:inline-block;background:#FF4422;color:#FFF;font-size:14px;font-weight:700;padding:14px 28px;text-decoration:none;letter-spacing:0.02em;}</style>
</head><body><div class="wrap">
<div class="wm">WHY<span class="wm-dot">.</span><sup class="wm-tm">™</sup></div>
<div class="label">Subscription Inactive</div>
<h1>Your WHY Pro subscription is no longer active.</h1>
<p>Resubscribe to get unlimited diagnoses and the full rebuilt output.</p>
<a href="https://buy.stripe.com/9B67sL8A0d7HdBHdNF7wA0d">Resubscribe to WHY Pro →</a>
</div></body></html>`);
    }
    // Valid & active — create session and redirect
    req.session.isWhyPro = true;
    req.session.whyProEmail = user.email;
    await pool.query(
      'UPDATE pro_users SET magic_token = NULL, magic_token_expires_at = NULL, last_login_at = NOW() WHERE email = $1',
      [user.email]
    );
    console.log('[why-pro] session created for:', user.email);
    return res.redirect('/why.html');
  } catch (e) {
    console.error('[why-pro] token verify error:', e.message);
    return res.send(whyProExpiredPage());
  }
});

// GET /why/history — Pro history page
app.get('/why/history', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'why', 'history.html'));
});

// GET /why — alias for why.html
app.get('/why', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'why.html'));
});

// GET /api/why-status — returns Pro session state for frontend
app.get('/api/why-status', (req, res) => {
  const isPro = (req.session && req.session.isWhyPro === true) ||
    (req.session && BYPASS_EMAILS.has(req.session.userEmail)) ||
    (req.session && BYPASS_EMAILS.has(req.session.whyProEmail));
  res.json({ isPro: !!isPro });
});

// POST /api/why-request-magic-link
app.post('/api/why-request-magic-link', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const generic = { ok: true, message: 'If this email has an active WHY Pro subscription, a login link has been sent.' };
  if (!email || !email.includes('@')) return res.json(generic);
  try {
    // Bypass emails always get access — upsert as active if not already present
    if (BYPASS_EMAILS.has(email)) {
      await pool.query(`
        INSERT INTO pro_users (email, status)
        VALUES ($1, 'active')
        ON CONFLICT (email) DO UPDATE SET status = 'active'
      `, [email]);
    }
    const result = await pool.query('SELECT * FROM pro_users WHERE email = $1', [email]);
    if (!result.rows.length || result.rows[0].status !== 'active') return res.json(generic);
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query(
      'UPDATE pro_users SET magic_token = $1, magic_token_expires_at = $2 WHERE email = $3',
      [token, expires, email]
    );
    await sendWhyProMagicLink(email, token);
  } catch (e) {
    console.error('[why-pro] request magic link error:', e.message);
  }
  return res.json(generic);
});

// POST /api/why-stripe-webhook
app.post('/api/why-stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!process.env.WHY_STRIPE_WEBHOOK_SECRET) {
    console.error('[why-stripe-webhook] WHY_STRIPE_WEBHOOK_SECRET not set');
    return res.status(400).send('Webhook secret not configured');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.WHY_STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[why-stripe-webhook] signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const sess = event.data.object;
      const email = (sess.customer_details?.email || '').toLowerCase().trim();
      const customerId = sess.customer;
      const subscriptionId = sess.subscription;
      if (!email) {
        console.error('[why-webhook] no email in checkout session');
        return res.json({ received: true });
      }
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 15 * 60 * 1000);
      await pool.query(`
        INSERT INTO pro_users (email, stripe_customer_id, stripe_subscription_id, status, magic_token, magic_token_expires_at)
        VALUES ($1, $2, $3, 'active', $4, $5)
        ON CONFLICT (email) DO UPDATE SET
          stripe_customer_id      = EXCLUDED.stripe_customer_id,
          stripe_subscription_id  = EXCLUDED.stripe_subscription_id,
          status                  = 'active',
          magic_token             = EXCLUDED.magic_token,
          magic_token_expires_at  = EXCLUDED.magic_token_expires_at
      `, [email, customerId, subscriptionId, token, expires]);
      await sendWhyProMagicLink(email, token);
      console.log('[why-webhook] checkout.session.completed — pro_user upserted for', email);
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await pool.query("UPDATE pro_users SET status = 'cancelled' WHERE stripe_subscription_id = $1", [sub.id]);
      console.log('[why-webhook] subscription cancelled:', sub.id);
    } else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const newStatus = sub.status === 'active' ? 'active' : 'expired';
      await pool.query('UPDATE pro_users SET status = $1 WHERE stripe_subscription_id = $2', [newStatus, sub.id]);
      console.log('[why-webhook] subscription updated:', sub.id, '->', newStatus);
    }
  } catch (e) {
    console.error('[why-webhook] handler error:', e.message);
  }
  res.json({ received: true });
});

// ─────────────────────────────────────────────────────────────────────────────

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

// ─── STRIPE WEBHOOK (activation flow) ────────────────────────────────────────
// POST /webhook/stripe — handles checkout + subscription lifecycle for Architecture tier

async function getCustomerEmail(customerId) {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return customer.deleted ? null : (customer.email || null);
  } catch (e) {
    console.error('[webhook/stripe] customer lookup failed:', e.message);
    return null;
  }
}

const WELCOME_EMAIL_HTML = `
<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;padding:40px 32px;">
  <p style="margin:0 0 16px;">Hi,</p>
  <p style="margin:0 0 16px;">Your access is ready. Log in here:<br>
    <a href="https://strategic-flow-audit.replit.app/login.html" style="color:#4A8FE7;">
      https://strategic-flow-audit.replit.app/login.html
    </a>
  </p>
  <p style="margin:0 0 16px;">Enter this email address and click the magic link we send you. You will land directly on the Architecture dashboard.</p>
  <p style="margin:0 0 16px;">Questions? Reply to this email.</p>
  <p style="margin:0;">Alex<br>Strategic Flow</p>
</div>`;

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

  // Always return 200 immediately — Stripe must not retry
  res.json({ received: true });

  try {
    // ── 1. checkout.session.completed ──────────────────────────────────────
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_email || session.customer_details?.email;

      if (!email) {
        console.error('[webhook/stripe] checkout.session.completed — no email found, session:', session.id);
        return;
      }

      // Check product name in metadata or line_items
      const metaProduct = (session.metadata?.product || session.metadata?.name || '').toLowerCase();
      let productName = metaProduct;

      if (!productName && session.line_items) {
        try {
          const expanded = await stripe.checkout.sessions.retrieve(session.id, {
            expand: ['line_items']
          });
          const item = expanded.line_items?.data?.[0];
          productName = (item?.description || item?.price?.nickname || '').toLowerCase();
        } catch (e) {
          console.error('[webhook/stripe] line_items expand failed:', e.message);
        }
      }

      const isActivation = productName.includes('activation audit') || productName.includes('activation') || metaProduct.includes('activation');

      if (!isActivation && productName) {
        console.log('[webhook/stripe] checkout.session.completed — product not activation, skipping:', productName);
        return;
      }

      console.log('[webhook/stripe] checkout activation for:', email);

      await pool.query(
        `INSERT INTO users (email, tier, expires_at, access_type)
         VALUES ($1, 'architecture', NULL, 'activation_paid')
         ON CONFLICT (email) DO UPDATE
           SET tier = 'architecture', expires_at = NULL, access_type = 'activation_paid'`,
        [email.toLowerCase().trim()]
      );

      await resend.emails.send({
        from: SENDER,
        to: email,
        subject: 'Your Activation Intelligence access is ready',
        html: WELCOME_EMAIL_HTML
      });

      console.log('[webhook/stripe] checkout — user upserted + welcome email sent:', email);
    }

    // ── 2. customer.subscription.created ───────────────────────────────────
    else if (event.type === 'customer.subscription.created') {
      const subscription = event.data.object;
      const email = await getCustomerEmail(subscription.customer);

      if (!email) {
        console.error('[webhook/stripe] subscription.created — no email for customer:', subscription.customer);
        return;
      }

      console.log('[webhook/stripe] subscription created for:', email, '— status:', subscription.status);

      if (subscription.status === 'trialing') {
        const trialEnd = subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null;
        await pool.query(
          `INSERT INTO users (email, tier, expires_at, access_type)
           VALUES ($1, 'architecture', $2, 'architecture_trial')
           ON CONFLICT (email) DO UPDATE
             SET tier = 'architecture', expires_at = $2, access_type = 'architecture_trial'`,
          [email.toLowerCase().trim(), trialEnd]
        );

        await resend.emails.send({
          from: SENDER,
          to: email,
          subject: 'Your 3-day Architecture trial has started',
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;padding:40px 32px;">
            <p style="margin:0 0 16px;">Your trial access is active.</p>
            <p style="margin:0 0 16px;">Log in here:<br>
              <a href="https://strategic-flow-audit.replit.app/login.html" style="color:#4A8FE7;">https://strategic-flow-audit.replit.app/login.html</a>
            </p>
            <p style="margin:0 0 16px;">You have full access to all 19 Architecture tools for 3 days. Your card will only be charged if you do not cancel before the trial ends.</p>
            <p style="margin:0 0 16px;">Questions? Reply to this email.</p>
            <p style="margin:0;">Alex<br>Strategic Flow</p>
          </div>`
        });

        console.log('[webhook/stripe] subscription.created — trial upserted + trial email sent:', email, 'expires:', trialEnd);

      } else {
        await pool.query(
          `INSERT INTO users (email, tier, expires_at, access_type)
           VALUES ($1, 'architecture', NULL, 'activation_retainer')
           ON CONFLICT (email) DO UPDATE
             SET tier = 'architecture', expires_at = NULL, access_type = 'activation_retainer'`,
          [email.toLowerCase().trim()]
        );

        await resend.emails.send({
          from: SENDER,
          to: email,
          subject: 'Your Activation Intelligence access is ready',
          html: WELCOME_EMAIL_HTML
        });

        console.log('[webhook/stripe] subscription.created — user upserted + welcome email sent:', email);
      }
    }

    // ── 3. customer.subscription.updated ───────────────────────────────────
    else if (event.type === 'customer.subscription.updated') {
      const subscription = event.data.object;
      const email = await getCustomerEmail(subscription.customer);

      if (!email) {
        console.error('[webhook/stripe] subscription.updated — no email for customer:', subscription.customer);
        return;
      }

      const status = subscription.status;
      const previousStatus = event.data.previous_attributes?.status;
      console.log('[webhook/stripe] subscription updated for:', email, '— status:', status, 'prev:', previousStatus);

      if (status === 'active' && previousStatus === 'trialing') {
        await pool.query(
          `UPDATE users SET tier = 'architecture', expires_at = NULL, access_type = 'architecture_paid' WHERE email = $1`,
          [email.toLowerCase().trim()]
        );

        await resend.emails.send({
          from: SENDER,
          to: email,
          subject: 'Your Architecture trial converted',
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;padding:40px 32px;">
            <p style="margin:0 0 16px;">Full access continues. All 19 tools remain active.</p>
            <p style="margin:0 0 16px;">Questions? Reply to this email.</p>
            <p style="margin:0;">Alex<br>Strategic Flow</p>
          </div>`
        });

        console.log('[webhook/stripe] subscription.updated — trial converted to paid:', email);

      } else if (status === 'active') {
        await pool.query(
          `UPDATE users SET tier = 'architecture', expires_at = NULL WHERE email = $1`,
          [email.toLowerCase().trim()]
        );
        console.log('[webhook/stripe] subscription.updated — tier restored to architecture:', email);

      } else if (status === 'past_due' || status === 'unpaid') {
        await pool.query(
          `UPDATE users SET tier = 'suspended' WHERE email = $1`,
          [email.toLowerCase().trim()]
        );

        await resend.emails.send({
          from: SENDER,
          to: email,
          subject: 'Your Strategic Flow access has been suspended',
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;padding:40px 32px;">
            <p>Your access has been suspended due to a payment issue. Update your payment method to restore access.</p>
            <p>Questions? Reply to this email.</p>
            <p>Alex<br>Strategic Flow</p>
          </div>`
        });

        console.log('[webhook/stripe] subscription.updated — tier suspended, email sent:', email);
      }
    }

    // ── 4. customer.subscription.deleted ───────────────────────────────────
    else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const email = await getCustomerEmail(subscription.customer);

      if (!email) {
        console.error('[webhook/stripe] subscription.deleted — no email for customer:', subscription.customer);
        return;
      }

      console.log('[webhook/stripe] subscription deleted for:', email);

      // Check current access_type to decide which email to send
      const userRow = await pool.query(
        `SELECT access_type FROM users WHERE email = $1`,
        [email.toLowerCase().trim()]
      );
      const accessType = userRow.rows[0]?.access_type || '';

      await pool.query(
        `UPDATE users SET tier = 'expired', expires_at = NOW() WHERE email = $1`,
        [email.toLowerCase().trim()]
      );

      if (accessType === 'architecture_trial') {
        await resend.emails.send({
          from: SENDER,
          to: email,
          subject: 'Your Architecture trial has ended',
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;padding:40px 32px;">
            <p style="margin:0 0 16px;">Your trial access has expired.</p>
            <p style="margin:0 0 16px;">Reactivate anytime at:<br>
              <a href="https://strategic-flow-pro.replit.app/packages" style="color:#4A8FE7;">https://strategic-flow-pro.replit.app/packages</a>
            </p>
            <p style="margin:0;">Alex<br>Strategic Flow</p>
          </div>`
        });
        console.log('[webhook/stripe] subscription.deleted — trial ended, email sent:', email);
      } else {
        await resend.emails.send({
          from: SENDER,
          to: email,
          subject: 'Your Activation Intelligence subscription has been cancelled',
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;padding:40px 32px;">
            <p>Your Activation Intelligence subscription has been cancelled. Your access has been removed.</p>
            <p>Reply to this email if this was a mistake.</p>
            <p>Alex<br>Strategic Flow</p>
          </div>`
        });
        console.log('[webhook/stripe] subscription.deleted — tier expired, email sent:', email);
      }
    }

    else {
      console.log('[webhook/stripe] unhandled event type (ignored):', event.type);
    }

  } catch (err) {
    console.error('[webhook/stripe] internal processing error (200 already sent):', err.message);
  }
});

// ─── END WEBHOOK/STRIPE BLOCK ─────────────────────────────────────────────────

// ─── EMAIL SEQUENCE ENGINE ────────────────────────────────────────────────────

const SEQ_SENDER = 'Alex at Strategic Flow <alex@strategicflow.tech>';

const SEQ_EMAILS = [
  {
    num: 1,
    delayDays: 0,
    col: 'seq1_sent',
    subject: 'Your 7-Point Email Audit Checklist',
    html: () => seqWrap(`
      <p>Your checklist is here: <a href="https://strategicflow-tech.github.io/showcase/email-audit-checklist.html" style="color:#00d4c8;">https://strategicflow-tech.github.io/showcase/email-audit-checklist.html</a></p>
      <p>Run it before every send. Score 1 point per check. 7/7 = ship it. Below 5 = rebuild.</p>
      <p>Most teams never check it. They just hit send.</p>
      <p>If you want a full audit on one of your own emails, reply and paste it.</p>
      <p>Alex / Strategic Flow / <a href="https://strategic-flow-audit.replit.app" style="color:#00d4c8;">strategic-flow-audit.replit.app</a></p>
    `)
  },
  {
    num: 2,
    delayDays: 2,
    col: 'seq2_sent',
    subject: 'What a broken SaaS email looks like (before and after)',
    html: () => seqWrap(`
      <p>Most product update emails fail on the first line.</p>
      <p>Here is what that looks like:</p>
      <p>Before: "New Feature: Dashboard Update" — After: "Your reports now load 4x faster"</p>
      <p>Same email. Same feature. Same product. Different architecture.</p>
      <p>This is Check #1 in the Strategic Flow Audit: Filing Label Subject. A subject line that announces the topic like a folder tab instead of naming a consequence. The reader's brain filters for relevance to their situation — not product capability. One change. Different open rate.</p>
      <p>55 more rebuilds: <a href="https://strategicflow-tech.github.io/showcase/teardowns.html" style="color:#00d4c8;">https://strategicflow-tech.github.io/showcase/teardowns.html</a></p>
      <p>Alex / Strategic Flow / <a href="https://strategic-flow-audit.replit.app" style="color:#00d4c8;">strategic-flow-audit.replit.app</a></p>
    `)
  },
  {
    num: 3,
    delayDays: 4,
    col: 'seq3_sent',
    subject: 'Copy problem vs architecture problem',
    html: () => seqWrap(`
      <p>Most teams think they need better copy. Usually they need a different structure.</p>
      <p>Here is why: Subject line. First line. CTA. These three decisions happen before the copy exists. If the structure is wrong, better words make no difference.</p>
      <p>A subject line that announces the feature instead of naming the consequence. A lead that opens with context instead of the reader's problem. A CTA that says "Learn more" instead of naming what the reader owns after clicking.</p>
      <p>That is not a copy problem. That is an architecture problem. And it is the only thing Strategic Flow fixes.</p>
      <p>Alex / Strategic Flow / <a href="https://strategic-flow-audit.replit.app" style="color:#00d4c8;">strategic-flow-audit.replit.app</a></p>
    `)
  },
  {
    num: 4,
    delayDays: 6,
    col: 'seq4_sent',
    subject: 'The 3 failures we see in almost every SaaS email',
    html: () => seqWrap(`
      <p>Across 55+ teardowns, most SaaS emails fail on the same three points.</p>
      <p>1. Filing Label Subject — the subject announces the topic instead of naming a consequence.<br>
         2. Feature-First Bias — the email leads with what the product does instead of what the reader gains.<br>
         3. Generic Urgency Theatre — the CTA says "Learn more" — describing the brand's action, not the reader's gain.</p>
      <p>These three failures account for most of the conversion gap in SaaS email. The fix is not rewriting the copy. It is rebuilding the sequence of decisions that happens before the copy.</p>
      <p>Full teardown archive: <a href="https://strategicflow-tech.github.io/showcase/teardowns.html" style="color:#00d4c8;">https://strategicflow-tech.github.io/showcase/teardowns.html</a></p>
      <p>Alex / Strategic Flow / <a href="https://strategic-flow-audit.replit.app" style="color:#00d4c8;">strategic-flow-audit.replit.app</a></p>
    `)
  },
  {
    num: 5,
    delayDays: 8,
    col: 'seq5_sent',
    subject: 'One email. Before score: 2/10. After: 9/10.',
    html: () => seqWrap(`
      <p>A SaaS team sent us a product update email.</p>
      <p>Subject: "Introducing Advanced Reporting" — Lead: "We are excited to announce our most powerful reporting update yet." — CTA: "Explore the new features" — Score: 2/10.</p>
      <p>Filing Label Subject. Feature-First Bias. Generic Urgency Theatre. Zero Social Proof.</p>
      <p>After the rebuild — Subject: "Your reports now update in real time — no manual refresh" — Lead: "If you have ever refreshed a dashboard three times waiting for data to load — that problem is gone." — CTA: "See my live dashboard" — Score: 9/10.</p>
      <p>Same product. Same send list. Different architecture. This is what Strategic Flow does. Not copy edits. Architecture rebuilds.</p>
      <p>Full teardown archive: <a href="https://strategicflow-tech.github.io/showcase/teardowns.html" style="color:#00d4c8;">https://strategicflow-tech.github.io/showcase/teardowns.html</a></p>
      <p>Alex / Strategic Flow / <a href="https://strategic-flow-audit.replit.app" style="color:#00d4c8;">strategic-flow-audit.replit.app</a></p>
    `)
  },
  {
    num: 6,
    delayDays: 10,
    col: 'seq6_sent',
    subject: 'We are taking on 5 architecture rebuild clients this month',
    html: () => seqWrap(`
      <p>Over 55 teardowns, one pattern is consistent. SaaS emails that score below 5 share the same structural failures. Filing Label Subject. Feature-First Bias. Missing Hierarchy. Generic Urgency Theatre. These are not copy problems. They are architecture problems.</p>
      <p>Strategic Flow rebuilds the architecture behind your emails — not just the words.</p>
      <p>This month we are taking on 5 clients at founder pricing. First month 50% off while we build your initial rebuild library.</p>
      <p>Growth: $499 → $249/mo — High-Impact: $899 → $449/mo — Architecture retainer: $2,500 → $1,250/mo — Activation Intelligence: $1,500 → $750/mo</p>
      <p>5 spots. First month only.</p>
      <p>See what is included: <a href="https://strategicflow-tech.github.io/showcase/packages-promo.html" style="color:#00d4c8;">https://strategicflow-tech.github.io/showcase/packages-promo.html</a></p>
      <p>Reply to this email to start this week.</p>
      <p>Alex / Strategic Flow / <a href="https://strategic-flow-audit.replit.app" style="color:#00d4c8;">strategic-flow-audit.replit.app</a></p>
    `)
  }
];

function seqWrap(inner) {
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;padding:40px 32px;">${
    inner.trim().replace(/<p>/g, '<p style="margin:0 0 16px;">')
  }</div>`;
}

async function sendSeqEmail(emailAddr, seqItem) {
  await resend.emails.send({
    from: SEQ_SENDER,
    to: emailAddr,
    subject: seqItem.subject,
    html: seqItem.html()
  });
  await pool.query(`UPDATE subscribers SET ${seqItem.col} = TRUE WHERE email = $1`, [emailAddr]);
  console.log(`[seq] email ${seqItem.num} sent to ${emailAddr}`);
}

async function processSequence() {
  try {
    const { rows } = await pool.query(`SELECT * FROM subscribers`);
    for (const sub of rows) {
      const now = Date.now();
      const subscribedAt = new Date(sub.subscribed_at).getTime();
      for (const seqItem of SEQ_EMAILS) {
        if (seqItem.num === 1) continue; // Email 1 sent immediately on subscribe
        if (sub[seqItem.col]) continue;  // Already sent
        const readyAt = subscribedAt + seqItem.delayDays * 24 * 60 * 60 * 1000;
        if (now >= readyAt) {
          try {
            await sendSeqEmail(sub.email, seqItem);
          } catch (err) {
            console.error(`[seq] failed to send email ${seqItem.num} to ${sub.email}:`, err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('[seq] processSequence error:', err.message);
  }
}

// Run every hour at minute 0
cron.schedule('0 * * * *', () => {
  console.log('[seq] cron tick — processing sequence');
  processSequence();
});

// ─── LEAD MAGNET — /subscribe ─────────────────────────────────────────────────

app.get('/subscribe', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The 7-Point Email Diagnostic — Strategic Flow</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;
  --surface:#131920;
  --border:rgba(29,158,117,0.12);
  --text:#f5f4f0;
  --muted:#8b9aaa;
  --dim:#4a5568;
  --teal:#1D9E75;
  --teal-dim:rgba(29,158,117,0.15);
  --red:#e74a4a;
  --red-dim:rgba(231,74,74,0.12);
  --radius:6px;
}
body{
  background:var(--bg);
  color:var(--text);
  font-family:'Inter',sans-serif;
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:48px 20px;
  background-image:
    linear-gradient(rgba(29,158,117,0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(29,158,117,0.04) 1px, transparent 1px);
  background-size:40px 40px;
}
.wrap{max-width:480px;width:100%}

.logo{
  font-family:monospace;
  font-size:12px;
  letter-spacing:0.1em;
  text-transform:uppercase;
  color:var(--dim);
  margin-bottom:40px;
}

h1{
  font-size:clamp(24px,6vw,32px);
  font-weight:700;
  line-height:1.18;
  letter-spacing:-0.025em;
  color:var(--text);
  margin-bottom:16px;
}

.sub{
  font-size:15px;
  color:var(--muted);
  line-height:1.7;
  margin-bottom:32px;
}
.sub em{color:var(--text);font-style:normal;font-weight:500}

.stat-hero{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:var(--radius);
  padding:24px 20px;
  text-align:center;
  margin-bottom:20px;
}
.stat-hero .num{
  font-size:48px;
  font-weight:700;
  color:var(--teal);
  letter-spacing:-0.03em;
  line-height:1;
  margin-bottom:6px;
}
.stat-hero .label{
  font-size:13px;
  color:var(--muted);
  letter-spacing:0.02em;
}

.ba-row{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:8px;
  margin-bottom:10px;
}
.ba-box{
  border-radius:var(--radius);
  padding:14px 16px;
  font-size:13px;
  font-weight:500;
  line-height:1.45;
}
.ba-tag{
  font-size:10px;
  font-weight:700;
  letter-spacing:0.1em;
  text-transform:uppercase;
  margin-bottom:6px;
  display:flex;
  align-items:center;
  gap:5px;
}
.ba-before{background:var(--red-dim);border:1px solid rgba(231,74,74,0.25);color:var(--text)}
.ba-before .ba-tag{color:var(--red)}
.ba-after{background:var(--teal-dim);border:1px solid rgba(29,158,117,0.3);color:var(--text)}
.ba-after .ba-tag{color:var(--teal)}
.ba-caption{font-size:12px;color:var(--dim);margin-bottom:32px;line-height:1.5}

.proof-row{
  display:flex;
  gap:0;
  border:1px solid var(--border);
  border-radius:var(--radius);
  overflow:hidden;
  margin-bottom:32px;
}
.proof-item{
  flex:1;
  padding:12px 10px;
  text-align:center;
  font-size:11px;
  color:var(--muted);
  line-height:1.5;
  border-right:1px solid var(--border);
}
.proof-item:last-child{border-right:none}
.proof-item strong{display:block;font-size:15px;font-weight:700;color:var(--teal);letter-spacing:-0.01em;margin-bottom:2px}

input[type="email"]{
  width:100%;
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:var(--radius);
  color:var(--text);
  font-family:'Inter',sans-serif;
  font-size:15px;
  padding:14px 16px;
  outline:none;
  transition:border-color 0.2s;
  margin-bottom:10px;
  -webkit-appearance:none;
}
input[type="email"]::placeholder{color:var(--dim)}
input[type="email"]:focus{border-color:var(--teal)}

button{
  width:100%;
  background:var(--teal);
  color:#fff;
  border:none;
  border-radius:var(--radius);
  font-family:'Inter',sans-serif;
  font-size:15px;
  font-weight:600;
  padding:15px;
  cursor:pointer;
  transition:opacity 0.2s;
  letter-spacing:-0.01em;
}
button:hover{opacity:0.88}
button:disabled{opacity:0.4;cursor:not-allowed}

.reassurance{
  font-size:12px;
  color:var(--dim);
  text-align:center;
  margin-top:12px;
  line-height:1.5;
}

.err{color:var(--red);font-size:13px;margin-top:8px;display:none}

@media(min-width:768px){
  .wrap{max-width:640px}
  h1{font-size:44px}
  .sub{font-size:17px}
  .stat-hero{padding:32px 24px}
  .stat-hero .num{font-size:72px}
  .stat-hero .label{font-size:15px}
  .ba-box{padding:18px 20px;font-size:15px}
  .proof-item{padding:16px 12px;font-size:13px}
  .proof-item strong{font-size:18px}
  input[type="email"]{font-size:16px;padding:16px 18px}
  button{font-size:17px;padding:18px}
  .logo{font-size:13px}
}
</style>
</head>
<body>
<div class="wrap">

  <div class="logo">Strategic Flow</div>

  <h1>Most SaaS emails fail before the CTA.</h1>

  <p class="sub">
    Not because of copy.<br>
    <em>Because the structure breaks before the reader reaches it.</em><br><br>
    Subject line, hierarchy, consequence framing, CTA momentum — 7 structural checks.
  </p>

  <div class="stat-hero">
    <div class="num">81%</div>
    <div class="label">of SaaS emails fail Check #1</div>
  </div>

  <div class="ba-row">
    <div class="ba-box ba-before">
      <div class="ba-tag"><span>✕</span> Before</div>
      New Feature: Dashboard Update
    </div>
    <div class="ba-box ba-after">
      <div class="ba-tag"><span>✓</span> After</div>
      Your reports now load 4x faster
    </div>
  </div>
  <p class="ba-caption">Check #1 failed. Same feature. Different architecture.</p>

  <div class="proof-row">
    <div class="proof-item"><strong>59</strong>SaaS emails rebuilt</div>
    <div class="proof-item"><strong>3.4/7</strong>avg score before</div>
    <div class="proof-item"><strong>9/10</strong>avg score after</div>
  </div>

  <form id="form" action="/subscribe" method="POST">
    <input type="email" id="email" name="email" placeholder="Work email" autocomplete="email" required>
    <button type="submit" id="btn">Get the 7-Point Checklist — free</button>
  </form>
  <div class="err" id="err"></div>
  <p class="reassurance">No pitch. No spam. Just the diagnostic.</p>

</div>
<script>
document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value.trim();
  const btn = document.getElementById('btn');
  const err = document.getElementById('err');
  err.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch('/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (data.ok) {
      window.location.href = '/subscribe/thanks';
    } else {
      err.textContent = data.error || 'Something went wrong. Try again.';
      err.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Get the 7-Point Checklist — free';
    }
  } catch(e) {
    err.textContent = 'Network error. Please try again.';
    err.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Get the 7-Point Checklist — free';
  }
});
</script>
</body>
</html>`);
});

app.post('/subscribe', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    await pool.query(
      `INSERT INTO subscribers (email, source) VALUES ($1, 'checklist')
       ON CONFLICT (email) DO NOTHING`,
      [email]
    );
  } catch (err) {
    console.error('[subscribe] DB insert error:', err.message);
    return res.status(500).json({ error: 'Could not save your email. Please try again.' });
  }

  try {
    await sendSeqEmail(email, SEQ_EMAILS[0]);
    await pool.query(`UPDATE subscribers SET sent = TRUE WHERE email = $1`, [email]);
  } catch (err) {
    console.error('[subscribe] Email 1 send error:', err.message);
  }

  res.json({ ok: true });
});

app.get('/test-sequence', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Provide ?email=...' });
  const results = [];
  for (const seqItem of SEQ_EMAILS) {
    try {
      await resend.emails.send({
        from: SEQ_SENDER,
        to: email,
        subject: `[TEST – Day ${seqItem.delayDays}] ${seqItem.subject}`,
        html: seqItem.html()
      });
      results.push({ num: seqItem.num, status: 'sent' });
      console.log(`[seq-test] email ${seqItem.num} sent to ${email}`);
    } catch (err) {
      results.push({ num: seqItem.num, status: 'error', error: err.message });
      console.error(`[seq-test] email ${seqItem.num} failed:`, err.message);
    }
  }
  res.json({ ok: true, email, results });
});

// ─── REBUILD REQUEST SUBMISSION ───────────────────────────────────────────────

app.post('/submit-rebuild', async (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });

  const { email, company, content } = req.body || {};

  try {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, 'rebuild-requests.json');
    let requests = [];
    if (fs.existsSync(filePath)) {
      try { requests = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
    }
    requests.push({ email: email || '', company: company || '', content: content || '', timestamp: new Date().toISOString() });
    fs.writeFileSync(filePath, JSON.stringify(requests, null, 2));
  } catch (err) {
    console.error('[submit-rebuild] File write error:', err.message);
    return res.status(500).json({ success: false, error: 'Could not save request.' });
  }

  try {
    const label = company || email || 'unknown';
    await resend.emails.send({
      from: 'Strategic Flow <alex@strategicflow.tech>',
      to: 'alex@strategicflow.tech',
      subject: `New rebuild request from ${label}`,
      text: `New rebuild request\n\nEmail: ${email || '—'}\nCompany: ${company || '—'}\n\nContent:\n${content || '—'}`
    });
  } catch (err) {
    console.error('[submit-rebuild] Resend error:', err.message);
    return res.status(500).json({ success: false, error: 'Could not send notification.' });
  }

  res.json({ success: true });
});

app.options('/submit-rebuild', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }).sendStatus(204);
});

app.get('/subscribe/thanks', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Check your inbox — Strategic Flow</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Serif+Display:ital@0;1&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#0a0a08;--surface:#111110;--border:rgba(244,242,237,0.1);--text:#f4f2ed;--muted:#a8a39b;--dim:#6b6760;--teal:#00d4c8;--mono:'DM Mono',monospace;--serif:'DM Serif Display',serif}
  body{background:var(--bg);color:var(--text);font-family:var(--mono);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{max-width:440px;width:100%;border:1px solid var(--border);padding:52px 40px;background:var(--surface);text-align:center}
  .icon{font-size:36px;margin-bottom:28px;display:block}
  h1{font-family:var(--serif);font-size:34px;font-weight:400;margin-bottom:12px;line-height:1.2}
  h1 em{color:var(--teal);font-style:italic}
  .sub{font-size:14px;color:var(--muted);margin-bottom:36px;line-height:1.7}
  .divider{height:1px;background:var(--border);margin:32px 0}
  a.back{display:inline-block;font-size:13px;color:var(--teal);text-decoration:none}
  a.back:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="card">
  <span class="icon">✓</span>
  <h1>Check your <em>inbox.</em></h1>
  <p class="sub">The checklist is on its way.</p>
  <div class="divider"></div>
  <a href="https://strategic-flow-audit.replit.app" class="back">← Back to Strategic Flow</a>
</div>
</body>
</html>`);
});

// ─── END LEAD MAGNET ──────────────────────────────────────────────────────────

// ─── OUTREACH AUDIT ───────────────────────────────────────────────────────────
// POST /outreach-audit — internal lead-gen endpoint, no auth required
// Runs a full /generate call with bypass email and returns a simplified audit
// suitable for personalised cold outreach.

// Attempt to find the latest blog post URL from a domain's RSS feed.
// Tries common RSS paths in order; returns the first <item> URL or null.
async function resolveLatestBlogUrl(baseUrl) {
  let origin;
  try {
    origin = new URL(baseUrl).origin; // e.g. https://heygen.com
  } catch {
    return null;
  }

  const RSS_PATHS = ['/feed', '/rss', '/blog/feed', '/rss.xml'];

  for (const path of RSS_PATHS) {
    const feedUrl = origin + path;
    try {
      const resp = await fetch(feedUrl, {
        signal:  AbortSignal.timeout(5000),
        headers: { 'Accept': 'application/rss+xml, application/xml, text/xml, */*' }
      });
      if (!resp.ok) continue;

      const xml = await resp.text();
      // Must look like XML with at least one <item>
      if (!xml.includes('<item') && !xml.includes('<entry')) continue;

      // RSS 2.0: <link>https://...</link> inside <item>
      // Atom: <link href="https://..."/> inside <entry>
      let match =
        xml.match(/<item[\s\S]*?<link>(https?:\/\/[^<]+)<\/link>/i) ||
        xml.match(/<entry[\s\S]*?<link[^>]+href="(https?:\/\/[^"]+)"/i);

      if (match && match[1]) {
        const resolved = match[1].trim();
        console.log(`[outreach-audit] RSS found at ${feedUrl} → ${resolved}`);
        return resolved;
      }
    } catch {
      // Timeout or network error — try next path
    }
  }

  return null; // No RSS found
}

app.post('/outreach-audit', async (req, res) => {
  if (req.headers['x-sf-key'] !== 'sf-internal-2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('[outreach-audit] req.body:', JSON.stringify(req.body));

  const { pageUrl, prospectName, prospectCompany, prospectTitle } = req.body;

  if (!pageUrl || !prospectCompany) {
    return res.status(400).json({ error: 'pageUrl and prospectCompany are required' });
  }

  // Resolve to latest blog post if an RSS feed exists; otherwise use original URL
  const latestBlogUrl = await resolveLatestBlogUrl(pageUrl);
  const contentUrl    = latestBlogUrl || pageUrl;
  console.log(`[outreach-audit] content_url resolved: ${contentUrl} (rss: ${!!latestBlogUrl})`);

  const internalPort = process.env.PORT || 3000;
  const generateUrl  = `http://localhost:${internalPort}/generate`;

  let generateResult;
  try {
    const resp = await fetch(generateUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:   'strategicflow@proton.me',
        subject: `${prospectCompany} homepage audit`,
        pageUrl: contentUrl
      })
    });
    generateResult = await resp.json();
  } catch (err) {
    console.error('[outreach-audit] internal /generate call failed:', err.message);
    return res.status(502).json({ error: 'Internal generation failed', detail: err.message });
  }

  if (generateResult.error) {
    console.error('[outreach-audit] /generate returned error:', generateResult.error);
    return res.status(422).json({ error: generateResult.error, detail: generateResult.message });
  }

  // Extract only the required fields
  const originalScore = generateResult.conversion_score?.original_score ?? null;
  const topBugs       = (generateResult.removed_elements || []).slice(0, 2);
  const topFixes      = (generateResult.key_changes     || []).slice(0, 2);
  const bestSubject   = generateResult.ab_subjects?.[0]
    ? {
        subject:        generateResult.ab_subjects[0].subject        || '',
        angle:          generateResult.ab_subjects[0].angle          || '',
        predicted_lift: generateResult.ab_subjects[0].predicted_lift || ''
      }
    : null;

  const bug1  = topBugs[0]  || '';
  const fix1  = topFixes[0] || '';
  const score = originalScore !== null ? originalScore : '?';

  const msg1 = `Hi ${prospectName || '[name]'},\n\n${prospectCompany}'s homepage scores ${score}/10 on the Strategic Flow audit.\n\nBiggest structural gap: ${bug1}\n\nRebuilt version: ${fix1}\n\nWant the full breakdown — score, rebuilt copy, 3 variants?\nNo pitch, just the output.\n\n-- Alex\nstrategicflow.tech`;

  console.log(`[outreach-audit] completed for ${prospectCompany} (${contentUrl}) — score: ${score}`);

  res.json({
    prospect: {
      name:    prospectName    || '',
      company: prospectCompany || '',
      title:   prospectTitle   || ''
    },
    audit: {
      original_score: originalScore,
      top_bugs:       topBugs,
      top_fixes:      topFixes,
      best_subject:   bestSubject
    },
    content_url:   contentUrl,
    msg1_template: msg1
  });
});

// ─── END OUTREACH AUDIT ───────────────────────────────────────────────────────

// ─── PUBLISH TEARDOWN ─────────────────────────────────────────────────────────
// POST /publish-teardown — commits a teardown HTML file to GitHub Pages,
// injects a card into the showcase index.html, and keeps teardown counts
// in sync across all HTML files in the repo and locally. No auth required.

const GITHUB_REPO_OWNER = 'strategicflow-tech';
const GITHUB_REPO_NAME  = 'showcase';
const GITHUB_API_BASE   = 'https://api.github.com';

async function ghRequest(method, path, body) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  const resp = await fetch(`${GITHUB_API_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/vnd.github+json',
      'Content-Type':  'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`GitHub ${method} ${path} → ${resp.status}: ${json.message || JSON.stringify(json)}`);
  return json;
}

// Regex that matches "49 teardowns", "51+ teardowns", "49 teardown" etc.
const TEARDOWN_COUNT_RE = /\b(\d+)(\+?)\s*(teardown[s]?)\b/gi;

// Update teardown count in all local static HTML files + DB + process.env.
async function updateLocalTeardownCount(newCount) {
  const localFiles = [
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'public', 'patterns.html')
  ];
  for (const filePath of localFiles) {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      TEARDOWN_COUNT_RE.lastIndex = 0;
      const updated = content.replace(TEARDOWN_COUNT_RE,
        (_, _n, plus, word) => `${newCount}${plus} ${word}`);
      if (updated !== content) {
        await fs.promises.writeFile(filePath, updated, 'utf8');
        console.log(`[teardown-count] local updated: ${path.basename(filePath)}`);
      }
    } catch (e) {
      console.error(`[teardown-count] local file error (${path.basename(filePath)}):`, e.message);
    }
  }
  process.env.TEARDOWN_COUNT = String(newCount);
  try {
    await pool.query(
      `INSERT INTO system_config (key, value, updated_at) VALUES ('teardown_count', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [String(newCount)]
    );
  } catch (e) {
    console.error('[teardown-count] DB persist failed:', e.message);
  }
  console.log(`[teardown-count] count set to ${newCount}`);
}

// Scan all .html files in the GitHub showcase repo and update any teardown
// count references. Runs concurrently; safe to call after index.html commit.
async function updateGitHubTeardownCounts(repoPath, newCount) {
  let listing;
  try {
    listing = await ghRequest('GET', repoPath);
  } catch (e) {
    console.error('[teardown-count] GitHub listing failed:', e.message);
    return;
  }
  const htmlFiles = Array.isArray(listing)
    ? listing.filter(f => f.type === 'file' && f.name.endsWith('.html'))
    : [];
  console.log(`[teardown-count] scanning ${htmlFiles.length} GitHub HTML files`);

  await Promise.all(htmlFiles.map(async (file) => {
    try {
      const fileData = await ghRequest('GET', `${repoPath}/${file.name}`);
      const content  = Buffer.from(fileData.content, 'base64').toString('utf8');
      TEARDOWN_COUNT_RE.lastIndex = 0;
      if (!TEARDOWN_COUNT_RE.test(content)) return; // nothing to replace
      TEARDOWN_COUNT_RE.lastIndex = 0;
      const updated = content.replace(TEARDOWN_COUNT_RE,
        (_, _n, plus, word) => `${newCount}${plus} ${word}`);
      await ghRequest('PUT', `${repoPath}/${file.name}`, {
        message: `Update teardown count to ${newCount}: ${file.name}`,
        content: Buffer.from(updated).toString('base64'),
        sha:     fileData.sha
      });
      console.log(`[teardown-count] GitHub updated: ${file.name}`);
    } catch (e) {
      console.error(`[teardown-count] GitHub file error (${file.name}):`, e.message);
    }
  }));
}

app.post('/publish-teardown', async (req, res) => {
  const { filename, html, company, description, category, title } = req.body;

  if (!filename || !html || !company) {
    return res.status(400).json({ error: 'filename, html, and company are required' });
  }

  const cat      = category || 'saas';
  const pageUrl  = `https://${GITHUB_REPO_OWNER}.github.io/${GITHUB_REPO_NAME}/${filename}`;
  const repoPath = `/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents`;

  try {
    // ── STEP 1: Commit the teardown HTML file ──────────────────────────────
    let teardownSha;
    try {
      const existing = await ghRequest('GET', `${repoPath}/${filename}`);
      teardownSha = existing.sha;
      console.log(`[publish-teardown] ${filename} exists, SHA: ${teardownSha}`);
    } catch (e) {
      if (!e.message.includes('404')) throw e;
      console.log(`[publish-teardown] ${filename} is new`);
    }

    await ghRequest('PUT', `${repoPath}/${filename}`, {
      message: `Add teardown: ${title || company}`,
      content: Buffer.from(html).toString('base64'),
      ...(teardownSha ? { sha: teardownSha } : {})
    });
    console.log(`[publish-teardown] STEP 1 done — committed ${filename}`);

    // ── STEP 2: Fetch + patch index.html ──────────────────────────────────
    const indexData = await ghRequest('GET', `${repoPath}/index.html`);
    const indexSha  = indexData.sha;
    let   indexHtml = Buffer.from(indexData.content, 'base64').toString('utf8');

    // Build the new card
    const newCard = `<a href="${filename}" class="card" data-cat="${cat}">
  <div class="card-arrow">↗</div>
  <div class="card-brand">${company}</div>
  <div class="card-desc">${description || ''}</div>
  <div class="card-tags"><span class="tag teal">${cat}</span></div>
</a>`;

    // Inject card — before the first <a class="card"; fallback to <!-- cards -->; fallback to </main>
    if (indexHtml.includes('<a class="card"') || indexHtml.includes("<a class='card'")) {
      indexHtml = indexHtml.replace(/(<a\s[^>]*class="card")/, `${newCard}\n$1`);
    } else if (indexHtml.includes('<!-- cards -->')) {
      indexHtml = indexHtml.replace('<!-- cards -->', `<!-- cards -->\n${newCard}`);
    } else if (indexHtml.includes('</main>')) {
      indexHtml = indexHtml.replace('</main>', `${newCard}\n</main>`);
    } else {
      indexHtml += '\n' + newCard;
    }

    // Inject JSON-LD hasPart entry
    const newJsonLdEntry = `{"@type":"Article","name":${JSON.stringify(title || company)},"url":${JSON.stringify(pageUrl)}}`;
    if (indexHtml.includes('"hasPart"')) {
      indexHtml = indexHtml.replace(/(\"hasPart\"\s*:\s*\[)([\s\S]*?)(\])/, (_, open, inner, close) => {
        const trimmed = inner.trimEnd();
        const separator = trimmed.endsWith(',') || trimmed.trim() === '' ? '' : ',';
        return `${open}${inner}${separator}${newJsonLdEntry}${close}`;
      });
    }

    console.log(`[publish-teardown] STEP 2 done — index.html patched`);

    // ── STEP 3: Commit updated index.html ─────────────────────────────────
    await ghRequest('PUT', `${repoPath}/index.html`, {
      message: `Update showcase index: add ${company}`,
      content: Buffer.from(indexHtml).toString('base64'),
      sha:     indexSha
    });
    console.log(`[publish-teardown] STEP 3 done — index.html committed`);

    // ── STEP 4: Count cards + sync teardown count everywhere ───────────────
    const cardMatches = indexHtml.match(/<a\s[^>]*class="card"/g);
    const newCount    = cardMatches ? cardMatches.length : 0;
    console.log(`[publish-teardown] STEP 4 — new teardown count: ${newCount}`);

    // Run both sync tasks concurrently; don't block the response on GitHub scan
    updateLocalTeardownCount(newCount).catch(e =>
      console.error('[publish-teardown] local count sync error:', e.message));
    updateGitHubTeardownCounts(repoPath, newCount).catch(e =>
      console.error('[publish-teardown] GitHub count sync error:', e.message));

    res.json({ success: true, url: pageUrl, teardown_count: newCount });

  } catch (err) {
    console.error('[publish-teardown] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── END PUBLISH TEARDOWN ─────────────────────────────────────────────────────

// ─── DISTRIBB CMS WEBHOOK ───────────────────────────────────────────────────
// Generic "API webhook" CMS target for Distribb (distribb.io). Distribb calls
// this endpoint via POST /articles/:id/publish once this URL is registered as
// a webhook integration at https://distribb.io/integrations. Publishes a new
// article HTML page to the strategicflow-tech/showcase GitHub Pages repo and
// links it into blog.html (newest article first).

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80) || `article-${Date.now()}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderFrictionIndexHtml(companies) {
  const count = companies.length;
  const patternFreq = {};
  companies.forEach(c => (c.patterns || []).forEach(p => { patternFreq[p] = (patternFreq[p] || 0) + 1; }));
  const topPattern = Object.entries(patternFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const CONTENT_TYPE_LABELS = {
    email: 'Email',
    product_update_blog: 'Product Update',
    changelog: 'Changelog',
    landing_page: 'Landing Page',
    onboarding_sequence: 'Onboarding',
    newsletter: 'Newsletter',
    blog_article: 'Blog Article'
  };

  const rows = companies.map((c, i) => {
    const topPatternForRow = escapeHtml((c.patterns || [])[0] || '—');
    const typeLabel = escapeHtml(CONTENT_TYPE_LABELS[c.content_type] || c.content_type);
    const safeDomain = escapeHtml(c.domain);
    const safeName = escapeHtml(c.name);
    const safeSlug = escapeHtml(c.slug);
    const safeContentType = escapeHtml(c.content_type);
    return `
      <tr data-content-type="${safeContentType}">
        <td class="rank">${i + 1}</td>
        <td class="logo-cell"><img src="https://logo.clearbit.com/${safeDomain}" alt="${safeName} logo" loading="lazy" onerror="this.style.display='none'"></td>
        <td class="name-cell"><a href="/friction-index/${safeSlug}">${safeName}</a></td>
        <td class="score-cell">${Number(c.score).toFixed(1)}</td>
        <td class="pattern-cell">${topPatternForRow}</td>
        <td class="type-cell">${typeLabel}</td>
      </tr>`;
  }).join('\n');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: 'The Decision Friction Index',
    description: `${count} SaaS companies scored on structural conversion quality using the Strategic Flow 7-point diagnostic framework.`,
    creator: { '@type': 'Organization', name: 'Strategic Flow' },
    publisher: { '@type': 'Organization', name: 'Strategic Flow', url: 'https://strategicflow.tech' },
    hasPart: {
      '@type': 'ItemList',
      itemListElement: companies.map((c, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: c.name,
        url: `https://strategic-flow-audit.replit.app/friction-index/${c.slug}`
      }))
    }
  };

  const subtitleText = `${count} SaaS companies scored on structural conversion quality. Emails, product updates, changelogs, landing pages.${topPattern ? ` Most common failure: ${topPattern}.` : ''}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Decision Friction Index — ${count} SaaS Companies Scored | Strategic Flow</title>
<meta name="description" content="${escapeHtml(subtitleText)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
<style>
  :root{--bg:#0a1628;--card:#0f2035;--card2:#122440;--teal:#00d4c8;--teal-dim:#00a89e;--muted:#7a9ab8;--hairline:#1a3050;}
  *{box-sizing:border-box;}
  body{background:var(--bg);color:#fff;font-family:'Figtree',sans-serif;margin:0;padding:0;}
  .wrap{max-width:1000px;margin:0 auto;padding:60px 24px;}
  h1{font-size:36px;margin-bottom:8px;}
  .subtitle{color:var(--muted);font-size:16px;margin-bottom:32px;}
  select{background:var(--card);color:#fff;border:1px solid var(--hairline);padding:10px 14px;border-radius:8px;font-family:'Figtree',sans-serif;margin-bottom:24px;}
  table{width:100%;border-collapse:collapse;background:var(--card);border-radius:12px;overflow:hidden;}
  th,td{padding:14px 16px;text-align:left;border-bottom:1px solid var(--hairline);font-size:14px;}
  th{color:var(--muted);font-family:'DM Mono',monospace;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;}
  td.score-cell{font-family:'DM Mono',monospace;color:var(--teal);font-weight:600;}
  td.name-cell a{color:#fff;text-decoration:none;font-weight:600;}
  td.name-cell a:hover{color:var(--teal);}
  td.logo-cell img{width:24px;height:24px;border-radius:4px;object-fit:contain;background:#fff;}
  .rank{color:var(--muted);font-family:'DM Mono',monospace;}
  .empty-state{padding:60px 24px;text-align:center;color:var(--muted);background:var(--card);border-radius:12px;}
  .cta-banner{margin-top:40px;padding:32px;background:var(--card2);border-radius:12px;text-align:center;}
  .cta-banner a{display:inline-block;margin-top:16px;background:var(--teal);color:var(--bg);padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;}
  .site-header{display:flex;align-items:center;justify-content:space-between;max-width:1000px;margin:0 auto;padding:20px 24px;border-bottom:1px solid var(--hairline);flex-wrap:wrap;gap:12px;}
  .site-header .wordmark{font-family:'Figtree',sans-serif;font-weight:600;font-size:17px;color:#fff;text-decoration:none;}
  .site-header nav{display:flex;gap:24px;flex-wrap:wrap;}
  .site-header nav a{font-family:'Figtree',sans-serif;font-weight:600;font-size:14px;color:var(--muted);text-decoration:none;}
  .site-header nav a:hover{color:var(--teal);}
  .site-header nav a.current{color:var(--teal);}
  .site-footer{max-width:1000px;margin:60px auto 0;padding:32px 24px;border-top:1px solid var(--hairline);color:var(--muted);font-size:13px;line-height:1.8;}
  .site-footer a{color:var(--muted);text-decoration:none;}
  .site-footer a:hover{color:var(--teal);}
  .site-footer .footer-line3{margin-top:8px;opacity:0.7;}
  @media (max-width:480px){.site-header nav{gap:14px;}.site-header nav a{font-size:13px;}}
</style>
</head>
<body>
<div class="site-header">
  <a class="wordmark" href="/">Strategic Flow</a>
  <nav>
    <a href="/why">WHY. Diagnostic</a>
    <a href="/friction-index" class="current">The Index</a>
    <a href="https://strategic-flow-pro.replit.app/packages/">Pricing</a>
  </nav>
</div>
<div class="wrap">
  <h1>The Decision Friction Index</h1>
  <p class="subtitle">${escapeHtml(subtitleText)}</p>
  ${count === 0 ? `<div class="empty-state">No companies scored yet. Check back soon.</div>` : `
  <select id="filter" onchange="filterTable()">
    <option value="all">All content types</option>
    <option value="email">Email</option>
    <option value="product_update_blog">Product Update</option>
    <option value="changelog">Changelog</option>
    <option value="landing_page">Landing Page</option>
    <option value="onboarding_sequence">Onboarding</option>
    <option value="newsletter">Newsletter</option>
    <option value="blog_article">Blog Article</option>
  </select>
  <table>
    <thead><tr><th>#</th><th></th><th>Company</th><th>Score</th><th>Top Pattern</th><th>Type</th></tr></thead>
    <tbody id="rows">
      ${rows}
    </tbody>
  </table>`}
  <div class="cta-banner">
    <div>Wondering how your own content holds up?</div>
    <a href="/why">Find the friction in your own content — free</a>
  </div>
</div>
<footer class="site-footer">
  <div>The Decision Friction Index is published by Strategic Flow — behavioral email architecture diagnostics for B2B SaaS.</div>
  <div>
    <a href="https://strategicflow.tech">Strategic Flow</a> ·
    <a href="/why">WHY. Diagnostic</a> ·
    <a href="https://strategicflow.tech/teardowns.html">Teardowns</a> ·
    <a href="/friction-index/methodology">Methodology</a> ·
    <a href="https://strategic-flow-pro.replit.app/packages/">Pricing</a> ·
    <a href="mailto:strategicflow@proton.me">Contact</a>
  </div>
  <div class="footer-line3">© 2026 Strategic Flow · <a href="https://strategic-flow-pro.replit.app/terms.html">Terms</a></div>
</footer>
<script>
function filterTable(){
  const val = document.getElementById('filter').value;
  document.querySelectorAll('#rows tr').forEach(tr => {
    tr.style.display = (val === 'all' || tr.dataset.contentType === val) ? '' : 'none';
  });
}
</script>
</body>
</html>`;
}

function renderCompanyPageHtml(company) {
  const name = escapeHtml(company.name);
  const domain = escapeHtml(company.domain);
  const score = Number(company.score).toFixed(1);
  const patterns = Array.isArray(company.patterns) ? company.patterns : [];
  const summary = escapeHtml(company.diagnosis_summary || '');
  const excerpt = escapeHtml(company.input_excerpt || '');
  const metaDescription = escapeHtml((company.diagnosis_summary || '').slice(0, 160));

  const CONTENT_TYPE_LABELS = {
    email: 'Email',
    product_update_blog: 'Product Update',
    changelog: 'Changelog',
    landing_page: 'Landing Page',
    onboarding_sequence: 'Onboarding',
    newsletter: 'Newsletter',
    blog_article: 'Blog Article'
  };
  const typeLabel = escapeHtml(CONTENT_TYPE_LABELS[company.content_type] || company.content_type);

  const scoredDate = company.scored_at
    ? new Date(company.scored_at).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  const checks = Array.isArray(company.checks) ? company.checks : null;
  const VERDICT_STYLE = {
    pass: 'background:rgba(0,212,200,0.12);color:var(--teal);border:1px solid var(--teal-dim);',
    weak: 'background:var(--card2);color:var(--muted);border:1px solid var(--hairline);',
    fail: 'background:rgba(229,72,77,0.10);color:#e5484d;border:1px solid #e5484d;'
  };
  const checksHtml = checks ? `
  <div class="checks-section">
    <h2 class="checks-heading">7-point breakdown</h2>
    ${checks.map(c => `
    <div class="check-row">
      <div class="check-row-top">
        <span class="check-name">${escapeHtml(c.check)}</span>
        <span class="verdict-chip" style="${VERDICT_STYLE[c.verdict] || VERDICT_STYLE.weak}">${escapeHtml(c.verdict)}</span>
      </div>
      <p class="check-note">${escapeHtml(c.note)}</p>
    </div>`).join('\n    ')}
  </div>` : '';

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: company.name,
    url: `https://${company.domain}`,
    logo: `https://logo.clearbit.com/${company.domain}`,
    publisher: { '@type': 'Organization', name: 'Strategic Flow', url: 'https://strategicflow.tech' },
    review: {
      '@type': 'Review',
      reviewRating: {
        '@type': 'Rating',
        ratingValue: company.score,
        bestRating: '10',
        worstRating: '1'
      },
      author: { '@type': 'Organization', name: 'Strategic Flow' },
      reviewBody: company.diagnosis_summary
    }
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${name} Decision Friction Score: ${score}/10 | The Decision Friction Index</title>
<meta name="description" content="${metaDescription}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
<style>
  :root{--bg:#0a1628;--card:#0f2035;--card2:#122440;--teal:#00d4c8;--teal-dim:#00a89e;--muted:#7a9ab8;--hairline:#1a3050;}
  *{box-sizing:border-box;}
  body{background:var(--bg);color:#fff;font-family:'Figtree',sans-serif;margin:0;padding:0;}
  .wrap{max-width:720px;margin:0 auto;padding:60px 24px;}
  .header{display:flex;align-items:center;gap:16px;margin-bottom:24px;}
  .header img{width:48px;height:48px;border-radius:8px;background:#fff;object-fit:contain;}
  h1{font-size:28px;margin:0;}
  .badge{display:inline-block;background:var(--card2);color:var(--muted);font-family:'DM Mono',monospace;font-size:12px;padding:4px 10px;border-radius:6px;margin-top:8px;}
  .score-display{font-family:'DM Mono',monospace;font-size:64px;color:var(--teal);font-weight:600;margin:24px 0;}
  .patterns{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px;}
  .pattern-tag{background:var(--card);border:1px solid var(--hairline);color:#fff;font-size:13px;padding:6px 12px;border-radius:20px;}
  .summary{font-size:16px;line-height:1.6;color:#dce8f5;margin-bottom:24px;}
  blockquote{background:var(--card);border-left:3px solid var(--teal);padding:16px 20px;margin:0 0 32px;font-style:italic;color:var(--muted);}
  .cta-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:40px;}
  .cta-primary,.cta-secondary{display:inline-block;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;}
  .cta-primary{background:var(--teal);color:var(--bg);}
  .cta-secondary{background:var(--card2);color:#fff;border:1px solid var(--hairline);}
  .back-link{color:var(--muted);text-decoration:none;font-size:14px;}
  .site-header{display:flex;align-items:center;justify-content:space-between;max-width:720px;margin:0 auto;padding:20px 24px;border-bottom:1px solid var(--hairline);flex-wrap:wrap;gap:12px;}
  .site-header .wordmark{font-family:'Figtree',sans-serif;font-weight:600;font-size:17px;color:#fff;text-decoration:none;}
  .site-header nav{display:flex;gap:24px;flex-wrap:wrap;}
  .site-header nav a{font-family:'Figtree',sans-serif;font-weight:600;font-size:14px;color:var(--muted);text-decoration:none;}
  .site-header nav a:hover{color:var(--teal);}
  .site-header nav a.current{color:var(--teal);}
  .framework-note{font-size:13px;color:var(--muted);margin:-16px 0 24px;}
  .framework-note a{color:var(--muted);text-decoration:underline;}
  .framework-note a:hover{color:var(--teal);}
  .checks-section{margin:32px 0;}
  .checks-heading{font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);font-family:'DM Mono',monospace;margin:0 0 16px;}
  .check-row{background:var(--card);border:1px solid var(--hairline);border-radius:10px;padding:14px 16px;margin-bottom:10px;}
  .check-row-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px;}
  .check-name{font-weight:600;font-size:14px;color:#fff;}
  .verdict-chip{font-family:'DM Mono',monospace;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;padding:3px 10px;border-radius:20px;white-space:nowrap;}
  .check-note{font-size:13px;color:var(--muted);line-height:1.5;margin:0;}
  .excerpt-label{font-family:'DM Mono',monospace;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:6px;}
  .site-footer{max-width:720px;margin:0 auto;padding:32px 24px;border-top:1px solid var(--hairline);color:var(--muted);font-size:13px;line-height:1.8;}
  .site-footer a{color:var(--muted);text-decoration:none;}
  .site-footer a:hover{color:var(--teal);}
  .site-footer .footer-line3{margin-top:8px;opacity:0.7;}
  @media (max-width:480px){.site-header nav{gap:14px;}.site-header nav a{font-size:13px;}}
</style>
</head>
<body>
<div class="site-header">
  <a class="wordmark" href="/">Strategic Flow</a>
  <nav>
    <a href="/why">WHY. Diagnostic</a>
    <a href="/friction-index" class="current">The Index</a>
    <a href="https://strategic-flow-pro.replit.app/packages/">Pricing</a>
  </nav>
</div>
<div class="wrap">
  <div class="header">
    <img src="https://logo.clearbit.com/${domain}" alt="${name} logo" onerror="this.style.display='none'">
    <div>
      <h1>${name}</h1>
      <span class="badge">${typeLabel}</span>
    </div>
  </div>
  <div class="score-display">${score}/10</div>
  <div class="framework-note">${scoredDate ? `Scored ${scoredDate} · ` : ''}${typeLabel} · <a href="/friction-index/methodology">How scoring works →</a></div>
  <div class="patterns">
    ${patterns.map(p => `<span class="pattern-tag">${escapeHtml(p)}</span>`).join('\n    ')}
  </div>
  ${checksHtml}
  <p class="summary">${summary}</p>
  ${excerpt ? `<div class="excerpt-label">Scored excerpt${company.content_length ? ` (${company.content_length.toLocaleString('en-US')} chars analyzed)` : ''}</div><blockquote>${excerpt}</blockquote>` : ''}
  <div class="cta-row">
    <a class="cta-primary" href="/why">Find the friction in your own content — free</a>
    <a class="cta-secondary" href="https://strategic-flow-pro.replit.app/packages/">Get the full rebuild</a>
  </div>
  <a class="back-link" href="/friction-index">← Back to the Decision Friction Index</a>
</div>
<footer class="site-footer">
  <div>The Decision Friction Index is published by Strategic Flow — behavioral email architecture diagnostics for B2B SaaS.</div>
  <div>
    <a href="https://strategicflow.tech">Strategic Flow</a> ·
    <a href="/why">WHY. Diagnostic</a> ·
    <a href="https://strategicflow.tech/teardowns.html">Teardowns</a> ·
    <a href="/friction-index/methodology">Methodology</a> ·
    <a href="https://strategic-flow-pro.replit.app/packages/">Pricing</a> ·
    <a href="mailto:strategicflow@proton.me">Contact</a>
  </div>
  <div class="footer-line3">© 2026 Strategic Flow · <a href="https://strategic-flow-pro.replit.app/terms.html">Terms</a></div>
</footer>
</body>
</html>`;
}

function renderMethodologyHtml() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: 'How scores are produced — The Decision Friction Index Methodology',
    description: 'How Strategic Flow scores public SaaS content on structural conversion quality using a 7-point diagnostic framework.',
    publisher: { '@type': 'Organization', name: 'Strategic Flow', url: 'https://strategicflow.tech' },
    author: { '@type': 'Organization', name: 'Strategic Flow' }
  };

  const checksListHtml = INDEX_SEVEN_CHECKS.map((c, i) => `
      <li><strong>${i + 1}. ${escapeHtml(c.name)}</strong> — ${escapeHtml(c.explanation)}</li>`).join('');

  const patternsListHtml = INDEX_CANONICAL_PATTERNS.map(p => {
    const defs = {
      'Filing Label Subject': 'A subject line that names an internal category or feature instead of the outcome for the reader.',
      'Feature-First Bias': 'Leading with what was built rather than what the reader can now do.',
      'Guest Language CTA': 'A call to action phrased as a favor to the sender ("Learn more", "Submit") instead of a benefit to the reader.',
      'Consequence-After-Caveat': 'Burying the real stakes or impact after qualifiers, caveats, or disclaimers.',
      'Missing Visual Hierarchy': 'No formatting cues to guide the reader to what matters most.',
      'Zero/Buried Social Proof': 'No evidence of validation from other users, or proof buried far from the point it should support.'
    };
    return `\n      <li><strong>${escapeHtml(p)}</strong> — ${escapeHtml(defs[p] || '')}</li>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Methodology — How the Decision Friction Index Scores Content | Strategic Flow</title>
<meta name="description" content="How Strategic Flow scores public SaaS content on structural conversion quality using a 7-point diagnostic framework applied consistently by an AI diagnostic engine.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
<style>
  :root{--bg:#0a1628;--card:#0f2035;--card2:#122440;--teal:#00d4c8;--teal-dim:#00a89e;--muted:#7a9ab8;--hairline:#1a3050;}
  *{box-sizing:border-box;}
  body{background:var(--bg);color:#fff;font-family:'Figtree',sans-serif;margin:0;padding:0;}
  .wrap{max-width:720px;margin:0 auto;padding:60px 24px;}
  h1{font-size:32px;margin:0 0 8px;}
  .subtitle{color:var(--muted);font-size:16px;margin-bottom:40px;}
  h2{font-size:20px;margin:40px 0 16px;color:#fff;}
  p{font-size:15px;line-height:1.7;color:#dce8f5;margin:0 0 16px;}
  ul{padding-left:20px;margin:0 0 16px;}
  li{font-size:14px;line-height:1.7;color:#dce8f5;margin-bottom:10px;}
  li strong{color:#fff;}
  a{color:var(--teal);}
  .contact-note{background:var(--card);border:1px solid var(--hairline);border-radius:10px;padding:16px 20px;font-size:14px;color:var(--muted);}
  .contact-note a{color:var(--teal);}
  .back-link{color:var(--muted);text-decoration:none;font-size:14px;display:inline-block;margin-top:24px;}
  .site-header{display:flex;align-items:center;justify-content:space-between;max-width:720px;margin:0 auto;padding:20px 24px;border-bottom:1px solid var(--hairline);flex-wrap:wrap;gap:12px;}
  .site-header .wordmark{font-family:'Figtree',sans-serif;font-weight:600;font-size:17px;color:#fff;text-decoration:none;}
  .site-header nav{display:flex;gap:24px;flex-wrap:wrap;}
  .site-header nav a{font-family:'Figtree',sans-serif;font-weight:600;font-size:14px;color:var(--muted);text-decoration:none;}
  .site-header nav a:hover{color:var(--teal);}
  .site-header nav a.current{color:var(--teal);}
  .site-footer{max-width:720px;margin:0 auto;padding:32px 24px;border-top:1px solid var(--hairline);color:var(--muted);font-size:13px;line-height:1.8;}
  .site-footer a{color:var(--muted);text-decoration:none;}
  .site-footer a:hover{color:var(--teal);}
  .site-footer .footer-line3{margin-top:8px;opacity:0.7;}
  @media (max-width:480px){.site-header nav{gap:14px;}.site-header nav a{font-size:13px;}}
</style>
</head>
<body>
<div class="site-header">
  <a class="wordmark" href="/">Strategic Flow</a>
  <nav>
    <a href="/why">WHY. Diagnostic</a>
    <a href="/friction-index">The Index</a>
    <a href="https://strategic-flow-pro.replit.app/packages/">Pricing</a>
  </nav>
</div>
<div class="wrap">
  <h1>Methodology</h1>
  <p class="subtitle">How scores on the Decision Friction Index are produced.</p>

  <h2>How scores are produced</h2>
  <p>Every piece of content on the Index is evaluated against the same 7-point structural framework. Scoring is performed by an AI diagnostic engine (Claude, Anthropic) applying the Strategic Flow framework consistently across every company — the same checks, in the same order, every time.</p>
  <ul>${checksListHtml}
  </ul>
  <p>Scores range from 1 to 10, where 10 represents excellent structural quality (low decision friction) and 1 represents severe structural failure (high decision friction).</p>

  <h2>What we score</h2>
  <p>Only publicly available content: changelogs, product update blog posts, landing pages, newsletters, and blog articles. Each company page on the Index shows the content type scored, the excerpt that was evaluated, and the date it was scored.</p>

  <h2>What the score is NOT</h2>
  <p>The score is not a judgment of the product, the company, or the team behind it. It measures the structural conversion quality of one specific piece of communication, at one point in time — nothing more.</p>

  <h2>Limitations</h2>
  <p>Scores reflect a single content sample. Companies iterate constantly, and a score can improve the next time that company's content is re-scored. If you believe a score is out of date or based on the wrong sample, companies can request a re-score or a correction by contacting <a href="mailto:strategicflow@proton.me">strategicflow@proton.me</a>.</p>

  <h2>The pattern library</h2>
  <p>When content is scored, it may be tagged with one or more of these six canonical failure patterns:</p>
  <ul>${patternsListHtml}
  </ul>

  <div class="contact-note">Think your score is wrong, or your content has changed since it was scored? Email <a href="mailto:strategicflow@proton.me">strategicflow@proton.me</a> to request a re-score or correction.</div>

  <h2>Index scores vs WHY.™ Friction Scores</h2>
  <p>The Decision Friction Index and the WHY.™ diagnostic tool are built on the same underlying framework but serve different purposes. Index scores are produced with the fixed 7-point structural evaluation so companies can be compared consistently. WHY.™ delivers a deeper diagnosis of a single piece of content — friction points, predicted reader questions, and a rebuilt version — rather than a comparative ranking. The two scores are not directly interchangeable.</p>

  <a class="back-link" href="/friction-index">← Back to the Decision Friction Index</a>
</div>
<footer class="site-footer">
  <div>The Decision Friction Index is published by Strategic Flow — behavioral email architecture diagnostics for B2B SaaS.</div>
  <div>
    <a href="https://strategicflow.tech">Strategic Flow</a> ·
    <a href="/why">WHY. Diagnostic</a> ·
    <a href="https://strategicflow.tech/teardowns.html">Teardowns</a> ·
    <a href="/friction-index/methodology">Methodology</a> ·
    <a href="https://strategic-flow-pro.replit.app/packages/">Pricing</a> ·
    <a href="mailto:strategicflow@proton.me">Contact</a>
  </div>
  <div class="footer-line3">© 2026 Strategic Flow · <a href="https://strategic-flow-pro.replit.app/terms.html">Terms</a></div>
</footer>
</body>
</html>`;
}

function stripHtmlTags(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function estimateReadMinutes(html) {
  const words = stripHtmlTags(html).split(' ').filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

function buildDistribbArticleHtml({ title, contentHtml, metaDescription, slug, tag, dateStr, dateDisplay, readMinutes }) {
  const safeTitle = title || 'Untitled Article';
  const safeDesc  = metaDescription || stripHtmlTags(contentHtml).slice(0, 155);
  const safeTag   = tag || 'Email Architecture';
  const pageUrl   = `https://strategicflow.tech/blog/${slug}.html`;
  const dateDisplayForHeader = dateDisplay || dateStr;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-7TV731EJTB"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('consent', 'default', {
    'ad_storage': 'denied',
    'ad_user_data': 'denied',
    'ad_personalization': 'denied',
    'analytics_storage': 'denied',
    'wait_for_update': 500
  });
  gtag('js', new Date());
  gtag('config', 'G-7TV731EJTB');
</script>

<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle} — Strategic Flow</title>
<meta name="description" content="${safeDesc.replace(/"/g, '&quot;')}">
<meta name="robots" content="index, follow">
<meta name="author" content="Alex Iliescu — Strategic Flow">
<link rel="canonical" href="${pageUrl}">
<meta property="og:type" content="article">
<meta property="og:title" content="${safeTitle} — Strategic Flow">
<meta property="og:description" content="${safeDesc.replace(/"/g, '&quot;')}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:site_name" content="Strategic Flow">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${safeTitle}">
<meta name="twitter:description" content="${safeDesc.replace(/"/g, '&quot;')}">

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": ${JSON.stringify(safeTitle)},
  "description": ${JSON.stringify(safeDesc)},
  "datePublished": "${dateStr}",
  "dateModified": "${dateStr}",
  "author": {
    "@type": "Person",
    "name": "Alex Iliescu",
    "url": "https://strategicflow.tech",
    "jobTitle": "Founder, Strategic Flow Tech"
  },
  "publisher": {
    "@type": "Organization",
    "name": "Strategic Flow",
    "url": "https://strategicflow.tech"
  },
  "mainEntityOfPage": ${JSON.stringify(pageUrl)},
  "articleSection": ${JSON.stringify(safeTag)},
  "inLanguage": "en"
}
</script>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@400;500&family=Figtree:wght@400;500;600;700&display=swap" rel="stylesheet">

<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#0a1628;--bg2:#0f2035;
  --green:#00d4c8;
  --border2:rgba(0,212,200,0.28);
  --text:#ffffff;--text2:rgba(255,255,255,0.85);--text3:#7a9ab8;
  --red:#f87171;--border:#1a3050;
  --sans:'Figtree',sans-serif;--serif:'DM Serif Display',serif;--mono:'DM Mono',monospace;
}
html,body{width:100%;background:var(--bg);color:var(--text);font-family:var(--sans);}
nav{display:flex;align-items:center;justify-content:space-between;padding:18px 48px;border-bottom:1px solid var(--border);position:sticky;top:0;background:rgba(10,22,40,0.96);backdrop-filter:blur(14px);z-index:100;}
.nav-logo{font-family:var(--serif);font-size:19px;color:#fff;letter-spacing:-.01em;text-decoration:none;}
.nav-logo em{color:var(--green);font-style:italic;}
.nav-links{display:flex;gap:24px;align-items:center;}
.nav-link{font-size:12px;color:var(--text2);text-decoration:none;font-family:var(--mono);letter-spacing:.04em;transition:color .2s;}
.nav-link:hover,.nav-link.active{color:var(--green);}
.nav-cta{background:var(--green);color:#07090f;padding:8px 18px;border-radius:6px;font-size:12px;font-weight:600;text-decoration:none;transition:opacity .2s;}
.nav-cta:hover{opacity:.85;}
.hamburger{display:none;flex-direction:column;gap:5px;background:none;border:none;cursor:pointer;padding:4px;}
.hamburger span{display:block;width:22px;height:2px;background:var(--text2);transition:.3s;}
.hamburger.open span:nth-child(1){transform:translateY(7px) rotate(45deg);}
.hamburger.open span:nth-child(2){opacity:0;}
.hamburger.open span:nth-child(3){transform:translateY(-7px) rotate(-45deg);}
.mobile-menu{display:none;position:fixed;top:58px;left:0;right:0;bottom:0;background:rgba(10,22,40,0.98);z-index:99;overflow-y:auto;padding:24px 20px;}
.mobile-menu.open{display:block;}
.mm-item{display:flex;justify-content:space-between;align-items:center;padding:14px 0;border-bottom:1px solid var(--border);color:var(--text2);text-decoration:none;font-size:14px;}
.mm-item:hover{color:var(--green);}
.mm-cta{display:block;background:var(--green);color:#07090f;text-align:center;padding:13px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;margin-top:20px;}
@media(max-width:768px){.nav-links{display:none;}.hamburger{display:flex;}}
.article-header{max-width:720px;margin:0 auto;padding:72px 48px 48px;}
.breadcrumb{display:flex;gap:8px;align-items:center;font-family:var(--mono);font-size:10px;color:var(--text3);letter-spacing:.06em;margin-bottom:28px;flex-wrap:wrap;}
.breadcrumb a{color:var(--text3);text-decoration:none;}
.breadcrumb a:hover{color:var(--green);}
.breadcrumb-sep{color:var(--border);}
.article-tag{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--green);border:1px solid var(--border2);padding:4px 12px;border-radius:20px;margin-bottom:20px;}
.article-h1{font-family:var(--serif);font-size:clamp(32px,4.5vw,52px);line-height:1.1;letter-spacing:-.02em;margin-bottom:16px;}
.article-h1 em{font-style:italic;color:var(--green);}
.article-meta-row{display:flex;gap:20px;align-items:center;font-family:var(--mono);font-size:11px;color:var(--text3);margin-bottom:32px;}
.article-lede{font-size:19px;color:var(--text2);line-height:1.65;border-left:2px solid var(--green);padding-left:20px;}
.article-body{max-width:720px;margin:0 auto;padding:0 48px 80px;}
.article-body p{font-size:16px;color:var(--text2);line-height:1.75;margin-bottom:22px;}
.article-body ul,.article-body ol{padding-left:24px;margin-bottom:22px;}
.article-body li{font-size:16px;color:var(--text2);line-height:1.75;margin-bottom:10px;}
.article-body h2{font-family:var(--serif);font-size:26px;line-height:1.2;margin:48px 0 16px;color:#fff;}
.article-body h3{font-family:var(--mono);font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--green);margin:32px 0 12px;}
.article-body strong{color:#fff;font-weight:600;}
.article-body a{color:var(--green);text-decoration:underline;}
footer{border-top:1px solid var(--border);padding:32px 48px;text-align:center;}
.footer-links{display:flex;gap:24px;justify-content:center;flex-wrap:wrap;margin-bottom:10px;}
.footer-links a{font-size:12px;color:#1D9E75;text-decoration:none;font-family:var(--mono);}
.footer-links a:hover{color:#fff;}
.footer-copy{font-family:var(--mono);font-size:11px;color:#1D9E75;}
@media(max-width:600px){.article-header,.article-body{padding-left:20px;padding-right:20px;}footer{padding:28px 20px;}}
</style>
</head>
<body>

<nav aria-label="Main navigation">
  <a href="https://strategicflow.tech/" class="nav-logo">Strategic<em>Flow</em></a>
  <div class="nav-links">
    <a href="https://strategicflow.tech/teardowns.html" class="nav-link">Teardowns</a>
    <a href="https://strategicflow.tech/glossary.html" class="nav-link">Glossary</a>
    <a href="/blog.html" class="nav-link active">Blog</a>
    <a href="https://strategic-flow-audit.replit.app" class="nav-link" target="_blank" rel="noopener">Free Audit</a>
    <a href="https://strategic-flow-pro.replit.app" class="nav-cta" target="_blank" rel="noopener">Rebuild Yours →</a>
  </div>
  <button class="hamburger" id="hamburger" aria-label="Toggle menu" aria-expanded="false">
    <span></span><span></span><span></span>
  </button>
</nav>
<div class="mobile-menu" id="mobile-menu">
  <a href="https://strategicflow.tech/teardowns.html" class="mm-item">Teardowns</a>
  <a href="https://strategicflow.tech/glossary.html" class="mm-item">Glossary</a>
  <a href="/blog.html" class="mm-item" style="color:var(--green);">Blog</a>
  <a href="https://strategic-flow-audit.replit.app" class="mm-item" target="_blank" rel="noopener">Free Audit</a>
  <a href="https://strategic-flow-pro.replit.app" class="mm-cta" target="_blank" rel="noopener">Rebuild Yours →</a>
</div>
<script>
(function(){
  var h=document.getElementById('hamburger'),m=document.getElementById('mobile-menu');
  if(!h||!m)return;
  function close(){h.classList.remove('open');m.classList.remove('open');h.setAttribute('aria-expanded','false');}
  h.addEventListener('click',function(e){e.stopPropagation();m.classList.contains('open')?close():(h.classList.add('open'),m.classList.add('open'),h.setAttribute('aria-expanded','true'));});
  m.querySelectorAll('a').forEach(function(a){a.addEventListener('click',close);});
  document.addEventListener('click',function(e){if(!m.contains(e.target)&&!h.contains(e.target))close();});
})();
</script>

<header class="article-header">
  <nav class="breadcrumb" aria-label="Breadcrumb">
    <a href="https://strategicflow.tech/">Strategic Flow</a>
    <span class="breadcrumb-sep">/</span>
    <a href="/blog.html">Blog</a>
    <span class="breadcrumb-sep">/</span>
    <span>${safeTitle}</span>
  </nav>
  <div class="article-tag">${safeTag}</div>
  <h1 class="article-h1">${safeTitle}</h1>
  <div class="article-meta-row">
    <span>By Alex Iliescu, founder of Strategic Flow Tech</span>
    <span>·</span>
    <span>${dateDisplayForHeader}</span>
    <span>·</span>
    <span>${readMinutes} min read</span>
  </div>
</header>

<article class="article-body">
${contentHtml}
</article>

<footer>
  <div class="footer-links">
    <a href="https://strategicflow.tech/">Strategic Flow</a>
    <a href="https://strategicflow.tech/teardowns.html">Teardowns</a>
    <a href="https://strategicflow.tech/glossary.html">Glossary</a>
    <a href="/blog.html">Blog</a>
    <a href="https://strategic-flow-audit.replit.app" target="_blank" rel="noopener">Free Audit</a>
    <a href="https://strategic-flow-pro.replit.app" target="_blank" rel="noopener">Pro Plans</a>
  </div>
  <div class="footer-copy">Strategic Flow &copy; 2026 &middot; <a href="https://strategicflow.tech" style="color:#1D9E75;text-decoration:none;">strategicflow.tech</a></div>
</footer>

</body>
</html>`;
}

app.post('/api/distribb-publish', async (req, res) => {
  const providedSecret =
    req.headers['x-webhook-secret'] ||
    req.headers['x-distribb-secret'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
    req.query.secret ||
    req.body?.secret;

  if (!process.env.DISTRIBB_WEBHOOK_SECRET || providedSecret !== process.env.DISTRIBB_WEBHOOK_SECRET) {
    return res.status(401).json({ success: false, error: 'Invalid or missing webhook secret' });
  }

  const body = req.body || {};
  console.log('[distribb-publish] incoming payload:', JSON.stringify(body).slice(0, 2000));

  const deepGet = (obj, keys) => {
    for (const k of keys) {
      if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    }
    return undefined;
  };
  const firstArticle = (body.data && Array.isArray(body.data.articles) && body.data.articles[0])
    || (Array.isArray(body.articles) && body.articles[0])
    || null;
  const nested = body.article || firstArticle || body.data || body.payload || {};

  const title = deepGet(body, ['title', 'Title', 'headline', 'post_title', 'article_title', 'name'])
    || deepGet(nested, ['title', 'Title', 'headline', 'post_title', 'article_title', 'name']);
  const contentHtml = deepGet(body, ['content', 'html', 'body', 'Content', 'html_content', 'body_html', 'post_content', 'article_content', 'article_body'])
    || deepGet(nested, ['content', 'html', 'body', 'Content', 'html_content', 'body_html', 'post_content', 'article_content', 'article_body', 'content_html']);
  const metaDescription = deepGet(body, ['meta_description', 'metaDescription', 'MetaDescription', 'excerpt', 'description'])
    || deepGet(nested, ['meta_description', 'metaDescription', 'MetaDescription', 'excerpt', 'description']);
  const keyword = deepGet(body, ['keyword', 'main_keyword', 'MainKeyword'])
    || deepGet(nested, ['keyword', 'main_keyword', 'MainKeyword']);
  const tag  = deepGet(body, ['category', 'tag']) || deepGet(nested, ['category', 'tag']) || keyword;
  let   slug = deepGet(body, ['slug', 'Slug']) || deepGet(nested, ['slug', 'Slug']);

  if (!title || !contentHtml) {
    // No recognizable article fields — treat this as a connectivity/test ping
    // (e.g. Distribb's "Send Test Payload" button) rather than a hard error,
    // so the integration can be saved. Real publish calls always include title+content.
    console.log('[distribb-publish] no title/content detected — responding as connectivity test');
    return res.status(200).json({
      success: true,
      test: true,
      message: 'Webhook reachable. No title/content fields detected in this payload, so nothing was published.'
    });
  }

  slug = slug ? slugify(slug) : slugify(title);
  const dateStr      = new Date().toISOString().slice(0, 10);
  const dateDisplay  = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const readMinutes  = estimateReadMinutes(contentHtml);
  const repoPath     = `/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents`;
  const pageUrl      = `https://strategicflow.tech/blog/${slug}.html`;

  try {
    const articleHtml = buildDistribbArticleHtml({
      title, contentHtml, metaDescription, slug, tag, dateStr, dateDisplay, readMinutes
    });

    // STEP 1: commit the article page (create or update if slug already exists)
    let articleSha;
    try {
      const existing = await ghRequest('GET', `${repoPath}/blog/${slug}.html`);
      articleSha = existing.sha;
    } catch (e) {
      if (!e.message.includes('404')) throw e;
    }
    await ghRequest('PUT', `${repoPath}/blog/${slug}.html`, {
      message: `Distribb: publish article "${title}"`,
      content: Buffer.from(articleHtml).toString('base64'),
      ...(articleSha ? { sha: articleSha } : {})
    });
    console.log(`[distribb-publish] committed blog/${slug}.html`);

    // STEP 2: prepend a card to blog.html (newest first)
    const blogData = await ghRequest('GET', `${repoPath}/blog.html`);
    const blogSha  = blogData.sha;
    let   blogHtml = Buffer.from(blogData.content, 'base64').toString('utf8');

    const excerpt = (metaDescription || stripHtmlTags(contentHtml)).slice(0, 200);
    const newCard = `
    <a href="/blog/${slug}.html" class="article-card">
      <div class="article-meta">
        <span class="article-date">${dateDisplay}</span>
        <span class="article-read">${readMinutes} min read</span>
        <span class="article-tag">${tag || 'Email Architecture'}</span>
      </div>
      <h2 class="article-title">${title}</h2>
      <p class="article-excerpt">${excerpt}</p>
      <span class="article-cta">Read article →</span>
    </a>
`;

    if (blogHtml.includes('<div class="articles-grid">')) {
      blogHtml = blogHtml.replace('<div class="articles-grid">', `<div class="articles-grid">\n${newCard}`);
    } else {
      throw new Error('articles-grid container not found in blog.html');
    }

    await ghRequest('PUT', `${repoPath}/blog.html`, {
      message: `Distribb: add article card for "${title}"`,
      content: Buffer.from(blogHtml).toString('base64'),
      sha: blogSha
    });
    console.log(`[distribb-publish] blog.html updated with new card`);

    res.json({
      success: true,
      status: 'published',
      url: pageUrl,
      article_url: pageUrl,
      published_url: pageUrl,
      slug
    });

  } catch (err) {
    console.error('[distribb-publish] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── END DISTRIBB CMS WEBHOOK ───────────────────────────────────────────────

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

      const combined = await claudeJSON(combinedPrompt, 2500);
      if (!combined) throw new Error('Assessment failed');

      const diagnostic = combined;
      const rebuild = combined;

      try {
        const companyName = company || 'Unknown';
        const origScore   = diagnostic.score;
        const rebScore    = rebuild.rebuiltScore || 9;
        console.log('[api/demo] calling Resend from=' + SENDER + ' to=consultantcalatorii@gmail.com');
        const resendResult = await resend.emails.send({
          from: 'Strategic Flow <onboarding@resend.dev>',
          to: 'consultantcalatorii@gmail.com',
          subject: `Demo run: ${companyName} — score ${origScore}/10`,
          html: `<p><strong>Work email:</strong> ${emailLower}</p>
                 <p><strong>Company name:</strong> ${companyName}</p>
                 <p><strong>Subscriber count:</strong> ${subscribers || 'not provided'}</p>
                 <p><strong>Original score:</strong> ${origScore}/10</p>
                 <p><strong>Rebuilt score:</strong> ${rebScore}/10</p>
                 <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>`
        });
        console.log('[api/demo] Resend response:', JSON.stringify(resendResult));
        if (resendResult.error) {
          console.error('[api/demo] Resend error detail:', JSON.stringify(resendResult.error));
        } else {
          console.log(`[api/demo] notification sent OK → consultantcalatorii@gmail.com | ${companyName} | ${origScore}/10 → ${rebScore}/10 | id=${resendResult.data && resendResult.data.id}`);
        }
      } catch (e) {
        console.error('[api/demo] notify exception:', e.message, JSON.stringify(e));
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

// ── DEMO REBUILD ENDPOINT ─────────────────────────────────────────────────────
app.post('/api/demo-rebuild', async (req, res) => {
  const { email_text } = req.body;
  if (!email_text || typeof email_text !== 'string' || email_text.trim().length < 10) {
    return res.status(400).json({ error: 'email_text required' });
  }

  const normalized = email_text.trim().replace(/\s+/g, ' ').toLowerCase();
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');

  try {
    const r = await pool.query('SELECT count FROM demo_rebuilds WHERE hash = $1', [hash]);
    if (r.rows.length > 0 && r.rows[0].count >= 3) {
      return res.status(429).json({ error: 'limit_reached' });
    }
  } catch (e) {
    console.error('[api/demo-rebuild] check limit error:', e.message);
  }

  const truncated = email_text.trim().slice(0, 8000);

  const prompt = `You are the Strategic Flow rebuild engine. A user has pasted their SaaS email. Return ONLY valid JSON, no markdown fences, no extra text before or after.

JSON shape (all keys required):
{
  "original_subject": "extracted or inferred subject line from the pasted email",
  "rebuilt_subject": "consequence-first rewrite of the subject line",
  "rebuilt_body": ["paragraph 1", "paragraph 2", "paragraph 3"],
  "rebuilt_cta": "rewritten CTA text with ownership language (e.g. Fix my X, not Learn more)",
  "variants": [
    { "label": "A", "subject": "...", "pattern": "consequence-first + time anchor" },
    { "label": "B", "subject": "...", "pattern": "named pain without feature language" },
    { "label": "C", "subject": "...", "pattern": "social proof + specificity hook" }
  ],
  "changes": [
    {
      "element": "Hook",
      "before": "exact line quoted verbatim from the pasted email",
      "after": "exact rebuilt line",
      "why": "one sentence structural reason tied to reader behavior"
    }
  ]
}

Rules you must follow:
- changes array: 4 to 6 entries. Every "before" value MUST be a verbatim quote copied exactly from the pasted email below. Never invent a "before" line.
- rebuilt_body: keep the user's real product name, real numbers, and real claims from their email. Never fabricate features or metrics not present in the email.
- No em dashes (long dashes) or en dashes anywhere in any generated text. Use commas or periods instead.
- All 3 variants must be present with exactly the pattern labels given above.
- rebuilt_cta: use ownership language.
- rebuilt_subject: must be consequence-first, specific, and tied to reader outcome.

Pasted email to rebuild:
${truncated}`;

  let result = await claudeJSON(prompt, 3000);
  if (!result) {
    result = await claudeJSON(prompt, 3000);
    if (!result) {
      console.error('[api/demo-rebuild] both attempts returned null');
      return res.status(422).json({ error: 'rebuild_failed' });
    }
  }

  try {
    await pool.query(`
      INSERT INTO demo_rebuilds (hash, count, created_at)
      VALUES ($1, 1, NOW())
      ON CONFLICT (hash) DO UPDATE SET count = demo_rebuilds.count + 1
    `, [hash]);
  } catch (e) {
    console.error('[api/demo-rebuild] increment error:', e.message);
  }

  let usedCount = 1;
  try {
    const r = await pool.query('SELECT count FROM demo_rebuilds WHERE hash = $1', [hash]);
    if (r.rows.length > 0) usedCount = r.rows[0].count;
  } catch (e) {}

  console.log(`[api/demo-rebuild] ok hash=${hash.slice(0,8)} count=${usedCount}`);
  return res.json({ ...result, rebuild_count: usedCount });
});
// ─── END DEMO REBUILD ENDPOINT ────────────────────────────────────────────────

// ── MCP AUDIT ENDPOINT (ChatGPT integration) ──────────────────────────────────
app.post('/api/mcp/audit', async (req, res) => {
  const { email_text, chatgpt_user_id } = req.body;

  if (!email_text || typeof email_text !== 'string' || email_text.trim().length < 10) {
    return res.status(400).json({ error: 'email_text required' });
  }
  if (!chatgpt_user_id || typeof chatgpt_user_id !== 'string') {
    return res.status(400).json({ error: 'chatgpt_user_id required' });
  }

  const userId = chatgpt_user_id.trim().slice(0, 128);

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mcp_usage (
        user_id TEXT PRIMARY KEY,
        count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const r = await pool.query('SELECT count FROM mcp_usage WHERE user_id = $1', [userId]);
    if (r.rows.length > 0 && r.rows[0].count >= 3) {
      return res.status(429).json({
        error: 'trial_limit_reached',
        message: 'You have used all 3 free audits.',
        upgrade_url: 'https://strategic-flow-pro.replit.app/packages'
      });
    }
  } catch (e) {
    console.error('[mcp/audit] limit check error:', e.message);
  }

  const truncated = email_text.trim().slice(0, 8000);
  const prompt = `You are the Strategic Flow rebuild engine. A user has pasted their SaaS email. Return ONLY valid JSON, no markdown fences, no extra text before or after.
JSON shape (all keys required):
{
  "original_subject": "extracted or inferred subject line from the pasted email",
  "rebuilt_subject": "consequence-first rewrite of the subject line",
  "rebuilt_body": ["paragraph 1", "paragraph 2", "paragraph 3"],
  "rebuilt_cta": "rewritten CTA text with ownership language (e.g. Fix my X, not Learn more)",
  "variants": [
    { "label": "A", "subject": "...", "pattern": "consequence-first + time anchor" },
    { "label": "B", "subject": "...", "pattern": "named pain without feature language" },
    { "label": "C", "subject": "...", "pattern": "social proof + specificity hook" }
  ],
  "changes": [
    {
      "element": "Hook",
      "before": "exact line quoted verbatim from the pasted email",
      "after": "exact rebuilt line",
      "why": "one sentence structural reason tied to reader behavior"
    }
  ]
}
Rules:
- changes array: 4 to 6 entries. Every before value MUST be verbatim from the pasted email.
- rebuilt_body: keep real product name, real numbers, real claims. Never fabricate.
- No em dashes or en dashes anywhere.
- All 3 variants must be present.
- rebuilt_cta: ownership language.
- rebuilt_subject: consequence-first, specific, tied to reader outcome.
Pasted email:
${truncated}`;

  let result = await claudeJSON(prompt, 3000);
  if (!result) {
    result = await claudeJSON(prompt, 3000);
    if (!result) {
      return res.status(422).json({ error: 'rebuild_failed' });
    }
  }

  try {
    await pool.query(`
      INSERT INTO mcp_usage (user_id, count, updated_at)
      VALUES ($1, 1, NOW())
      ON CONFLICT (user_id) DO UPDATE
      SET count = mcp_usage.count + 1, updated_at = NOW()
    `, [userId]);
  } catch (e) {
    console.error('[mcp/audit] increment error:', e.message);
  }

  let usedCount = 1;
  try {
    const r = await pool.query('SELECT count FROM mcp_usage WHERE user_id = $1', [userId]);
    if (r.rows.length > 0) usedCount = r.rows[0].count;
  } catch (e) {}

  return res.json({
    ...result,
    audits_used: usedCount,
    audits_remaining: Math.max(0, 3 - usedCount),
    upgrade_url: usedCount >= 3 ? 'https://strategic-flow-pro.replit.app/packages' : null
  });
});
// ── END MCP AUDIT ENDPOINT ────────────────────────────────────────────────────

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

The 7 bugs: 1. Filing Label Title 2. No Lead Consequence 3. Feature-First Language 4. Flat Hierarchy 5. Zero Numbers 6. Dead-End CTA 7. Buried Before/After.

CONTENT DENSITY RULES — never return single-sentence values for any of these fields:
- rebuilt_lead: minimum 3 sentences. Sentence 1 names the reader's operational change. Sentence 2 names the specific consequence they gain. Sentence 3 closes with the new behavior state or a social proof anchor.
- entry1_after: minimum 4 sentences. Sentence 1 names what the reader no longer has to do. Sentence 2 gives the specific outcome. Sentence 3 anchors it with a number, time saving, or behavioral contrast. Sentence 4 names the new workflow state.
- after_contrast: full Before block (2 sentences naming the specific friction state and its cost) then full After block (2 sentences naming the resolved state and its measurable or behavioral marker). Use explicit "Before:" and "After:" labels.
- wc[].after: minimum 2 sentences. Sentence 1 is the rebuilt copy or structural description. Sentence 2 names why this architecture change improves conversion or reader behaviour.`;

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

  let companyHint = '';
  if (url) {
    try {
      const _host = new URL(url.startsWith('http') ? url : 'https://' + url).hostname.replace(/^www\./, '');
      companyHint = `SOURCE DOMAIN: ${_host}. The company publishing this content is the owner of that domain. Use the brand name matching ${_host} as the "company" field — do not use company names that merely appear as examples or case studies within the content.\n\n`;
    } catch(e) {}
  }
  try {
    const response = await claude.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: getLangInstruction(lang) + '\n\n' + CHANGELOG_AUDIT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `${companyHint}Analyze this SaaS changelog page:\n\n${content.slice(0, 8000)}` }],
    });

    const raw = ((response.content.find(b => b.type === 'text')?.text) || '').trim().replace(/^```json\s*|^```\s*|```$/g, '').trim();
    const result = safeParseJSON(raw);
    if (!result) {
      console.error('[changelog-audit] JSON parse failed. Raw:', raw.slice(0, 300));
      return res.status(500).json({ error: 'Claude returned invalid JSON' });
    }
    console.log('CHANGELOG RESPONSE:', JSON.stringify(result, null, 2));
    console.log('[changelog-audit] response (200): company=', result.company, 'bugs_found=', result.bugs_found);
        const { generateChangelogAuditHtml } = require('./showcase-generator');
        res.json({...result, downloadHtml: generateChangelogAuditHtml(result)});
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
      model: MODEL,
      max_tokens: 16000,
      system: getLangInstruction(lang) + '\n\n' + ONBOARDING_AUDIT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Analyze this SaaS onboarding copy:\n\n${content.slice(0, 8000)}` }],
    });

    const raw = ((response.content.find(b => b.type === 'text')?.text) || '').trim().replace(/^```json\s*|^```\s*|```$/g, '').trim();
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
      model: MODEL,
      max_tokens: 16000,
      system: getLangInstruction(lang) + '\n\n' + LINKEDIN_AUDIT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Analyze this LinkedIn post:\n\n${content.slice(0, 8000)}` }],
    });

    const raw = ((response.content.find(b => b.type === 'text')?.text) || '').trim().replace(/^```json\s*|^```\s*|```$/g, '').trim();
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

// ── GET /release-note-system ─────────────────────────────────────────────────
app.get('/release-note-system', (req, res) => {
  res.sendFile('release-note-system.html', { root: path.join(__dirname, 'public') });
});

// ── POST /release-note-system ─────────────────────────────────────────────────
app.post('/release-note-system', async (req, res) => {
  const { text } = req.body;
  if (!text || text.trim().length < 30) {
    return res.status(400).json({ error: 'Paste at least 30 characters of changelog text.' });
  }

  const prompt = `You are an expert email copywriter trained on the Strategic Flow Method.

A SaaS company has given you raw release notes / changelog text. Transform it into a consequence-first release email.

STRATEGIC FLOW RULES:
1. Subject line: outcome or consequence first, never a filing label ("New Feature", "Update", "Introducing" are banned). Use a curiosity gap or specific result.
2. Preview text: extends the subject line tension, never repeats it.
3. Email body: lead with the reader's outcome, not the product change. Group minor fixes at the bottom under a single "Also fixed" line. Use short paragraphs, one idea per paragraph.
4. Ownership CTA: the reader does something, not just "Learn more". e.g. "Run your first export →"

INPUT CHANGELOG:
${text.trim().slice(0, 4000)}

Return ONLY valid JSON with this exact schema:
{
  "subject_line": "consequence-first subject line",
  "subject_score": 7,
  "preview_text": "preview text that extends tension",
  "email_html": "<full HTML email body as a string — inline styles, table-safe, dark background #0a0a08, white text #f4f2ed, blue CTA #4A8FE7>",
  "failures": [
    { "pattern": "Filing Label Subject", "explanation": "Original notes use feature-first framing" }
  ]
}

subject_score: 1-10. Score +2 for a number, +2 for consequence/failure state, +1 for under 50 chars, +1 for no generic words, +2 for curiosity gap, +2 for specific outcome.
failures: array of failure patterns found in the ORIGINAL raw notes (not in your rebuild). Max 5. Empty array if none found.
email_html: complete standalone HTML email, inline styles only, no external CSS, renders in Gmail/Outlook. Include subject repeated as H1, preview text as hidden preheader span, body copy, and CTA button.`;

  try {
    const result = await claudeJSON(prompt, 3000);
    if (!result || !result.subject_line) {
      return res.status(500).json({ error: 'Generation failed — Claude returned unexpected output. Please try again.' });
    }
      res.json(result);
  } catch (e) {
    console.error('[release-note-system]', e.message);
    res.status(500).json({ error: 'Generation failed. Please try again.' });
  }
});

setupDB().then(async () => {
  await runMonthlyAudit();

  // Bootstrap TEARDOWN_COUNT from DB if not already set via env var
  if (!process.env.TEARDOWN_COUNT) {
    try {
      const r = await pool.query(`SELECT value FROM system_config WHERE key = 'teardown_count'`);
      if (r.rows.length) {
        process.env.TEARDOWN_COUNT = r.rows[0].value;
        console.log(`[startup] TEARDOWN_COUNT loaded from DB: ${process.env.TEARDOWN_COUNT}`);
      }
    } catch (e) {
      console.error('[startup] TEARDOWN_COUNT load failed:', e.message);
    }
  }

  const PORT = process.env.PORT || 3000;

  const whyUsage = {};

  // ── WHY. logging helpers ──────────────────────────────────────────────────
  const WHY_LOG_FILE = path.join(__dirname, 'why-log.json');

  function readWhyLog() {
    try {
      const raw = fs.readFileSync(WHY_LOG_FILE, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      return [];
    }
  }

  function appendWhyLog(entry) {
    setImmediate(() => {
      try {
        const log = readWhyLog();
        log.push(entry);
        fs.writeFileSync(WHY_LOG_FILE, JSON.stringify(log, null, 2));
      } catch (e) {
        console.error('[why-log] write error:', e.message);
      }
    });
  }

  function anonymizeIp(ip) {
    if (!ip || ip === 'unknown') return 'unknown';
    // IPv4
    const v4 = ip.match(/^(\d+\.\d+\.\d+\.)\d+$/);
    if (v4) return v4[1] + '0';
    // IPv4-mapped IPv6 (::ffff:1.2.3.4)
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.)\d+$/i);
    if (mapped) return '::ffff:' + mapped[1] + '0';
    // IPv6 — zero last group
    if (ip.includes(':')) {
      const parts = ip.split(':');
      parts[parts.length - 1] = '0';
      return parts.join(':');
    }
    return ip;
  }

  // Initialise log file if missing
  if (!fs.existsSync(WHY_LOG_FILE)) {
    fs.writeFileSync(WHY_LOG_FILE, '[]');
  }
  // ─────────────────────────────────────────────────────────────────────────

  app.post('/api/why-analyze', async (req, res) => {
    const rawIp = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const ipParts = rawIp.split('.');
    if (ipParts.length === 4) ipParts[3] = '0';
    const ip = ipParts.join('.');
    const anonIp = ip;
    const WHY_WHITELIST = (process.env.WHY_ADMIN_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
    const { prompt, contentType, rawContent } = req.body;
    const charCount = typeof prompt === 'string' ? prompt.length : 0;
    const isProUser = (req.session && req.session.isWhyPro === true) ||
      (req.session && BYPASS_EMAILS.has(req.session.userEmail)) ||
      (req.session && BYPASS_EMAILS.has(req.session.whyProEmail));
    if (!isProUser && !WHY_WHITELIST.includes(ip)) {
      const used = whyUsage[ip] || 0;
      if (used >= 3) {
        appendWhyLog({ timestamp: new Date().toISOString(), ip: anonIp, route: '/api/why-analyze', content_type: contentType || 'unknown', char_count: charCount, status: 'rate_limited' });
        return res.status(429).json({ error: 'limit_reached' });
      }
      whyUsage[ip] = used + 1;
    }
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // Phase 1: create job row, return id immediately
    let jobId;
    try {
      const jr = await pool.query(
        `INSERT INTO why_jobs (status, job_type, content_type, input_excerpt)
         VALUES ('pending', 'analyze', $1, $2) RETURNING id`,
        [contentType || null, (rawContent || '').slice(0, 200)]
      );
      jobId = jr.rows[0].id;
    } catch (dbErr) {
      return res.status(500).json({ error: 'job_create_failed' });
    }
    res.json({ id: jobId });

    // Phase 2: fire-and-forget — completely separate from res lifecycle
    try { appendWhyLog({ timestamp: new Date().toISOString(), ip: anonIp, route: '/api/why-analyze', content_type: contentType || 'unknown', char_count: charCount, status: 'queued' }); } catch (_) {}

    const capturedSession = req.session;
    ;(async () => {
      try {
        const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: MODEL, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] })
        });
        const data = await apiResp.json();
        const textBlock = data.content?.find(b => b.type === 'text');
        const text = textBlock?.text || '';
        const clean = text.replace(/```json|```/g, '').trim();
        let result = safeParseJSON(clean);
        if (!result) {
          const rawSnippet = ('RAW: ' + clean).slice(0, 3000);
          await pool.query(
            `UPDATE why_jobs SET status='error', error_message='parse_failed', raw_response_snippet=$2, completed_at=NOW() WHERE id=$1`,
            [jobId, rawSnippet]
          ).catch(() => {});
          try { appendWhyLog({ timestamp: new Date().toISOString(), ip: anonIp, route: '/api/why-analyze', content_type: contentType || 'unknown', char_count: charCount, status: 'error' }); } catch (_) {}
          return;
        }
        await pool.query(`UPDATE why_jobs SET status='complete', result_json=$1, completed_at=NOW() WHERE id=$2`,
          [JSON.stringify(result), jobId]).catch(() => {});
        try { appendWhyLog({ timestamp: new Date().toISOString(), ip: anonIp, route: '/api/why-analyze', content_type: contentType || 'unknown', char_count: charCount, status: 'success' }); } catch (_) {}
        const isSessionPro = (capturedSession && capturedSession.isWhyPro === true) ||
          (capturedSession && BYPASS_EMAILS.has(capturedSession.userEmail)) ||
          (capturedSession && BYPASS_EMAILS.has(capturedSession.whyProEmail));
        if (isSessionPro) {
          const userEmail = capturedSession.whyProEmail || capturedSession.userEmail;
          if (userEmail) {
            const excerpt = typeof rawContent === 'string' ? rawContent.slice(0, 200) : '';
            const diagSummary = result.summary || result.verdict || null;
            const score = typeof result.friction_score === 'number' ? result.friction_score : null;
            pool.query(
              `INSERT INTO why_analyses (user_email, action_type, content_type, input_excerpt, diagnosis_summary, score, full_result_json)
               VALUES ($1, 'analyze', $2, $3, $4, $5, $6)`,
              [userEmail, contentType || null, excerpt, diagSummary, score, JSON.stringify(result)]
            ).catch(e => console.error('[why_analyses] insert error:', e.message));
          }
        }
      } catch (err) {
        await pool.query(`UPDATE why_jobs SET status='error', error_message=$1, completed_at=NOW() WHERE id=$2`,
          [err.message.slice(0, 500), jobId]).catch(() => {});
        try { appendWhyLog({ timestamp: new Date().toISOString(), ip: anonIp, route: '/api/why-analyze', content_type: contentType || 'unknown', char_count: charCount, status: 'error' }); } catch (_) {}
      }
    })();
  });

  app.post('/api/why-rebuild', async (req, res) => {
    const rawIp = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const ipParts = rawIp.split('.');
    if (ipParts.length === 4) ipParts[3] = '0';
    const ip = ipParts.join('.');
    const anonIp = ip;
    const WHY_WHITELIST = (process.env.WHY_ADMIN_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
    const { prompt, contentType, rawContent, frictionScore } = req.body;
    const charCount = typeof prompt === 'string' ? prompt.length : 0;
    const isProUser = (req.session && req.session.isWhyPro === true) ||
      (req.session && BYPASS_EMAILS.has(req.session.userEmail)) ||
      (req.session && BYPASS_EMAILS.has(req.session.whyProEmail));
    if (!isProUser && !WHY_WHITELIST.includes(ip)) {
      const used = whyUsage[ip] || 0;
      if (used >= 3) {
        appendWhyLog({ timestamp: new Date().toISOString(), ip: anonIp, route: '/api/why-rebuild', content_type: contentType || 'unknown', char_count: charCount, status: 'rate_limited' });
        return res.status(429).json({ error: 'limit_reached' });
      }
      whyUsage[ip] = used + 1;
    }
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // Phase 1: create job row, return id immediately
    let jobId;
    try {
      const jr = await pool.query(
        `INSERT INTO why_jobs (status, job_type, content_type, input_excerpt)
         VALUES ('pending', 'rebuild', $1, $2) RETURNING id`,
        [contentType || null, (rawContent || '').slice(0, 200)]
      );
      jobId = jr.rows[0].id;
    } catch (dbErr) {
      return res.status(500).json({ error: 'job_create_failed' });
    }
    res.json({ id: jobId });

    // Phase 2: fire-and-forget — completely separate from res lifecycle
    try { appendWhyLog({ timestamp: new Date().toISOString(), ip: anonIp, route: '/api/why-rebuild', content_type: contentType || 'unknown', char_count: charCount, status: 'queued' }); } catch (_) {}

    const capturedSession = req.session;
    ;(async () => {
      try {
        const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: MODEL, max_tokens: 16000, messages: [{ role: 'user', content: prompt }] })
        });
        const data = await apiResp.json();
        const textBlock = data.content?.find(b => b.type === 'text');
        const text = textBlock?.text || '';
        if (!text) {
          await pool.query(`UPDATE why_jobs SET status='error', error_message='empty_response', completed_at=NOW() WHERE id=$1`, [jobId]).catch(() => {});
          try { appendWhyLog({ timestamp: new Date().toISOString(), ip: anonIp, route: '/api/why-rebuild', content_type: contentType || 'unknown', char_count: charCount, status: 'error' }); } catch (_) {}
          return;
        }
        await pool.query(`UPDATE why_jobs SET status='complete', result_json=$1, completed_at=NOW() WHERE id=$2`,
          [JSON.stringify({ text }), jobId]).catch(() => {});
        try { appendWhyLog({ timestamp: new Date().toISOString(), ip: anonIp, route: '/api/why-rebuild', content_type: contentType || 'unknown', char_count: charCount, status: 'success' }); } catch (_) {}
        const isSessionPro = (capturedSession && capturedSession.isWhyPro === true) ||
          (capturedSession && BYPASS_EMAILS.has(capturedSession.userEmail)) ||
          (capturedSession && BYPASS_EMAILS.has(capturedSession.whyProEmail));
        if (isSessionPro) {
          const userEmail = capturedSession.whyProEmail || capturedSession.userEmail;
          if (userEmail) {
            const excerpt = typeof rawContent === 'string' ? rawContent.slice(0, 200) : '';
            pool.query(
              `INSERT INTO why_analyses
                 (user_email, action_type, content_type, input_excerpt, diagnosis_summary, score, full_result_json)
               VALUES ($1, 'rebuild', $2, $3, NULL, $5, $4)`,
              [userEmail, contentType || null, excerpt, JSON.stringify({ type: 'rebuild', text }), (typeof frictionScore === 'number' ? frictionScore : null)]
            ).catch(e => console.error('[why_analyses] insert error:', e.message));
          }
        }
      } catch (err) {
        await pool.query(`UPDATE why_jobs SET status='error', error_message=$1, completed_at=NOW() WHERE id=$2`,
          [err.message.slice(0, 500), jobId]).catch(() => {});
        try { appendWhyLog({ timestamp: new Date().toISOString(), ip: anonIp, route: '/api/why-rebuild', content_type: contentType || 'unknown', char_count: charCount, status: 'error' }); } catch (_) {}
      }
    })();
  });

  app.get('/api/why-job/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const r = await pool.query(
        `SELECT status, job_type, result_json, error_message FROM why_jobs
         WHERE id = $1 AND created_at > NOW() - INTERVAL '2 hours'`,
        [id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
      const job = r.rows[0];
      if (job.status === 'complete') {
        return res.json({ status: 'complete', jobType: job.job_type, result: JSON.parse(job.result_json) });
      }
      if (job.status === 'error') {
        return res.json({ status: 'error', error: job.error_message });
      }
      return res.json({ status: 'pending' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/why-history', async (req, res) => {
    const isProUser = (req.session && req.session.isWhyPro === true) ||
      (req.session && BYPASS_EMAILS.has(req.session.userEmail)) ||
      (req.session && BYPASS_EMAILS.has(req.session.whyProEmail));
    if (!isProUser) {
      return res.status(401).json({ error: 'Pro session required' });
    }
    const userEmail = req.session.whyProEmail || req.session.userEmail;
    if (!userEmail) return res.status(401).json({ error: 'No email in session' });
    try {
      const rowsRes = await pool.query(
        `SELECT id, action_type, content_type, input_excerpt, diagnosis_summary, score, full_result_json, created_at
         FROM why_analyses
         WHERE user_email = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [userEmail]
      );
      const statsRes = await pool.query(
        `SELECT
           COUNT(*) AS total_count,
           ROUND(AVG(score)::numeric, 1) AS avg_score,
           (SELECT ROUND(AVG(score)::numeric, 1)
            FROM (SELECT score FROM why_analyses
                  WHERE user_email = $1 AND score IS NOT NULL
                  ORDER BY created_at ASC LIMIT 3) first3
           ) AS avg_first3,
           (SELECT ROUND(AVG(score)::numeric, 1)
            FROM (SELECT score FROM why_analyses
                  WHERE user_email = $1 AND score IS NOT NULL
                  ORDER BY created_at DESC LIMIT 3) last3
           ) AS avg_last3,
           COUNT(CASE WHEN score IS NOT NULL THEN 1 END) AS scored_count
         FROM why_analyses
         WHERE user_email = $1`,
        [userEmail]
      );
      const s = statsRes.rows[0];
      const totalCount = parseInt(s.total_count, 10);
      const scoredCount = parseInt(s.scored_count, 10);
      const avgScore = s.avg_score !== null ? parseFloat(s.avg_score) : null;
      const avgFirst3 = s.avg_first3 !== null ? parseFloat(s.avg_first3) : null;
      const avgLast3 = s.avg_last3 !== null ? parseFloat(s.avg_last3) : null;
      const trend = (scoredCount >= 3 && avgFirst3 !== null && avgLast3 !== null)
        ? parseFloat((avgLast3 - avgFirst3).toFixed(1))
        : null;
      res.json({
        rows: rowsRes.rows,
        stats: { total_count: totalCount, scored_count: scoredCount, avg_score: avgScore, avg_first3: avgFirst3, avg_last3: avgLast3, trend }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/why-stats', (req, res) => {
    const adminKey = process.env.WHY_ADMIN_KEY;
    const provided = req.headers['x-admin-key'] || req.query.key;
    if (!adminKey || provided !== adminKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const log = readWhyLog();
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    let totalAnalyses = 0, totalRebuilds = 0, rateLimited = 0, last24h = 0;
    const byContentType = {};
    for (const e of log) {
      if (e.route === '/api/why-analyze') totalAnalyses++;
      if (e.route === '/api/why-rebuild') totalRebuilds++;
      if (e.status === 'rate_limited') rateLimited++;
      if (new Date(e.timestamp).getTime() >= cutoff) last24h++;
      if (e.status === 'success') {
        const ct = e.content_type || 'unknown';
        byContentType[ct] = (byContentType[ct] || 0) + 1;
      }
    }
    return res.json({
      total_analyses: totalAnalyses,
      total_rebuilds: totalRebuilds,
      rate_limited: rateLimited,
      by_content_type: byContentType,
      last_24h: last24h,
      log_entries: log.slice(-50)
    });
  });

  app.get('/api/why-log', async (req, res) => {
    const adminKey = process.env.WHY_ADMIN_KEY;
    const provided = req.headers['x-admin-key'] || req.query.key;
    if (!adminKey || provided !== adminKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const page    = Math.max(1, parseInt(req.query.page) || 1);
      const limit   = 50;
      const offset  = (page - 1) * limit;
      const status  = req.query.status   || null;
      const jobType = req.query.job_type || null;

      const conditions = [];
      const params     = [];
      if (status)  { params.push(status);  conditions.push(`status = $${params.length}`); }
      if (jobType) { params.push(jobType); conditions.push(`job_type = $${params.length}`); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await pool.query(`SELECT COUNT(*) FROM why_jobs ${where}`, params);
      const total = parseInt(countResult.rows[0].count);

      const dataParams = [...params, limit, offset];
      const dataResult = await pool.query(
        `SELECT id, job_type, content_type, input_excerpt, status,
                created_at, completed_at, error_message
         FROM why_jobs ${where}
         ORDER BY created_at DESC
         LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
        dataParams
      );

      res.json({
        total,
        page,
        pages: Math.ceil(total / limit) || 1,
        rows: dataResult.rows
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── DECISION FRICTION INDEX ───────────────────────────────────────────────
  app.post('/api/index/score', async (req, res) => {
    const providedKey = req.headers['x-admin-key'];
    if (!INDEX_ADMIN_KEY || providedKey !== INDEX_ADMIN_KEY) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { name, domain, content_type, content } = req.body || {};
    if (!name || !domain || !content_type || !content) {
      return res.status(400).json({ error: 'name, domain, content_type, and content are required' });
    }
    const slug = slugify(name);

    try {
      const existing = await pool.query('SELECT * FROM index_companies WHERE slug = $1', [slug]);
      if (existing.rows.length) {
        return res.status(409).json({ error: 'already_scored', company: existing.rows[0] });
      }

      const prompt = buildIndexScoringPrompt(content_type, content);
      const result = await scoreContentWithClaude(prompt);

      if (result.input_quality === 'polluted') {
        return res.status(422).json({ error: 'polluted_input' });
      }

      const score = typeof result.score === 'number' ? result.score : parseFloat(result.score);
      const patterns = Array.isArray(result.patterns)
        ? result.patterns.filter(p => INDEX_CANONICAL_PATTERNS.includes(p))
        : [];
      const diagnosisSummary = result.diagnosis_summary || '';
      const inputExcerpt = String(content).slice(0, 1000);
      const contentLength = String(content).length;

      let checks = null;
      if (Array.isArray(result.checks) && result.checks.length === 7) {
        const valid = result.checks.every((c, i) =>
          c && c.check === INDEX_SEVEN_CHECKS[i].name &&
          ['pass', 'weak', 'fail'].includes(c.verdict) &&
          typeof c.note === 'string' && c.note.trim().length > 0
        );
        if (valid) checks = result.checks;
      }

      const insert = await pool.query(
        `INSERT INTO index_companies (slug, name, domain, content_type, score, patterns, diagnosis_summary, input_excerpt, checks, content_length)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [slug, name, domain, content_type, score, JSON.stringify(patterns), diagnosisSummary, inputExcerpt, checks ? JSON.stringify(checks) : null, contentLength]
      );
      const row = insert.rows[0];
      res.json({ slug: row.slug, score: row.score, patterns: row.patterns, url: `/friction-index/${row.slug}` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/index/add-sample', async (req, res) => {
    const providedKey = req.headers['x-admin-key'];
    if (!INDEX_ADMIN_KEY || providedKey !== INDEX_ADMIN_KEY) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { slug, content_type, content, source_url } = req.body || {};
    if (!slug || !content_type || !content) {
      return res.status(400).json({ error: 'slug, content_type, and content are required' });
    }

    try {
      const companyRes = await pool.query('SELECT * FROM index_companies WHERE slug = $1', [slug]);
      if (!companyRes.rows.length) {
        return res.status(404).json({ error: 'company_not_found' });
      }

      const prompt = buildIndexScoringPrompt(content_type, content);
      const result = await scoreContentWithClaude(prompt);

      if (result.input_quality === 'polluted') {
        return res.status(422).json({ error: 'polluted_input' });
      }

      const score = typeof result.score === 'number' ? result.score : parseFloat(result.score);
      const patterns = Array.isArray(result.patterns)
        ? result.patterns.filter(p => INDEX_CANONICAL_PATTERNS.includes(p))
        : [];
      const diagnosisSummary = result.diagnosis_summary || '';
      const inputExcerpt = String(content).slice(0, 1000);
      const contentLength = String(content).length;

      let checks = null;
      if (Array.isArray(result.checks) && result.checks.length === 7) {
        const valid = result.checks.every((c, i) =>
          c && c.check === INDEX_SEVEN_CHECKS[i].name &&
          ['pass', 'weak', 'fail'].includes(c.verdict) &&
          typeof c.note === 'string' && c.note.trim().length > 0
        );
        if (valid) checks = result.checks;
      }

      const sampleInsert = await pool.query(
        `INSERT INTO index_content_samples (company_slug, content_type, score, patterns, checks, diagnosis_summary, input_excerpt, content_length, source_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [slug, content_type, score, JSON.stringify(patterns), checks ? JSON.stringify(checks) : null, diagnosisSummary, inputExcerpt, contentLength, source_url || null]
      );
      const sample = sampleInsert.rows[0];

      const allSamples = await pool.query('SELECT score, patterns FROM index_content_samples WHERE company_slug = $1', [slug]);
      const sampleCount = allSamples.rows.length;
      const avgScore = allSamples.rows.reduce((sum, r) => sum + Number(r.score), 0) / sampleCount;
      const newAverageScore = Math.round(avgScore * 10) / 10;

      const patternFreq = {};
      allSamples.rows.forEach(r => (r.patterns || []).forEach(p => { patternFreq[p] = (patternFreq[p] || 0) + 1; }));
      const topPatterns = Object.entries(patternFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([p]) => p);

      await pool.query(
        `UPDATE index_companies SET score = $1, patterns = $2, checks = NULL WHERE slug = $3`,
        [newAverageScore, JSON.stringify(topPatterns), slug]
      );

      res.json({
        slug,
        new_average_score: newAverageScore,
        sample_count: sampleCount,
        sample_added: sample
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/index/admin-delete', async (req, res) => {
    const providedKey = req.headers['x-admin-key'];
    if (!INDEX_ADMIN_KEY || providedKey !== INDEX_ADMIN_KEY) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { slugs } = req.body || {};
    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({ error: 'slugs array is required' });
    }
    try {
      const result = await pool.query('DELETE FROM index_companies WHERE slug = ANY($1) RETURNING slug', [slugs]);
      res.json({ deleted_count: result.rowCount, deleted_slugs: result.rows.map(r => r.slug) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/index/companies', async (req, res) => {
    const { content_type } = req.query;
    try {
      const params = [];
      let where = '';
      if (content_type) {
        params.push(content_type);
        where = 'WHERE content_type = $1';
      }
      const r = await pool.query(
        `SELECT slug, name, domain, score, patterns, content_type, scored_at
         FROM index_companies ${where}
         ORDER BY score DESC`,
        params
      );
      const companies = r.rows;
      const count = companies.length;
      const average_score = count ? +(companies.reduce((s, c) => s + Number(c.score), 0) / count).toFixed(1) : 0;
      const patternFreq = {};
      companies.forEach(c => (c.patterns || []).forEach(p => { patternFreq[p] = (patternFreq[p] || 0) + 1; }));
      const top_pattern = Object.entries(patternFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      res.json({ companies, stats: { count, average_score, top_pattern } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/friction-index', async (req, res) => {
    try {
      const r = await pool.query('SELECT slug, name, domain, score, patterns, content_type FROM index_companies ORDER BY score DESC');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send(renderFrictionIndexHtml(r.rows));
    } catch (err) {
      res.status(500).send('Error loading Decision Friction Index');
    }
  });

  app.get('/friction-index/methodology', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(renderMethodologyHtml());
  });

  app.get('/friction-index/:slug', async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM index_companies WHERE slug = $1', [req.params.slug]);
      if (!r.rows.length) return res.status(404).send('Company not found');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send(renderCompanyPageHtml(r.rows[0]));
    } catch (err) {
      res.status(500).send('Error loading company page');
    }
  });

  app.get('/sitemap-index.xml', async (req, res) => {
    try {
      const r = await pool.query('SELECT slug, scored_at FROM index_companies ORDER BY scored_at DESC');
      const urls = [
        `<url><loc>https://strategic-flow-audit.replit.app/friction-index</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`,
        ...r.rows.map(c => `<url><loc>https://strategic-flow-audit.replit.app/friction-index/${c.slug}</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>`)
      ].join('\n  ');
      res.setHeader('Content-Type', 'application/xml');
      res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  ${urls}\n</urlset>`);
    } catch (err) {
      res.status(500).send('Error generating sitemap');
    }
  });

  // ── DISTRIBB PUBLISH WEBHOOK ──────────────────────────────────────────────
  // Receives articles from Distribb and publishes to GitHub Pages.
  // Webhook URL: https://strategic-flow-audit.replit.app/distribb-publish
  // Auth header: X-Distribb-Secret: <ADMIN_PASSWORD>
  // Required body fields: title, content (HTML body)
  // Optional: slug, meta_description, keyword, date (YYYY-MM-DD), read_time, excerpt

  const GITHUB_REPO_API = 'https://api.github.com/repos/strategicflow-tech/showcase/contents/';

  async function ghGet(path) {
    const r = await fetch(GITHUB_REPO_API + path, {
      headers: { Authorization: 'token ' + process.env.GITHUB_TOKEN, 'User-Agent': 'sf-server' }
    });
    if (!r.ok) throw new Error('GitHub GET ' + path + ' → ' + r.status);
    return r.json();
  }

  async function ghPut(path, content, sha, message) {
    const body = { message, content: Buffer.from(content).toString('base64') };
    if (sha) body.sha = sha;
    const r = await fetch(GITHUB_REPO_API + path, {
      method: 'PUT',
      headers: { Authorization: 'token ' + process.env.GITHUB_TOKEN, 'Content-Type': 'application/json', 'User-Agent': 'sf-server' },
      body: JSON.stringify(body)
    });
    if (!r.ok) { const t = await r.text(); throw new Error('GitHub PUT ' + path + ' → ' + r.status + ' ' + t.slice(0,200)); }
    return r.json();
  }

  function toSlug(str) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function buildBlogPage({ title, content, slug, meta_description, keyword, date, read_time }) {
    const today = date || new Date().toISOString().split('T')[0];
    const dateDisplay = new Date(today).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const mins = read_time || Math.max(3, Math.round(content.replace(/<[^>]+>/g, '').split(/\s+/).length / 200));
    const canonical = `https://strategicflow.tech/blog/${slug}.html`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-7TV731EJTB"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('consent','default',{'ad_storage':'denied','ad_user_data':'denied','ad_personalization':'denied','analytics_storage':'denied','wait_for_update':500});gtag('js',new Date());gtag('config','G-7TV731EJTB');</script>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Strategic Flow</title>
<meta name="description" content="${meta_description}">
<meta name="keywords" content="${keyword}, SaaS email architecture, Strategic Flow">
<meta name="robots" content="index, follow">
<meta name="author" content="Alex Iliescu — Strategic Flow">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="${title} — Strategic Flow">
<meta property="og:description" content="${meta_description}">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="Strategic Flow">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title} — Strategic Flow">
<meta name="twitter:description" content="${meta_description}">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"${title}","description":"${meta_description}","datePublished":"${today}","dateModified":"${today}","author":{"@type":"Person","name":"Alex Iliescu","url":"https://strategicflow.tech"},"publisher":{"@type":"Organization","name":"Strategic Flow","url":"https://strategicflow.tech"},"mainEntityOfPage":"${canonical}","inLanguage":"en"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Strategic Flow","item":"https://strategicflow.tech"},{"@type":"ListItem","position":2,"name":"Blog","item":"https://strategicflow.tech/blog.html"},{"@type":"ListItem","position":3,"name":"${title}","item":"${canonical}"}]}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@400;500&family=Figtree:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{--bg:#0a1628;--green:#00d4c8;--border2:rgba(0,212,200,0.28);--text:#fff;--text2:rgba(255,255,255,0.85);--text3:#7a9ab8;--border:#1a3050;--sans:'Figtree',sans-serif;--serif:'DM Serif Display',serif;--mono:'DM Mono',monospace;}
html,body{width:100%;background:var(--bg);color:var(--text);font-family:var(--sans);}
nav{display:flex;align-items:center;justify-content:space-between;padding:18px 48px;border-bottom:1px solid var(--border);position:sticky;top:0;background:rgba(10,22,40,0.96);backdrop-filter:blur(14px);z-index:100;}
.nav-logo{font-family:var(--serif);font-size:19px;color:#fff;letter-spacing:-.01em;text-decoration:none;}
.nav-logo em{color:var(--green);font-style:italic;}
.nav-links{display:flex;gap:24px;align-items:center;}
.nav-link{font-size:12px;color:var(--text2);text-decoration:none;font-family:var(--mono);letter-spacing:.04em;transition:color .2s;}
.nav-link:hover,.nav-link.active{color:var(--green);}
.nav-cta{background:var(--green);color:#07090f;padding:8px 18px;border-radius:6px;font-size:12px;font-weight:600;text-decoration:none;}
.hamburger{display:none;flex-direction:column;gap:5px;background:none;border:none;cursor:pointer;padding:4px;}
.hamburger span{display:block;width:22px;height:2px;background:var(--text2);transition:.3s;}
.hamburger.open span:nth-child(1){transform:translateY(7px) rotate(45deg);}
.hamburger.open span:nth-child(2){opacity:0;}
.hamburger.open span:nth-child(3){transform:translateY(-7px) rotate(-45deg);}
.mobile-menu{display:none;position:fixed;top:58px;left:0;right:0;bottom:0;background:rgba(10,22,40,0.98);z-index:99;overflow-y:auto;padding:24px 20px;}
.mobile-menu.open{display:block;}
.mm-item{display:flex;justify-content:space-between;align-items:center;padding:14px 0;border-bottom:1px solid var(--border);color:var(--text2);text-decoration:none;font-size:14px;}
.mm-item:hover{color:var(--green);}
.mm-cta{display:block;background:var(--green);color:#07090f;text-align:center;padding:13px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;margin-top:20px;}
@media(max-width:768px){.nav-links{display:none;}.hamburger{display:flex;}}
.article-header{max-width:720px;margin:0 auto;padding:72px 48px 48px;}
.breadcrumb{display:flex;gap:8px;align-items:center;font-family:var(--mono);font-size:10px;color:var(--text3);letter-spacing:.06em;margin-bottom:28px;flex-wrap:wrap;}
.breadcrumb a{color:var(--text3);text-decoration:none;}
.breadcrumb a:hover{color:var(--green);}
.breadcrumb-sep{color:var(--border);}
.article-tag{display:inline-flex;align-items:center;font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--green);border:1px solid var(--border2);padding:4px 12px;border-radius:20px;margin-bottom:20px;}
.article-h1{font-family:var(--serif);font-size:clamp(32px,4.5vw,52px);line-height:1.1;letter-spacing:-.02em;margin-bottom:16px;}
.article-meta-row{display:flex;gap:20px;align-items:center;font-family:var(--mono);font-size:11px;color:var(--text3);margin-bottom:32px;}
.article-lede{font-size:19px;color:var(--text2);line-height:1.65;border-left:2px solid var(--green);padding-left:20px;}
.article-body{max-width:720px;margin:0 auto;padding:0 48px 80px;}
.article-body p{font-size:16px;color:var(--text2);line-height:1.75;margin-bottom:22px;}
.article-body ul,.article-body ol{padding-left:24px;margin-bottom:22px;}
.article-body li{font-size:16px;color:var(--text2);line-height:1.75;margin-bottom:10px;}
.article-body h2{font-family:var(--serif);font-size:26px;line-height:1.2;margin:48px 0 16px;color:#fff;}
.article-body h3{font-family:var(--mono);font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--green);margin:32px 0 12px;}
.article-body strong{color:#fff;font-weight:600;}
.article-body a{color:var(--green);text-decoration:underline;}
.article-body .btn-p{color:#07090f;text-decoration:none;}
.before-after{display:grid;grid-template-columns:1fr 1fr;gap:2px;background:var(--border);margin:28px 0;border-radius:8px;overflow:hidden;}
.ba-box{padding:18px 20px;}
.ba-before{background:rgba(248,113,113,0.06);}
.ba-after{background:rgba(0,212,200,0.04);}
.ba-label{font-family:var(--mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:10px;}
.ba-before .ba-label{color:#f87171;}
.ba-after .ba-label{color:var(--green);}
.ba-text{font-size:14px;color:var(--text2);line-height:1.6;}
@media(max-width:560px){.before-after{grid-template-columns:1fr;}}
.data-callout{background:rgba(0,212,200,0.04);border:1px solid var(--border2);border-radius:10px;padding:24px 28px;margin:32px 0;}
.data-callout-label{font-family:var(--mono);font-size:9px;color:var(--green);letter-spacing:.16em;text-transform:uppercase;margin-bottom:12px;}
.data-row{display:flex;justify-content:space-between;align-items:baseline;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);}
.data-row:last-child{border-bottom:none;}
.data-pattern{font-size:14px;color:var(--text2);}
.data-pct{font-family:var(--mono);font-size:16px;color:var(--green);}
.article-cta{background:rgba(0,212,200,0.04);border:1px solid var(--border2);border-radius:10px;padding:32px;margin:48px 0 0;display:flex;flex-direction:column;gap:12px;}
.article-cta-label{font-family:var(--mono);font-size:10px;color:var(--green);letter-spacing:.14em;text-transform:uppercase;}
.article-cta-title{font-family:var(--serif);font-size:24px;line-height:1.2;}
.article-cta-sub{font-size:14px;color:var(--text2);line-height:1.65;}
.btn-p{display:inline-flex;align-items:center;gap:8px;background:var(--green);color:#07090f;padding:11px 22px;border-radius:7px;font-size:13px;font-weight:600;text-decoration:none;transition:opacity .2s;margin-top:4px;}
.btn-p:hover{opacity:.85;}
footer{border-top:1px solid var(--border);padding:32px 48px;text-align:center;}
.footer-links{display:flex;gap:24px;justify-content:center;flex-wrap:wrap;margin-bottom:10px;}
.footer-links a{font-size:12px;color:#1D9E75;text-decoration:none;font-family:var(--mono);}
.footer-links a:hover{color:#fff;}
.footer-copy{font-family:var(--mono);font-size:11px;color:#1D9E75;}
#cookie-banner{position:fixed;left:0;right:0;bottom:0;z-index:10000;background:#09111e;border-top:1px solid rgba(255,255,255,0.08);padding:18px 48px;display:none;}
#cookie-banner.visible{display:flex;}
.cookie-inner{display:flex;align-items:center;justify-content:space-between;gap:24px;max-width:1100px;margin:0 auto;width:100%;flex-wrap:wrap;}
.cookie-text{font-size:13px;color:rgba(255,255,255,0.7);line-height:1.6;max-width:680px;}
.cookie-actions{display:flex;gap:10px;flex-shrink:0;}
.cookie-btn{font-size:12px;letter-spacing:.04em;text-transform:uppercase;padding:10px 18px;border-radius:6px;cursor:pointer;border:1px solid rgba(255,255,255,0.15);background:transparent;color:rgba(255,255,255,0.7);transition:all .2s;}
.cookie-btn.accept{background:#00e5a0;color:#07090f;border-color:#00e5a0;}
@media(max-width:600px){.article-header,.article-body{padding-left:20px;padding-right:20px;}footer{padding:28px 20px;}}
</style>
</head>
<body>
<nav aria-label="Main navigation">
  <a href="https://strategicflow.tech/" class="nav-logo">Strategic<em>Flow</em></a>
  <div class="nav-links">
    <a href="https://strategicflow.tech/teardowns.html" class="nav-link">Teardowns</a>
    <a href="https://strategicflow.tech/glossary.html" class="nav-link">Glossary</a>
    <a href="https://strategicflow.tech/blog.html" class="nav-link active">Blog</a>
    <a href="https://strategic-flow-audit.replit.app" class="nav-link" target="_blank" rel="noopener">Free Audit</a>
    <a href="https://strategic-flow-pro.replit.app" class="nav-cta" target="_blank" rel="noopener">Rebuild Yours &rarr;</a>
  </div>
  <button class="hamburger" id="hamburger" aria-label="Toggle menu" aria-expanded="false"><span></span><span></span><span></span></button>
</nav>
<div class="mobile-menu" id="mobile-menu">
  <a href="https://strategicflow.tech/teardowns.html" class="mm-item">Teardowns</a>
  <a href="https://strategicflow.tech/glossary.html" class="mm-item">Glossary</a>
  <a href="https://strategicflow.tech/blog.html" class="mm-item" style="color:var(--green);">Blog</a>
  <a href="https://strategic-flow-audit.replit.app" class="mm-item" target="_blank" rel="noopener">Free Audit</a>
  <a href="https://strategic-flow-pro.replit.app" class="mm-cta" target="_blank" rel="noopener">Rebuild Yours &rarr;</a>
</div>
<script>(function(){var h=document.getElementById('hamburger'),m=document.getElementById('mobile-menu');if(!h||!m)return;function cl(){h.classList.remove('open');m.classList.remove('open');h.setAttribute('aria-expanded','false');}h.addEventListener('click',function(e){e.stopPropagation();m.classList.contains('open')?cl():(h.classList.add('open'),m.classList.add('open'),h.setAttribute('aria-expanded','true'));});m.querySelectorAll('a').forEach(function(a){a.addEventListener('click',cl);});document.addEventListener('click',function(e){if(!m.contains(e.target)&&!h.contains(e.target))cl();});})();</script>
<header class="article-header">
  <nav class="breadcrumb" aria-label="Breadcrumb">
    <a href="https://strategicflow.tech/">Strategic Flow</a>
    <span class="breadcrumb-sep">/</span>
    <a href="https://strategicflow.tech/blog.html">Blog</a>
    <span class="breadcrumb-sep">/</span>
    <span>${title}</span>
  </nav>
  <div class="article-tag">Email Architecture</div>
  <h1 class="article-h1">${title}</h1>
  <div class="article-meta-row">
    <span>By Alex Iliescu, founder of Strategic Flow Tech</span><span>&middot;</span>
    <span>${dateDisplay}</span><span>&middot;</span>
    <span>${mins} min read</span>
  </div>
</header>
<article class="article-body">
${content}
  <div class="article-cta">
    <div class="article-cta-label">Free tool</div>
    <p class="article-cta-title">Score your last email.</p>
    <p class="article-cta-sub">Paste any SaaS email. Get a structural score from 1 to 10, a named failure pattern, and a rebuilt version. Runs in 90 seconds.</p>
    <a href="https://strategic-flow-audit.replit.app" class="btn-p" target="_blank" rel="noopener">Run the free audit &rarr;</a>
  </div>
</article>
<footer>
  <div class="footer-links">
    <a href="https://strategicflow.tech/">Strategic Flow</a>
    <a href="https://strategicflow.tech/teardowns.html">Teardowns</a>
    <a href="https://strategicflow.tech/glossary.html">Glossary</a>
    <a href="https://strategicflow.tech/blog.html">Blog</a>
    <a href="https://strategic-flow-audit.replit.app" target="_blank" rel="noopener">Free Audit</a>
    <a href="https://strategic-flow-pro.replit.app" target="_blank" rel="noopener">Pro Plans</a>
  </div>
  <div class="footer-copy">Strategic Flow &copy; ${new Date().getFullYear()} &middot; <a href="https://strategicflow.tech" style="color:#1D9E75;text-decoration:none;">strategicflow.tech</a></div>
</footer>
<div id="cookie-banner">
  <div class="cookie-inner">
    <div class="cookie-text">This site uses cookies for analytics (Google Analytics). We do not sell or share your data.</div>
    <div class="cookie-actions">
      <button class="cookie-btn" id="cookie-decline">Decline</button>
      <button class="cookie-btn accept" id="cookie-accept">Accept</button>
    </div>
  </div>
</div>
<script>(function(){var K='sf_consent',s=localStorage.getItem(K),b=document.getElementById('cookie-banner');function g(){gtag('consent','update',{'ad_storage':'granted','ad_user_data':'granted','ad_personalization':'granted','analytics_storage':'granted'});}if(s==='granted'){g();}else if(s!=='denied'){b.classList.add('visible');}document.getElementById('cookie-accept').addEventListener('click',function(){localStorage.setItem(K,'granted');g();b.classList.remove('visible');});document.getElementById('cookie-decline').addEventListener('click',function(){localStorage.setItem(K,'denied');b.classList.remove('visible');});})();</script>
</body>
</html>`;
  }

  app.post('/distribb-publish', express.json({ limit: '2mb' }), async (req, res) => {
    const bearerToken = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    const secret = bearerToken
      || req.headers['x-api-key']
      || req.headers['x-make-apikey']
      || req.headers['x-distribb-secret']
      || req.body.secret;
    if (secret !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

    console.log('[distribb-publish] body keys:', Object.keys(req.body));
    console.log('[distribb-publish] body:', JSON.stringify(req.body).slice(0, 500));

    const b = req.body;
    const title   = b.title || b.article_title || b.post_title || b.name || '';
    const content = b.content || b.html || b.html_content || b.article_body || b.body || b.article_html || '';
    const rawSlug = b.slug || b.post_slug || b.url_slug || '';
    const meta_description = b.meta_description || b.description || b.excerpt || b.seo_description || '';
    const keyword  = b.keyword || b.focus_keyword || b.primary_keyword || b.tag || '';
    const date     = b.date || b.scheduled_date || b.publish_date || '';
    const read_time = b.read_time || b.reading_time || null;
    const excerpt  = b.excerpt || b.summary || meta_description || '';

    if (!title && !content) {
      console.log('[distribb-publish] test payload — returning 200');
      return res.json({ ok: true, message: 'Test payload received. Keys: ' + Object.keys(b).join(', ') });
    }

    const slug = rawSlug || toSlug(title);
    const filePath = `blog/${slug}.html`;
    const pageHtml = buildBlogPage({ title, content, slug, meta_description: meta_description || '', keyword: keyword || '', date, read_time });

    try {
      let existingSha = null;
      try { const ex = await ghGet(filePath); existingSha = ex.sha; } catch(e) {}

      await ghPut(filePath, pageHtml, existingSha, `Publish blog article via Distribb: ${title}`);

      const blogIndex = await ghGet('blog.html');
      const blogContent = Buffer.from(blogIndex.content, 'base64').toString();
      const today = date || new Date().toISOString().split('T')[0];
      const dateDisplay = new Date(today).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      const mins = read_time || Math.max(3, Math.round(content.replace(/<[^>]+>/g, '').split(/\s+/).length / 200));
      const desc = excerpt || (meta_description || '').slice(0, 160);

      const newCard = `    <a href="/blog/${slug}.html" class="article-card">
      <div class="article-meta">
        <span class="article-date">${dateDisplay}</span>
        <span class="article-read">${mins} min read</span>
        <span class="article-tag">Architecture</span>
      </div>
      <h2 class="article-title">${title}</h2>
      <p class="article-excerpt">${desc}</p>
      <span class="article-cta">Read article &rarr;</span>
    </a>\n\n    `;

      let updatedBlog = blogContent;
      if (blogContent.includes('<div class="article-card-placeholder">')) {
        updatedBlog = blogContent.replace('<div class="article-card-placeholder">', newCard + '<div class="article-card-placeholder">');
      }

      if (updatedBlog !== blogContent) {
        await ghPut('blog.html', updatedBlog, blogIndex.sha, `blog.html: add card for "${title}" (Distribb)`);
      }

      console.log(`[distribb-publish] OK: ${filePath}`);
      res.json({ ok: true, url: `https://strategicflow.tech/${filePath}`, slug, file: filePath });
    } catch (err) {
      console.error('[distribb-publish]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

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

const fs = require('fs');
const path = require('path');

const API_URL = 'https://strategic-flow-audit.replit.app/api/index/score';
const COMPANIES_PATH = path.join(__dirname, 'companies.json');
const RESULTS_PATH = path.join(__dirname, 'batch-results.json');
const DELAY_MS = 4000;
const FETCH_TIMEOUT_MS = 15000;
const MIN_TEXT_LENGTH = 400;
const MAX_CONTENT_LENGTH = 6000;

const ADMIN_KEY = process.env.INDEX_ADMIN_KEY;
if (!ADMIN_KEY) {
  console.error('FATAL: INDEX_ADMIN_KEY not set in environment.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const CHROME_PHRASES = [
  'skip to main content', 'contact support', 'log in', 'sign up',
  'cookie', 'privacy policy', 'all rights reserved'
];

function decodeEntities(str) {
  return str
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'").replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…').replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
    .replace(/&rdquo;/g, '”').replace(/&ldquo;/g, '“')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function extractMainContentHtml(html) {
  let stripped = String(html || '');
  stripped = stripped.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  stripped = stripped.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  stripped = stripped.replace(/<nav[\s\S]*?<\/nav>/gi, ' ');
  stripped = stripped.replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  stripped = stripped.replace(/<header[\s\S]*?<\/header>/gi, ' ');
  stripped = stripped.replace(/<aside[\s\S]*?<\/aside>/gi, ' ');

  const mainMatch = stripped.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch && mainMatch[1].replace(/<[^>]*>/g, '').trim().length > 200) {
    return mainMatch[1];
  }
  const articleMatch = stripped.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch && articleMatch[1].replace(/<[^>]*>/g, '').trim().length > 200) {
    return articleMatch[1];
  }

  const divMatches = [...stripped.matchAll(/<div[^>]*>([\s\S]*?)<\/div>/gi)];
  let best = null;
  let bestLen = 0;
  for (const m of divMatches) {
    const textLen = m[1].replace(/<[^>]*>/g, '').trim().length;
    if (textLen > bestLen) { bestLen = textLen; best = m[1]; }
  }
  if (best && bestLen > 200) return best;

  return stripped;
}

function extractReadableText(html) {
  let text = extractMainContentHtml(html);
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, MAX_CONTENT_LENGTH);
}

function isJunkHeavy(text) {
  const sample = text.slice(0, 1000).toLowerCase();
  let hits = 0;
  for (const phrase of CHROME_PHRASES) {
    if (sample.includes(phrase)) hits++;
  }
  return hits >= 3;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function scoreCompany(company) {
  const { name, domain, content_type, source_url } = company;

  let html;
  try {
    const resp = await fetchWithTimeout(source_url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StrategicFlowBot/1.0)' }
    }, FETCH_TIMEOUT_MS);
    if (!resp.ok) {
      return { type: 'failed', name, source_url, reason: `fetch_status_${resp.status}` };
    }
    html = await resp.text();
  } catch (err) {
    return { type: 'failed', name, source_url, reason: `fetch_error: ${err.message}` };
  }

  const content = extractReadableText(html);
  if (content.length < MIN_TEXT_LENGTH) {
    return { type: 'needs_manual', name, source_url, reason: `extracted_text_too_short (${content.length} chars)` };
  }
  if (isJunkHeavy(content)) {
    return { type: 'needs_manual', name, source_url, reason: 'junk_ratio_too_high' };
  }

  try {
    const resp = await fetchWithTimeout(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': ADMIN_KEY
      },
      body: JSON.stringify({ name, domain, content_type, content })
    }, FETCH_TIMEOUT_MS);

    const data = await resp.json().catch(() => ({}));

    if (resp.status === 200) {
      return { type: 'ok', name, source_url, score: data.score, url: data.url };
    }
    if (resp.status === 409) {
      return { type: 'skipped', name, source_url, reason: 'already_scored', existing: data.company };
    }
    if (resp.status === 422 && data.error === 'polluted_input') {
      return { type: 'needs_manual', name, source_url, reason: 'polluted_input (model-flagged)' };
    }
    return { type: 'failed', name, source_url, reason: `score_status_${resp.status}: ${data.error || 'unknown'}` };
  } catch (err) {
    return { type: 'failed', name, source_url, reason: `score_error: ${err.message}` };
  }
}

function parseIntArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find(a => a.startsWith(prefix));
  return arg ? parseInt(arg.slice(prefix.length), 10) : null;
}

async function main() {
  const pilotMode = process.argv.includes('--pilot');
  const startArg = parseIntArg('start');
  const countArg = parseIntArg('count');

  if (!fs.existsSync(COMPANIES_PATH)) {
    console.error(`FATAL: ${COMPANIES_PATH} not found.`);
    process.exit(1);
  }
  let companies = JSON.parse(fs.readFileSync(COMPANIES_PATH, 'utf8'));
  const offset = startArg || 0;

  if (pilotMode) {
    companies = companies.slice(0, 5);
    console.log(`[pilot mode] Running first ${companies.length} companies only.\n`);
  } else if (startArg !== null || countArg !== null) {
    companies = companies.slice(offset, countArg !== null ? offset + countArg : undefined);
    console.log(`Running batch slice: start=${offset} count=${companies.length}.\n`);
  } else {
    console.log(`Running full batch: ${companies.length} companies.\n`);
  }

  const results = { ok: [], skipped: [], failed: [], needs_manual: [] };

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];
    const label = `[${offset + i + 1}/${offset + companies.length}] ${company.name}`;

    const result = await scoreCompany(company);

    switch (result.type) {
      case 'ok':
        console.log(`${label} OK ${result.score} ${result.url}`);
        results.ok.push(result);
        break;
      case 'skipped':
        console.log(`${label} SKIPPED (already scored)`);
        results.skipped.push(result);
        break;
      case 'needs_manual':
        console.log(`${label} NEEDS_MANUAL ${result.name} ${result.source_url}`);
        results.needs_manual.push(result);
        break;
      case 'failed':
      default:
        console.log(`${label} FAILED ${result.reason}`);
        results.failed.push(result);
        break;
    }

    if (i < companies.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  let merged = results;
  if ((startArg !== null || countArg !== null) && fs.existsSync(RESULTS_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
      merged = {
        ok: [...(prev.ok || []), ...results.ok],
        skipped: [...(prev.skipped || []), ...results.skipped],
        failed: [...(prev.failed || []), ...results.failed],
        needs_manual: [...(prev.needs_manual || []), ...results.needs_manual]
      };
    } catch (e) {
      console.error('Warning: could not merge with previous results, overwriting.', e.message);
    }
  }

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(merged, null, 2));
  console.log(`\nDone. ok=${results.ok.length} skipped=${results.skipped.length} failed=${results.failed.length} needs_manual=${results.needs_manual.length}`);
  console.log(`Results written to ${RESULTS_PATH}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

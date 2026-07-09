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

function extractReadableText(html) {
  let text = String(html || '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, ' ');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, ' ');
  text = text.replace(/<[^>]*>/g, ' ');
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, MAX_CONTENT_LENGTH);
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
    return { type: 'failed', name, source_url, reason: `score_status_${resp.status}: ${data.error || 'unknown'}` };
  } catch (err) {
    return { type: 'failed', name, source_url, reason: `score_error: ${err.message}` };
  }
}

async function main() {
  const pilotMode = process.argv.includes('--pilot');

  if (!fs.existsSync(COMPANIES_PATH)) {
    console.error(`FATAL: ${COMPANIES_PATH} not found.`);
    process.exit(1);
  }
  let companies = JSON.parse(fs.readFileSync(COMPANIES_PATH, 'utf8'));

  if (pilotMode) {
    companies = companies.slice(0, 5);
    console.log(`[pilot mode] Running first ${companies.length} companies only.\n`);
  } else {
    console.log(`Running full batch: ${companies.length} companies.\n`);
  }

  const results = { ok: [], skipped: [], failed: [], needs_manual: [] };

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];
    const label = `[${i + 1}/${companies.length}] ${company.name}`;

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

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log(`\nDone. ok=${results.ok.length} skipped=${results.skipped.length} failed=${results.failed.length} needs_manual=${results.needs_manual.length}`);
  console.log(`Results written to ${RESULTS_PATH}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

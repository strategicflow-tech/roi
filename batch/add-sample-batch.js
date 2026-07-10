const { execFile } = require('child_process');

const API_URL = 'https://strategic-flow-audit.replit.app/api/index/add-sample';
const DELAY_MS = 4000;
const FETCH_TIMEOUT_MS = 15000;
const SCORE_TIMEOUT_MS = 60000;
const MIN_TEXT_LENGTH = 1000;
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

function stripFilterChrome(text) {
  const markers = ['Latest Posts', 'Latest posts', 'Recent Posts', 'Recent posts', 'Latest articles', 'Trending topics'];
  for (const marker of markers) {
    const idx = text.indexOf(marker);
    if (idx > 0 && idx < text.length * 0.6) {
      return text.slice(idx + marker.length);
    }
  }
  text = text.replace(/Use this dropdown to filter[\s\S]*?desktop tag list below\.\s*/gi, '');
  text = text.replace(/(?:[A-Za-z][A-Za-z .]{1,30}\(\d+\)\s*){4,}/g, '');
  return text;
}

function truncateAtSentenceBoundary(text, maxLength) {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastBoundary = cut.lastIndexOf('. ');
  if (lastBoundary > maxLength * 0.5) {
    return cut.slice(0, lastBoundary + 1);
  }
  return cut;
}

function extractReadableText(html) {
  let text = extractMainContentHtml(html);
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/\s+/g, ' ').trim();
  text = stripFilterChrome(text).trim();
  return truncateAtSentenceBoundary(text, MAX_CONTENT_LENGTH);
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
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

function fetchViaCurl(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('curl', [
      '-sL', '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '-A', 'Mozilla/5.0 (compatible; StrategicFlowBot/1.0)',
      url
    ], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function fetchOne(url) {
  let html;
  let fetchMethod = 'fetch';
  try {
    const resp = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StrategicFlowBot/1.0)' }
    }, FETCH_TIMEOUT_MS);
    if (!resp.ok) {
      throw new Error(`fetch_status_${resp.status}`);
    }
    html = await resp.text();
  } catch (err) {
    html = await fetchViaCurl(url, FETCH_TIMEOUT_MS);
    fetchMethod = 'curl';
  }
  return { html, fetchMethod };
}

async function attemptCompany(company) {
  const { slug, name, content_type, urls } = company;

  let lastReason = null;
  for (const url of urls) {
    try {
      const { html, fetchMethod } = await fetchOne(url);
      const content = extractReadableText(html);

      if (content.length < MIN_TEXT_LENGTH) {
        lastReason = `extracted_text_too_short (${content.length} chars) @ ${url}`;
        continue;
      }
      if (isJunkHeavy(content)) {
        lastReason = `junk_ratio_too_high @ ${url}`;
        continue;
      }

      const resp = await fetchWithTimeout(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': ADMIN_KEY
        },
        body: JSON.stringify({ slug, content_type, content, source_url: url })
      }, SCORE_TIMEOUT_MS);

      const data = await resp.json().catch(() => ({}));

      if (resp.status === 200) {
        return { type: 'ok', name, url, fetchMethod, ...data };
      }
      if (resp.status === 422 && data.error === 'polluted_input') {
        lastReason = `polluted_input (model-flagged) @ ${url}`;
        continue;
      }
      lastReason = `add_sample_status_${resp.status}: ${data.error || 'unknown'} @ ${url}`;
    } catch (err) {
      lastReason = `error: ${err.message} @ ${url}`;
    }
  }
  return { type: 'failed', name, reason: lastReason || 'no_candidate_urls' };
}

const COMPANIES = [
  {
    slug: 'chowly', name: 'Chowly', content_type: 'product_update_blog',
    urls: []
  },
  {
    slug: 'stripe', name: 'Stripe', content_type: 'landing_page',
    urls: ['https://stripe.com']
  },
  {
    slug: 'slack', name: 'Slack', content_type: 'product_update_blog',
    urls: ['https://slack.com/blog/news/slack-feature-drop-june2026', 'https://slack.com/blog/news/feature-drop-may2026']
  },
  {
    slug: 'hubspot', name: 'HubSpot', content_type: 'landing_page',
    urls: ['https://www.hubspot.com']
  },
  {
    slug: 'notion', name: 'Notion', content_type: 'product_update_blog',
    urls: ['https://www.notion.com/releases', 'https://www.notion.so/releases']
  },
  {
    slug: 'linear', name: 'Linear', content_type: 'landing_page',
    urls: ['https://linear.app']
  },
  {
    slug: 'klaviyo', name: 'Klaviyo', content_type: 'changelog',
    urls: ['https://developers.klaviyo.com/en/docs/changelog_', 'https://www.klaviyo.com/whats-new']
  },
  {
    slug: 'mixpanel', name: 'Mixpanel', content_type: 'product_update_blog',
    urls: ['https://mixpanel.com/blog/how-to-plan-b2b-product-rollouts-metrics-analytics/']
  },
  {
    slug: 'semrush', name: 'Semrush', content_type: 'product_update_blog',
    urls: ['https://www.semrush.com/blog/ai-search-with-semrush-one/', 'https://www.semrush.com/blog/agentic-search-optimization-with-semrush/']
  },
  {
    slug: 'circle', name: 'Circle', content_type: 'product_update_blog',
    urls: ['https://circle.so/blog/ai-native-community-platform']
  }
];

function parseOnlyArg() {
  const prefix = '--only=';
  const arg = process.argv.find(a => a.startsWith(prefix));
  if (!arg) return null;
  return arg.slice(prefix.length).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

async function main() {
  const onlyArg = parseOnlyArg();
  const companies = onlyArg ? COMPANIES.filter(c => onlyArg.includes(c.slug.toLowerCase())) : COMPANIES;

  const report = [];
  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];
    const label = `[${i + 1}/${companies.length}] ${company.name}`;

    if (!company.urls.length) {
      console.log(`${label} SKIPPED — no candidate URL found for ${company.content_type}`);
      report.push({ company: company.name, ok: false, reason: 'no_public_page_found_for_content_type' });
    } else {
      const result = await attemptCompany(company);
      if (result.type === 'ok') {
        console.log(`${label} OK score=${result.new_sample_score ?? result.sample_added?.score} avg=${result.new_average_score} count=${result.sample_count} (${result.fetchMethod})`);
        report.push({
          company: company.name,
          ok: true,
          content_type: company.content_type,
          sample_score: result.sample_added?.score,
          new_average_score: result.new_average_score,
          sample_count: result.sample_count
        });
      } else {
        console.log(`${label} FAILED ${result.reason}`);
        report.push({ company: company.name, ok: false, reason: result.reason });
      }
    }

    if (i < COMPANIES.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  console.log('\n=== FINAL REPORT ===');
  console.log(JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

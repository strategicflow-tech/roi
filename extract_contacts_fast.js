// Fast parallel contact extractor — 5 concurrent, 5s timeout, 2 pages per listing
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const fs = require('fs');
const LOG = '/tmp/extract_r2.log';
fs.writeFileSync(LOG, '');
const log = m => { fs.appendFileSync(LOG, m + '\n'); };

const EMAIL_RE = /\b([a-zA-Z0-9._%+\-]{1,40}@[a-zA-Z0-9.\-]{1,60}\.[a-zA-Z]{2,10})\b/g;
const SKIP_LOCAL  = /^(noreply|no-reply|donotreply|mailer-daemon|bounce|postmaster|unsubscribe|privacy@example|test|user|name|someone|your)/i;
const SKIP_DOMAIN = /example\.|test\.|placeholder\.|sentry\.|mailchimp\.com|sendgrid\.net|amazonaws\.com|wixpress\.com|squarespace\.com/i;

const timedFetch = (u) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  return fetch(u, {
    signal: ctrl.signal, redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ToolIndex/1.0; +https://strategic-flow-audit.replit.app/directory)' }
  }).finally(() => clearTimeout(t));
};

function clean(h) { return h.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,''); }

function extractEmail(html) {
  const mailtos = [...html.matchAll(/href=["']mailto:([^"'?\s]{3,80})["']/gi)]
    .map(m => m[1].split('?')[0].toLowerCase().trim())
    .filter(e => /^[^@]{1,40}@[^@]{1,60}\.[a-z]{2,10}$/.test(e) && !SKIP_LOCAL.test(e) && !SKIP_DOMAIN.test(e));
  if (mailtos.length) return mailtos[0];
  const text = clean(html);
  const ctxM = [...text.matchAll(/(?:contact\s+us|email\s+us|reach\s+us|get\s+in\s+touch|hello@|hi@|support@|team@)[\s\S]{0,300}/gi)];
  for (const m of ctxM) {
    const em = [...m[0].matchAll(EMAIL_RE)].map(e=>e[1].toLowerCase()).filter(e=>!SKIP_LOCAL.test(e)&&!SKIP_DOMAIN.test(e));
    if (em.length) return em[0];
  }
  const footer = text.match(/<footer[\s\S]{0,6000}/i)?.[0] || text.slice(-4000);
  const fe = [...footer.matchAll(EMAIL_RE)].map(e=>e[1].toLowerCase()).filter(e=>!SKIP_LOCAL.test(e)&&!SKIP_DOMAIN.test(e));
  return fe[0] || null;
}

function extractLinkedIn(html) {
  const m = [...html.matchAll(/https?:\/\/(?:www\.)?linkedin\.com\/(in|company)\/([a-zA-Z0-9_%-]{2,80})\/?/g)];
  if (!m.length) return null;
  const p = m.find(x => x[1]==='in') || m[0];
  return `https://www.linkedin.com/${p[1]}/${p[2]}/`;
}

async function processOne(listing) {
  let base;
  try { base = new URL(listing.url).origin; } catch { return { status:'invalid' }; }
  // Only check homepage + /contact — fastest signal, covers 80%+ of cases
  const pages = [listing.url, `${base}/contact`, `${base}/about`];
  let email = null, li = null, src = null;
  for (const page of pages) {
    try {
      const r = await timedFetch(page);
      if (!r || !r.ok) continue;
      const html = await r.text().catch(() => '');
      if (!email) { email = extractEmail(html); if (email) src = page; }
      if (!li) li = extractLinkedIn(html);
      if (email && li) break;
    } catch {}
  }
  if (email) return { email, linkedin: li, source: src, status: 'found' };
  if (li)    return { linkedin: li, status: 'not_found' };
  return { status: 'not_found' };
}

async function saveResult(id, result) {
  const liUpdate = result.linkedin ? `, social_linkedin = COALESCE(NULLIF(social_linkedin,''), $5)` : '';
  await pool.query(
    `UPDATE directory_listings SET contact_email=$1, contact_email_status=$2,
     contact_email_source=$3, contact_email_fetched_at=NOW() ${liUpdate} WHERE id=$4`,
    result.linkedin
      ? [result.email||null, result.status, result.source||null, id, result.linkedin]
      : [result.email||null, result.status, result.source||null, id]
  );
}

const CONCURRENCY = 15;

async function runBatch(rows) {
  let i = 0;
  let found = 0, li_found = 0, not_found = 0, errors = 0;
  const total = rows.length;

  async function worker() {
    while (i < total) {
      const listing = rows[i++];
      try {
        const result = await processOne(listing);
        await saveResult(listing.id, result);
        if (result.status === 'found') found++;
        else not_found++;
        if (result.linkedin) li_found++;
        log(`[${found+not_found+errors}/${total}] id=${listing.id} ${listing.name.slice(0,30)} → ${result.status}${result.email?' e:'+result.email:''}${result.linkedin?' li:'+result.linkedin.replace('https://www.linkedin.com/',''):''}`);
      } catch(e) {
        errors++;
        try { await pool.query(`UPDATE directory_listings SET contact_email_status='not_found', contact_email_fetched_at=NOW() WHERE id=$1`, [listing.id]); } catch {}
        log(`[ERR] id=${listing.id} ${listing.name.slice(0,30)}: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { found, li_found, not_found, errors };
}

(async () => {
  const { rows } = await pool.query(`
    SELECT id, name, url FROM directory_listings
    WHERE status='active'
      AND (contact_email_status IS NULL OR contact_email_status='pending')
    ORDER BY id
  `);
  log(`Starting parallel extraction: ${rows.length} listings, ${CONCURRENCY} concurrent`);
  const stats = await runBatch(rows);
  log(`\n=== DONE ===`);
  log(`Email found: ${stats.found} | LinkedIn found: ${stats.li_found} | Not found: ${stats.not_found} | Errors: ${stats.errors}`);

  // Final DB summary
  const { rows: summary } = await pool.query(`
    SELECT contact_email_status, COUNT(*)::int n
    FROM directory_listings WHERE status='active'
    GROUP BY contact_email_status ORDER BY n DESC
  `);
  log('\n=== DB SUMMARY ===');
  summary.forEach(r => log(`  ${r.contact_email_status||'pending'}: ${r.n}`));
  await pool.end();
})().catch(e => { log('FATAL: '+e.message); process.exit(1); });

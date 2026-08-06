'use strict';
/**
 * scripts/backfill-logos.js
 * Task #23 — Fetch real logos for listings that only have a Google favicon fallback or no logo.
 * Runs as a background job; logs progress to stdout.
 *
 * Usage: node scripts/backfill-logos.js
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

const HERO_PAT = [
  /og[-_]?image/i, /opengraph/i, /screenshot/i,
  /social[-_]?(?:preview|share)/i, /twitter[-_]?card/i,
  /banner/i, /\/hero[/_.]/i, /placeholder/i, /noimage/i,
];

const CDN_EXACT = new Set([
  's3.amazonaws.com','cloudfront.net','cloudinary.com','imgix.net',
  'imagekit.io','res.cloudinary.com','cdn.shopify.com','assets.vercel.com',
  'cdn.prod.website-files.com','uploads.linear.app','logo.clearbit.com',
]);

function isTrustedHost(candidateHost, baseHost) {
  if (candidateHost === baseHost) return true;
  if (baseHost.endsWith('.' + candidateHost) || candidateHost.endsWith('.' + baseHost)) return true;
  const parts = candidateHost.split('.');
  const baseParts = baseHost.split('.');
  if (parts.slice(-2).join('.') === baseParts.slice(-2).join('.')) return true;
  for (const cdn of CDN_EXACT) {
    if (candidateHost === cdn || candidateHost.endsWith('.' + cdn)) return true;
  }
  return false;
}

function validateLogo(candidate, domain) {
  if (!candidate) return false;
  if (HERO_PAT.some(re => re.test(candidate))) return false;
  try {
    const host = new URL(candidate).hostname.replace(/^www\./, '');
    return isTrustedHost(host, domain);
  } catch { return false; }
}

async function timedFetch(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ToolIndex-LogoFetcher/1.0)' },
    });
  } finally { clearTimeout(t); }
}

async function fetchBetterLogo(siteUrl) {
  let base, domain;
  try {
    const parsed = new URL(siteUrl);
    base = parsed.origin;
    domain = parsed.hostname.replace(/^www\./, '');
  } catch { return null; }

  // 1. Try apple-touch-icon
  try {
    const r = await timedFetch(`${base}/apple-touch-icon.png`, 5000);
    if (r.ok && r.headers.get('content-type')?.startsWith('image')) return `${base}/apple-touch-icon.png`;
  } catch {}

  // 2. Parse <head> for best icon/og:image
  try {
    const r = await timedFetch(siteUrl, 8000);
    if (r.ok) {
      const html = (await r.text()).slice(0, 30000);
      const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                   || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      if (ogMatch) {
        const candidate = new URL(ogMatch[1], base).href;
        if (validateLogo(candidate, domain)) return candidate;
      }

      // link rel icon (png/svg/webp preferred)
      const iconRe = /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>/gi;
      let m;
      while ((m = iconRe.exec(html)) !== null) {
        const candidate = new URL(m[1], base).href;
        if (/\.(png|svg|webp)(\?|$)/i.test(candidate) && !HERO_PAT.some(re => re.test(candidate))) {
          return candidate;
        }
      }
    }
  } catch {}

  // 3. favicon.ico
  try {
    const r = await timedFetch(`${base}/favicon.ico`, 5000);
    if (r.ok) return `${base}/favicon.ico`;
  } catch {}

  // 4. Clearbit fallback
  return `https://logo.clearbit.com/${domain}?size=128`;
}

async function main() {
  console.log('[backfill-logos] Starting Task #23 — Backfill real logos');
  console.log('[backfill-logos] Start time:', new Date().toISOString());

  const { rows } = await pool.query(`
    SELECT id, name, url, image_url
    FROM directory_listings
    WHERE status = 'active'
      AND (
        image_url IS NULL
        OR image_url = ''
        OR image_url LIKE '%google.com/s2/favicons%'
      )
    ORDER BY vote_count DESC, id ASC
  `);

  console.log(`[backfill-logos] Found ${rows.length} listings to process`);
  const stats = { total: rows.length, upgraded: 0, skipped: 0, failed: 0 };

  for (let i = 0; i < rows.length; i++) {
    const listing = rows[i];
    const pct = Math.round(((i + 1) / rows.length) * 100);
    process.stdout.write(`[${pct}%] (${i + 1}/${rows.length}) ${listing.name} (id:${listing.id}) → `);

    try {
      const logo = await fetchBetterLogo(listing.url);
      if (!logo) {
        console.log('no logo found');
        stats.skipped++;
      } else {
        await pool.query('UPDATE directory_listings SET image_url=$1 WHERE id=$2', [logo, listing.id]);
        console.log(logo.slice(0, 80));
        stats.upgraded++;
      }
    } catch (e) {
      console.log(`ERR: ${e.message.slice(0, 60)}`);
      stats.failed++;
    }

    await sleep(2000);
  }

  console.log('\n[backfill-logos] ✅ Done!');
  console.log('[backfill-logos] End time:', new Date().toISOString());
  console.log('[backfill-logos] Stats:', JSON.stringify(stats, null, 2));

  await pool.end();
}

main().catch(e => {
  console.error('[backfill-logos] Fatal:', e.message);
  process.exit(1);
});

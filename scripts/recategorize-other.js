'use strict';
/**
 * scripts/recategorize-other.js
 * Task #114 — Re-categorize all "Other" listings into proper named categories.
 * Runs overnight as a background job; logs progress to stdout.
 *
 * Usage: node scripts/recategorize-other.js
 */

const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VALID_CATEGORIES = [
  'AI Tools', 'Developer Tools', 'Design', 'Productivity', 'Marketing',
  'Social Media', 'Analytics', 'Finance', 'Sales', 'Education',
  'No-Code', 'Directories', 'HR & Recruiting', 'General',
];

// Delay helper
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function classifyListing(listing) {
  const prompt = `You are classifying software products for a SaaS directory.

Product name: ${listing.name}
URL: ${listing.url}
Description: ${(listing.description || '').slice(0, 400)}

Pick the SINGLE best category from this exact list:
${VALID_CATEGORIES.join(', ')}

Rules:
- If it's an AI product (uses AI/ML as core feature): "AI Tools"
- If it's for developers (APIs, SDKs, dev infrastructure): "Developer Tools"
- If it's design/visual/UI tools: "Design"
- If it's task/project/time management: "Productivity"
- If it's marketing/SEO/ads/email marketing: "Marketing"
- If it's social media management/scheduling: "Social Media"
- If it's data/tracking/reporting: "Analytics"
- If it's finance/accounting/payments: "Finance"
- If it's CRM/lead gen/outreach: "Sales"
- If it's learning/courses/training: "Education"
- If it's a no-code/low-code builder: "No-Code"
- If it's a directory/listing site: "Directories"
- If it's HR/recruiting/hiring: "HR & Recruiting"
- Use "General" only if none of the above fits

Respond with ONLY the category name — no quotes, no explanation, nothing else.`;

  try {
    const msg = await claude.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 20,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = (msg.content[0]?.text || '').trim().replace(/['"]/g, '');
    return VALID_CATEGORIES.includes(text) ? text : 'General';
  } catch (e) {
    console.error(`[classify] Error for ${listing.id}: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log('[recategorize] Starting Task #114 — Re-categorize "Other" listings');
  console.log('[recategorize] Start time:', new Date().toISOString());

  const { rows } = await pool.query(`
    SELECT id, name, url, description
    FROM directory_listings
    WHERE status = 'active' AND category = 'Other'
    ORDER BY vote_count DESC, id ASC
  `);

  console.log(`[recategorize] Found ${rows.length} listings to re-categorize`);

  const stats = { total: rows.length, updated: 0, failed: 0, byCategory: {} };

  for (let i = 0; i < rows.length; i++) {
    const listing = rows[i];
    const pct = Math.round(((i + 1) / rows.length) * 100);
    process.stdout.write(`[${pct}%] (${i + 1}/${rows.length}) ${listing.name} (id:${listing.id}) → `);

    const category = await classifyListing(listing);

    if (!category) {
      console.log('FAILED');
      stats.failed++;
      await sleep(3000);
      continue;
    }

    try {
      await pool.query(
        `UPDATE directory_listings SET category = $1 WHERE id = $2`,
        [category, listing.id]
      );
      console.log(category);
      stats.updated++;
      stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
    } catch (e) {
      console.log(`DB_ERROR: ${e.message}`);
      stats.failed++;
    }

    // Rate limit: ~15 listings/min (4s between calls)
    await sleep(4000);
  }

  console.log('\n[recategorize] ✅ Done!');
  console.log('[recategorize] End time:', new Date().toISOString());
  console.log('[recategorize] Stats:', JSON.stringify(stats, null, 2));

  await pool.end();
}

main().catch(e => {
  console.error('[recategorize] Fatal:', e.message);
  process.exit(1);
});

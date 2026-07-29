#!/usr/bin/env node
// ga-query.js — CLI tool for quick GA4 queries
//
// Usage:
//   node ga-query.js                                          # site-wide top pages today
//   node ga-query.js /landing-architecture-layer.html         # specific page, today
//   node ga-query.js /landing-architecture-layer.html today today
//   node ga-query.js /notes.html 7daysAgo today
//   node ga-query.js /teardowns.html 2026-07-01 2026-07-29
//   node ga-query.js --top 20 7daysAgo today                 # top 20 pages, last 7 days

'use strict';

require('dotenv').config(); // no-op if dotenv not installed; secrets come from env

const { queryPageViews, topPages } = require('./ga4');

async function main() {
  const args = process.argv.slice(2);

  // --top [n] [startDate] [endDate]
  if (args[0] === '--top') {
    const limit  = Number(args[1]) || 20;
    const start  = args[2] || 'today';
    const end    = args[3] || start;
    console.log(`\nTop ${limit} pages — ${start} → ${end}\n`);
    const rows = await topPages({ startDate: start, endDate: end, limit });
    if (!rows.length) { console.log('No data returned.'); return; }
    console.log('Views  Sessions  Users  Path');
    console.log('─────  ────────  ─────  ────');
    rows.forEach(r =>
      console.log(
        String(r.screenPageViews).padStart(5), ' ',
        String(r.sessions).padStart(8), ' ',
        String(r.totalUsers).padStart(5), ' ',
        r.pagePath
      )
    );
    return;
  }

  // [pagePath] [startDate] [endDate]
  const pagePath  = args[0] || null;
  const startDate = args[1] || 'today';
  const endDate   = args[2] || startDate;

  if (pagePath) {
    console.log(`\nPage: ${pagePath}  |  ${startDate} → ${endDate}\n`);
    const { summary, rows } = await queryPageViews({ pagePath, startDate, endDate });
    if (!rows.length) {
      console.log('No data found for this path in the given date range.');
      console.log('(Check that the path is exact and the date range is correct.)');
    } else {
      const r = rows[0];
      console.log(`  Page views : ${r.screenPageViews}`);
      console.log(`  Sessions   : ${r.sessions}`);
      console.log(`  Users      : ${r.totalUsers}`);
    }
  } else {
    console.log(`\nSite-wide summary — ${startDate} → ${endDate}\n`);
    const rows = await topPages({ startDate, endDate, limit: 20 });
    if (!rows.length) { console.log('No data returned.'); return; }
    console.log('Views  Sessions  Users  Path');
    console.log('─────  ────────  ─────  ────');
    rows.forEach(r =>
      console.log(
        String(r.screenPageViews).padStart(5), ' ',
        String(r.sessions).padStart(8), ' ',
        String(r.totalUsers).padStart(5), ' ',
        r.pagePath
      )
    );
  }
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  if (err.message.includes('GA4_')) {
    console.error('   → Add the missing secret in Replit Secrets and restart the shell.\n');
  }
  process.exit(1);
});

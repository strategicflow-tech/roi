'use strict';

// Focused contract checks for the Founder Pack enhancement. These intentionally
// avoid starting the application or calling Stripe/Resend/Claude.
const assert = require('node:assert/strict');
const fs = require('node:fs');

const server = fs.readFileSync('server.js', 'utf8');
const directory = fs.readFileSync('public/directory.html', 'utf8');

const founderCardStart = directory.indexOf('<!-- Founder Pack -->');
const founderCardEnd = directory.indexOf('<!-- Verified Founder Badge -->');
assert.ok(founderCardStart >= 0 && founderCardEnd > founderCardStart, 'Founder Pack card exists');
const founderCard = directory.slice(founderCardStart, founderCardEnd);

for (const benefit of [
  '30-day Premium visibility',
  'Unlimited relaunches',
  'Priority logo placement in the brand carousel',
  'Listing Health Checks',
  'Relaunch Kit',
  'Verified Listing History',
]) {
  assert.match(founderCard, new RegExp(benefit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `card includes ${benefit}`);
}
assert.match(founderCard, /<div class="dir-lu-price">\$49<\/div>/, 'Founder Pack remains $49');
assert.match(server, /founder_pack:\s+\{\s*price_id:\s*'price_1U03OiDpTwoDeZJnG3owPeBt',\s*days:\s*30,\s*label:\s*'Founder Pack',\s*amount:\s*49/);

for (const table of [
  'directory_site_snapshots',
  'directory_health_checks',
  'directory_listing_revisions',
  'directory_relaunch_drafts',
]) {
  assert.match(server, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} is initialized`);
}

assert.match(server, /fetchPageContent\(listing\.url\)/, 'health checks reuse the existing page parser');
assert.match(server, /ON CONFLICT \(listing_id, check_key\) DO NOTHING/, 'weekly checks are idempotently reserved');
assert.match(server, /material_change=FALSE,\s*changes='\[\]'::jsonb/, 'failed checks cannot claim a material change');
assert.match(server, /AND is_verified=TRUE[\s\S]{0,120}ORDER BY captured_at DESC/, 'comparisons use verified snapshots');
assert.match(server, /cron\.schedule\('0 4 \* \* 0'.*runFounderPackHealthChecks/s, 'weekly health worker is scheduled');
assert.match(server, /setTimeout\(resolve, 750\)/, 'health checks are paced between listings');

assert.match(server, /app\.get\('\/api\/directory\/claim\/history\/:id'/, 'history endpoint exists');
assert.match(server, /app\.post\('\/api\/directory\/claim\/relaunch-draft'/, 'draft save endpoint exists');
assert.match(server, /authorizeDirectoryClaim\(req, listingId/, 'draft/history routes use owner authorization');
assert.match(server, /lower\(owner_email\)=lower\(\$2\)/, 'history queries are owner scoped');
assert.match(server, /lower\(owner_email\)=lower\(\$4\)/, 'draft updates are owner scoped');
assert.match(server, /setImmediate\(\(\) => generateFounderPackRelaunchDraft/, 'draft generation cannot block relaunch response');
assert.match(server, /_skipGlobalCooldown: true/, 'material health alerts use operational email handling');

const relaunchHelper = server.slice(server.indexOf('async function generateFounderPackRelaunchDraft'), server.indexOf('async function sendFounderPackHealthAlert'));
assert.doesNotMatch(relaunchHelper, /producthunt|product hunt|linkedin|twitter|cms|publish/i, 'relaunch kit does not auto-post externally');

for (const control of [
  'claimRelaunchDraft',
  'saveClaimRelaunchDraft',
  'copyClaimRelaunchDraft',
  'claimFounderPackTools',
  'loadClaimHistory',
]) {
  assert.match(directory, new RegExp(control), `owner UI includes ${control}`);
}

console.log('Founder Pack contract checks passed.');
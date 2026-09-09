'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('server.js', 'utf8');
const wrapperStart = source.indexOf('resend.emails.send = async function patchedSend');
const wrapperEnd = source.indexOf('\n  };\n}', wrapperStart);
const wrapper = source.slice(wrapperStart, wrapperEnd);

test('every provider send is behind the read-only email dry-run', () => {
  assert.ok(wrapperStart >= 0, 'global Resend wrapper must exist');
  assert.ok(wrapper.includes('runEmailSendDryRun'), 'send wrapper must invoke the dry-run');
  assert.ok(
    wrapper.indexOf('runEmailSendDryRun') < wrapper.indexOf('_origSend(formattedParams)'),
    'dry-run must happen before the provider call'
  );
});

test('dry-run enforces layout and marketing unsubscribe invariants', () => {
  const dryRunStart = source.indexOf('async function runEmailSendDryRun');
  const dryRunEnd = source.indexOf('\n}\n\n// ── Global 24-hour email cooldown', dryRunStart);
  const dryRun = source.slice(dryRunStart, dryRunEnd);
  assert.match(dryRun, /readable_layout_missing/);
  assert.match(dryRun, /marketing_unsubscribe_footer_missing/);
  assert.match(dryRun, /isUnsubscribed\(to\)/);
  assert.match(dryRun, /wasEmailedRecently\(to\)/);
});

test('manual draft claim remains protected by its page preflight', () => {
  const runnerStart = source.indexOf('async function runManualDraftClaimCampaign');
  const runnerEnd = source.indexOf('\nfunction scheduleManualDraftClaimJob', runnerStart);
  const runner = source.slice(runnerStart, runnerEnd);
  assert.ok(runner.indexOf('safeFetchPublicUrl') < runner.indexOf('sendClaimOutreachForListing'));
});
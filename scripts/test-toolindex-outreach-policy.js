'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isBlockedOutreachTarget,
  isJunkEmail,
  toolindexFoundersSkipReason,
} = require('../outreach-policy');

test('blocks placeholder and junk addresses before any send', () => {
  for (const email of [
    'you@email.com',
    'you@company.com',
    'press@example.com',
    'privacy@example.com',
    'mailer-daemon@example.com',
    'contact@asset.png',
    'heroku-abuse@example.com',
  ]) {
    assert.equal(isJunkEmail(email), true, email);
  }
});

test('blocks large-company and permanent outreach targets', () => {
  assert.match(
    isBlockedOutreachTarget('Postman', 'info@postman.com').reason,
    /large\/established company/
  );
  assert.match(
    isBlockedOutreachTarget('Suno Studio 2.0', 'support@suno.com').reason,
    /permanent do-not-contact/
  );
  assert.match(
    isBlockedOutreachTarget('Any Product', 'service@example.com').reason,
    /restricted email prefix/
  );
});

test('combines both policy layers for the ToolIndex-founders runner', () => {
  assert.equal(toolindexFoundersSkipReason('FastMCP', 'you@email.com'), 'junk_email');
  assert.match(
    toolindexFoundersSkipReason('Runway', 'hello@runwayml.com'),
    /large\/established company/
  );
  assert.equal(toolindexFoundersSkipReason('Small Founder Tool', 'hello@example.com'), null);
});

test('keeps approved founder-facing role inboxes eligible', () => {
  for (const prefix of [
    'support',
    'hello',
    'info',
    'contact',
    'care',
    'team',
    'dev-support',
    'admin',
  ]) {
    assert.equal(
      toolindexFoundersSkipReason('Small Founder Tool', `${prefix}@example.com`),
      null,
      `${prefix}@example.com should remain eligible`
    );
  }
});

test('uses whole-word matching instead of blocking unrelated product names', () => {
  assert.equal(toolindexFoundersSkipReason('Notionary', 'hello@example.com'), null);
  assert.match(
    toolindexFoundersSkipReason('Any AI for Notion', 'hello@example.com'),
    /large\/established company/
  );
});
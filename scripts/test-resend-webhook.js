'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fetch = require('node-fetch');

const signingSecret = String(process.env.RESEND_WEBHOOK_SECRET || '').trim();
assert(signingSecret, 'RESEND_WEBHOOK_SECRET is required');

const endpoint = process.env.WEBHOOK_TEST_URL ||
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}/webhooks/resend`
    : `http://127.0.0.1:${process.env.PORT || 3000}/webhooks/resend`);

function signatureFor(id, timestamp, body) {
  const encodedSecret = signingSecret.startsWith('whsec_')
    ? signingSecret.slice('whsec_'.length)
    : signingSecret;
  return crypto
    .createHmac('sha256', Buffer.from(encodedSecret, 'base64'))
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
}

async function send({ id, timestamp, body, signature }) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': String(timestamp),
      'svix-signature': `v1,${signature}`
    },
    body
  });
  const responseBody = await response.text();
  return { status: response.status, body: responseBody };
}

async function main() {
  const unique = `${Date.now()}-${process.pid}`;
  const id = `msg_resend_delivery_test_${unique}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    type: 'email.delivered',
    created_at: new Date().toISOString(),
    data: {
      email_id: `email-delivered-test-${unique}`,
      to: ['webhook-test@example.com'],
      subject: 'Resend webhook integration test'
    }
  });
  const signature = signatureFor(id, timestamp, body);

  const first = await send({ id, timestamp, body, signature });
  assert.strictEqual(first.status, 200, `valid delivery returned ${first.status}: ${first.body}`);
  assert.deepStrictEqual(JSON.parse(first.body), { received: true, duplicate: false });

  const duplicate = await send({ id, timestamp, body, signature });
  assert.strictEqual(duplicate.status, 200, `duplicate delivery returned ${duplicate.status}: ${duplicate.body}`);
  assert.deepStrictEqual(JSON.parse(duplicate.body), { received: true, duplicate: true });

  const invalid = await send({ id: `${id}_invalid`, timestamp, body, signature: 'invalid' });
  assert.strictEqual(invalid.status, 401, `invalid signature returned ${invalid.status}: ${invalid.body}`);

  const staleTimestamp = timestamp - 601;
  const staleId = `${id}_stale`;
  const stale = await send({
    id: staleId,
    timestamp: staleTimestamp,
    body,
    signature: signatureFor(staleId, staleTimestamp, body)
  });
  assert.strictEqual(stale.status, 401, `stale timestamp returned ${stale.status}: ${stale.body}`);

  console.log('Resend webhook integration checks passed');
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
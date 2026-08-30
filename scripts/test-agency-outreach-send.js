'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  createAgencyOutreachRouter,
  validateAgencyOutreachPayload
} = require('../agency-outreach-endpoint');

async function startTestServer(sendEmail, options = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/outreach', createAgencyOutreachRouter({
    sendEmail,
    delay: 0,
    authorizationToken: options.authorizationToken ?? 'test-token',
    rateLimitMaxRequests: options.rateLimitMaxRequests
  }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}

async function post(baseUrl, body, token = 'test-token') {
  const response = await fetch(`${baseUrl}/api/outreach/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  return { response, json: await response.json() };
}

test('validates the complete request before attempting any send', () => {
  const result = validateAgencyOutreachPayload({
    kind: 'initial',
    items: [
      { id: 'one', to: 'one@example.com', subject: 'Subject', text: 'Body' },
      { id: 'two', to: 'not-an-email', subject: 'Subject', text: 'Body' }
    ]
  });
  assert.equal(result.valid, false);
});

test('handles wildcard CORS preflight', async t => {
  const server = await startTestServer(async () => ({ data: { id: 'test' } }));
  t.after(() => server.close());

  const response = await fetch(`${server.baseUrl}/api/outreach/send`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://tracker.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type'
    }
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(
    response.headers.get('access-control-allow-headers'),
    'Content-Type, Authorization, X-Outreach-Token'
  );
});

test('rejects unauthorised requests before calling the provider', async t => {
  let calls = 0;
  const server = await startTestServer(async () => {
    calls++;
    return { data: { id: 'unexpected' } };
  });
  t.after(() => server.close());

  const { response, json } = await post(server.baseUrl, {
    kind: 'initial',
    items: [{ id: 'one', to: 'one@example.com', subject: 'Subject', text: 'Body' }]
  }, null);
  assert.equal(response.status, 401);
  assert.deepEqual(json, { error: 'Outreach authorization required.' });
  assert.equal(calls, 0);
});

test('rejects invalid batches atomically with no provider calls', async t => {
  let calls = 0;
  const server = await startTestServer(async () => {
    calls++;
    return { data: { id: 'unexpected' } };
  });
  t.after(() => server.close());

  const { response, json } = await post(server.baseUrl, {
    kind: 'initial',
    items: [
      { id: 'one', to: 'one@example.com', subject: 'Subject', text: 'Body' },
      { id: 'two', to: 'not-an-email', subject: 'Subject', text: 'Body' }
    ]
  });
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
  assert.match(json.error, /valid email/i);
});

test('sends sequentially and continues after a provider failure', async t => {
  const calls = [];
  const server = await startTestServer(async params => {
    calls.push(params);
    if (params.to === 'fail@example.com') return { error: { message: 'provider rejected this send' } };
    return { data: { id: `resend-${calls.length}` } };
  });
  t.after(() => server.close());

  const { response, json } = await post(server.baseUrl, {
    kind: 'followup',
    items: [
      { id: 'first', to: 'first@example.com', subject: 'First subject', text: 'First body' },
      { id: 'failed', to: 'fail@example.com', subject: 'Failed subject', text: 'Failed body' },
      { id: 'last', to: 'last@example.com', subject: 'Last subject', text: 'Last body' }
    ]
  });

  assert.equal(response.status, 200);
  assert.deepEqual(json, {
    results: [
      { id: 'first', success: true },
      { id: 'failed', success: false, error: 'provider rejected this send' },
      { id: 'last', success: true }
    ]
  });
  assert.deepEqual(calls.map(call => call.to), [
    'first@example.com',
    'fail@example.com',
    'last@example.com'
  ]);
  assert.equal(calls[0].from, 'alex@strategicflow.tech');
  assert.equal(calls[0].replyTo, 'alex@strategicflow.tech');
  assert.equal(calls[0].text, 'First body');
});

test('accepts the 20-item maximum', async t => {
  let calls = 0;
  const server = await startTestServer(async () => {
    calls++;
    return { data: { id: `resend-${calls}` } };
  });
  t.after(() => server.close());

  const items = Array.from({ length: 20 }, (_, index) => ({
    id: `contact-${index}`,
    to: `contact-${index}@example.com`,
    subject: 'Subject',
    text: 'Body'
  }));
  const { response, json } = await post(server.baseUrl, { kind: 'initial', items });
  assert.equal(response.status, 200);
  assert.equal(calls, 20);
  assert.deepEqual(json.results.map(result => result.id), items.map(item => item.id));
});

test('rate-limits batches from one client without persisting request data', async t => {
  const server = await startTestServer(async () => ({ data: { id: 'test' } }), {
    rateLimitMaxRequests: 1
  });
  t.after(() => server.close());
  const body = {
    kind: 'initial',
    items: [{ id: 'one', to: 'one@example.com', subject: 'Subject', text: 'Body' }]
  };

  const first = await post(server.baseUrl, body);
  const second = await post(server.baseUrl, body);
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 429);
  assert.match(second.json.error, /too many/i);
  assert.ok(second.response.headers.get('retry-after'));
});
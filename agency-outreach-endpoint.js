'use strict';

const express = require('express');
const crypto = require('crypto');

const MAX_ITEMS = 20;
const MAX_ID_LENGTH = 200;
const MAX_EMAIL_LENGTH = 320;
const MAX_SUBJECT_LENGTH = 998;
const MAX_TEXT_LENGTH = 100000;
const SEND_DELAY_MS = 250;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
// One tracker run can legitimately need ~20 requests for the current list.
// Keep a guard against abuse, but do not make a normal run fail halfway through.
const RATE_LIMIT_MAX_REQUESTS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OUTREACH_UNSUBSCRIBE_LINE =
  "To unsubscribe from future outreach emails, reply with 'unsubscribe' or contact alex@strategicflow.tech.";
const ALLOWED_KINDS = new Set(['initial', 'followup']);
const TOP_LEVEL_KEYS = new Set(['kind', 'items']);
const ITEM_KEYS = new Set(['id', 'to', 'subject', 'text']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.has(key));
}

function invalid(message) {
  return { valid: false, error: message };
}

function validateAgencyOutreachPayload(payload) {
  if (!isRecord(payload) || !hasOnlyKeys(payload, TOP_LEVEL_KEYS)) {
    return invalid('Request body must contain only kind and items.');
  }
  if (!ALLOWED_KINDS.has(payload.kind)) {
    return invalid('kind must be "initial" or "followup".');
  }
  if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > MAX_ITEMS) {
    return invalid(`items must contain between 1 and ${MAX_ITEMS} entries.`);
  }

  for (let index = 0; index < payload.items.length; index++) {
    const item = payload.items[index];
    if (!isRecord(item) || !hasOnlyKeys(item, ITEM_KEYS)) {
      return invalid(`items[${index}] must contain only id, to, subject, and text.`);
    }
    if (typeof item.id !== 'string' || item.id.length === 0 || item.id.length > MAX_ID_LENGTH || item.id.trim() !== item.id) {
      return invalid(`items[${index}].id must be a non-empty string.`);
    }
    if (typeof item.to !== 'string' || item.to.length === 0 || item.to.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(item.to)) {
      return invalid(`items[${index}].to must be a valid email address.`);
    }
    if (typeof item.subject !== 'string' || item.subject.trim().length === 0 || item.subject.length > MAX_SUBJECT_LENGTH) {
      return invalid(`items[${index}].subject must be a non-empty string.`);
    }
    if (typeof item.text !== 'string' || item.text.trim().length === 0 || item.text.length > MAX_TEXT_LENGTH) {
      return invalid(`items[${index}].text must be a non-empty string.`);
    }
  }

  return { valid: true };
}

function errorMessage(error) {
  if (typeof error === 'string' && error) return error;
  if (error && typeof error.message === 'string' && error.message) return error.message;
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== '{}' ? serialized : 'Email send failed.';
  } catch {
    return 'Email send failed.';
  }
}

function setOutreachCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Outreach-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function deriveAgencyOutreachToken(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return '';
  return crypto.createHmac('sha256', secret).update('agency-outreach-send-v1').digest('hex');
}

function tokensEqual(expected, supplied) {
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function getSuppliedToken(req) {
  const authorization = String(req.get('authorization') || '');
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  return String(req.get('x-outreach-token') || '').trim();
}

function appendOutreachUnsubscribeLine(text) {
  if (text.trimEnd().endsWith(OUTREACH_UNSUBSCRIBE_LINE)) return text;
  return `${text.trimEnd()}\n\n${OUTREACH_UNSUBSCRIBE_LINE}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textToMinimalHtml(text) {
  const paragraphs = String(text).split(/\n\n+/);
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#202124;max-width:640px;">${
    paragraphs.map(paragraph =>
      `<p style="margin:0 0 16px;">${escapeHtml(paragraph)
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2563eb;">$1</a>')
        .replace(/\n/g, '<br>')}</p>`
    ).join('')
  }</div>`;
}

function createAgencyOutreachRouter({
  sendEmail,
  isSuppressed = async () => false,
  recordAttempt = async () => {},
  delay = SEND_DELAY_MS,
  authorizationToken = '',
  rateLimitWindowMs = RATE_LIMIT_WINDOW_MS,
  rateLimitMaxRequests = RATE_LIMIT_MAX_REQUESTS
} = {}) {
  if (typeof sendEmail !== 'function') {
    throw new TypeError('sendEmail must be a function');
  }
  if (typeof isSuppressed !== 'function') {
    throw new TypeError('isSuppressed must be a function');
  }
  if (typeof recordAttempt !== 'function') {
    throw new TypeError('recordAttempt must be a function');
  }

  const router = express.Router();
  const rateBuckets = new Map();

  function rateLimitKey(req) {
    return String(req.ip || req.socket?.remoteAddress || 'unknown').trim();
  }

  function rateLimitDecision(req) {
    const now = Date.now();
    const key = rateLimitKey(req);
    const current = rateBuckets.get(key);
    if (!current || now - current.startedAt >= rateLimitWindowMs) {
      if (rateBuckets.size > 10000) {
        for (const [bucketKey, bucket] of rateBuckets) {
          if (now - bucket.startedAt >= rateLimitWindowMs) rateBuckets.delete(bucketKey);
        }
      }
      rateBuckets.set(key, { startedAt: now, count: 1 });
      return { limited: false, retryAfterSeconds: 0 };
    }
    current.count += 1;
    if (current.count <= rateLimitMaxRequests) {
      return { limited: false, retryAfterSeconds: 0 };
    }
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((rateLimitWindowMs - (now - current.startedAt)) / 1000))
    };
  }

  async function recordItems(items, fields) {
    for (const item of Array.isArray(items) ? items : []) {
      try {
        await recordAttempt({
          campaign: 'agency-outreach-tracker',
          id: typeof item?.id === 'string' ? item.id : '',
          email: typeof item?.to === 'string' ? item.to : '',
          subject: typeof item?.subject === 'string' ? item.subject : '',
          kind: fields.kind || '',
          status: fields.status,
          error: fields.error || null,
          providerId: fields.providerId || null,
          httpStatus: fields.httpStatus || null
        });
      } catch (_) {
        // Audit failure must never turn a provider result into a duplicate send.
      }
    }
  }

  router.options('/send', (req, res) => {
    setOutreachCors(res);
    res.sendStatus(204);
  });

  router.post('/send', async (req, res) => {
    setOutreachCors(res);

    if (!authorizationToken) {
      await recordItems(req.body?.items, {
        kind: req.body?.kind,
        status: 'failed',
        error: 'Outreach sending is not configured.',
        httpStatus: 503
      });
      return res.status(503).json({ error: 'Outreach sending is not configured.' });
    }
    if (!tokensEqual(authorizationToken, getSuppliedToken(req))) {
      return res.status(401).json({ error: 'Outreach authorization required.' });
    }

    const rateLimit = rateLimitDecision(req);
    if (rateLimit.limited) {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      await recordItems(items, {
        kind: req.body?.kind,
        status: 'rate_limited',
        error: 'Too many outreach requests. Retry after the indicated delay.',
        httpStatus: 429
      });
      res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
      return res.status(429).json({
        error: 'Too many outreach requests. Retry after the indicated delay.',
        code: 'rate_limited',
        retryAfterSeconds: rateLimit.retryAfterSeconds,
        failedIds: items.map(item => item?.id).filter(id => typeof id === 'string')
      });
    }

    const validation = validateAgencyOutreachPayload(req.body);
    if (!validation.valid) {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      await recordItems(items, {
        kind: req.body?.kind,
        status: 'failed',
        error: validation.error,
        httpStatus: 400
      });
      return res.status(400).json({
        error: validation.error,
        code: 'invalid_batch',
        failedIds: items.map(item => item?.id).filter(id => typeof id === 'string')
      });
    }

    const results = [];
    for (let index = 0; index < req.body.items.length; index++) {
      const item = req.body.items[index];
      try {
        if (await isSuppressed(item.to)) {
          results.push({
            id: item.id,
            success: false,
            skipped: true,
            error: 'recipient_suppressed'
          });
          await recordItems([item], {
            kind: req.body.kind,
            status: 'suppressed',
            error: 'recipient_suppressed'
          });
          continue;
        }
        const text = appendOutreachUnsubscribeLine(item.text);
        const providerResult = await sendEmail({
          from: 'alex@strategicflow.tech',
          to: item.to,
          replyTo: 'alex@strategicflow.tech',
          subject: item.subject,
          text,
          html: textToMinimalHtml(text)
        });
        if (providerResult?.error) {
          const error = errorMessage(providerResult.error);
          results.push({ id: item.id, success: false, error });
          await recordItems([item], {
            kind: req.body.kind,
            status: 'failed',
            error
          });
        } else {
          results.push({ id: item.id, success: true });
          await recordItems([item], {
            kind: req.body.kind,
            status: 'accepted',
            providerId: providerResult?.id || providerResult?.data?.id || null
          });
        }
      } catch (error) {
        const message = errorMessage(error);
        results.push({ id: item.id, success: false, error: message });
        await recordItems([item], {
          kind: req.body.kind,
          status: 'failed',
          error: message
        });
      }

      if (index < req.body.items.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    return res.json({ results });
  });

  return router;
}

module.exports = {
  createAgencyOutreachRouter,
  deriveAgencyOutreachToken,
  validateAgencyOutreachPayload,
  errorMessage,
  MAX_ITEMS,
  SEND_DELAY_MS,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS
};
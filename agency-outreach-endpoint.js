'use strict';

const express = require('express');

const MAX_ITEMS = 20;
const MAX_ID_LENGTH = 200;
const MAX_EMAIL_LENGTH = 320;
const MAX_SUBJECT_LENGTH = 998;
const MAX_TEXT_LENGTH = 100000;
const SEND_DELAY_MS = 250;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function createAgencyOutreachRouter({ sendEmail, delay = SEND_DELAY_MS } = {}) {
  if (typeof sendEmail !== 'function') {
    throw new TypeError('sendEmail must be a function');
  }

  const router = express.Router();

  router.options('/send', (req, res) => {
    setOutreachCors(res);
    res.sendStatus(204);
  });

  router.post('/send', async (req, res) => {
    setOutreachCors(res);

    const validation = validateAgencyOutreachPayload(req.body);
    if (!validation.valid) return res.status(400).json({ error: validation.error });

    const results = [];
    for (let index = 0; index < req.body.items.length; index++) {
      const item = req.body.items[index];
      try {
        const providerResult = await sendEmail({
          from: 'alex@strategicflow.tech',
          to: item.to,
          replyTo: 'alex@strategicflow.tech',
          subject: item.subject,
          text: item.text
        });
        if (providerResult?.error) {
          results.push({ id: item.id, success: false, error: errorMessage(providerResult.error) });
        } else {
          results.push({ id: item.id, success: true });
        }
      } catch (error) {
        results.push({ id: item.id, success: false, error: errorMessage(error) });
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
  validateAgencyOutreachPayload,
  errorMessage,
  MAX_ITEMS,
  SEND_DELAY_MS
};
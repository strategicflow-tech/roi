'use strict';

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;

class SafeFetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
  }
}

function isBlockedIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  const [a, b] = octets;
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224;
}

function isBlockedIpv6(address) {
  const normalized = address.toLowerCase();
  return normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('::ffff:') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8');
}

function isBlockedAddress(address) {
  const family = net.isIP(address);
  return family === 4 ? isBlockedIpv4(address) : family === 6 ? isBlockedIpv6(address) : true;
}

function normalizedHostname(hostname) {
  return hostname.replace(/^\[|\]$/g, '');
}

function parsePublicHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new SafeFetchError('invalid_url', 'A valid HTTP(S) URL is required.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new SafeFetchError('invalid_url', 'Only public HTTP(S) URLs are allowed.');
  }
  const hostname = normalizedHostname(parsed.hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new SafeFetchError('private_host', 'Private network destinations are not allowed.');
  }

  const port = parsed.port ? Number(parsed.port) : null;
  if (port && port !== 80 && port !== 443) {
    throw new SafeFetchError('blocked_port', 'Only standard web ports are allowed.');
  }
  return parsed;
}

async function resolvePublicHostname(hostname) {
  const normalized = normalizedHostname(hostname);
  if (net.isIP(normalized)) {
    if (isBlockedAddress(normalized)) throw new SafeFetchError('private_address', 'Private network destinations are not allowed.');
    return { address: normalized, family: net.isIP(normalized) };
  }

  let records;
  try {
    records = await dns.promises.lookup(normalized, { all: true, verbatim: true });
  } catch {
    throw new SafeFetchError('dns_failed', 'The destination could not be resolved.');
  }
  if (!records.length || records.some(record => isBlockedAddress(record.address))) {
    throw new SafeFetchError('private_address', 'Private network destinations are not allowed.');
  }
  return records[0];
}

async function validatePublicHttpUrl(input) {
  const parsed = parsePublicHttpUrl(input);
  await resolvePublicHostname(parsed.hostname);
  return parsed.toString();
}

function toHeaderBag(rawHeaders) {
  const values = new Map();
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (value !== undefined) values.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
  }
  return {
    get(name) {
      return values.get(String(name).toLowerCase()) || null;
    }
  };
}

function collectResponseBody(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(response.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      response.resume();
      reject(new SafeFetchError('response_too_large', 'The destination response is too large.'));
      return;
    }

    const chunks = [];
    let received = 0;
    response.on('data', chunk => {
      received += chunk.length;
      if (received > maxBytes) {
        response.destroy(new SafeFetchError('response_too_large', 'The destination response is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => resolve(Buffer.concat(chunks)));
    response.on('error', error => reject(error instanceof SafeFetchError
      ? error
      : new SafeFetchError('fetch_failed', 'The destination request failed.')));
  });
}

async function requestOnce(parsed, { method, headers, timeoutMs, maxBytes }) {
  const hostname = normalizedHostname(parsed.hostname);
  const resolved = await resolvePublicHostname(hostname);
  const client = parsed.protocol === 'https:' ? https : http;
  const requestHeaders = {
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    ...headers,
  };

  return new Promise((resolve, reject) => {
    const request = client.request({
      protocol: parsed.protocol,
      hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: requestHeaders,
      agent: false,
      servername: net.isIP(hostname) ? undefined : hostname,
      lookup(requestHostname, _options, callback) {
        if (normalizedHostname(requestHostname) !== hostname) {
          callback(new SafeFetchError('dns_changed', 'The destination hostname changed unexpectedly.'));
          return;
        }
        callback(null, resolved.address, resolved.family);
      },
    }, async response => {
      const status = response.statusCode || 0;
      const headersBag = toHeaderBag(response.headers);
      if (status >= 300 && status < 400 && headersBag.get('location')) {
        response.resume();
        resolve({ redirectTo: headersBag.get('location') });
        return;
      }
      try {
        const body = method === 'HEAD' ? Buffer.alloc(0) : await collectResponseBody(response, maxBytes);
        resolve({
          status,
          ok: status >= 200 && status < 300,
          headers: headersBag,
          body,
        });
      } catch (error) {
        reject(error);
      }
    });

    request.setTimeout(timeoutMs, () => request.destroy(new SafeFetchError('timeout', 'The destination request timed out.')));
    request.on('error', error => reject(error instanceof SafeFetchError
      ? error
      : new SafeFetchError('fetch_failed', 'The destination request failed.')));
    request.end();
  });
}

async function safeFetchPublicUrl(input, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const maxBytes = Math.min(Math.max(Number(options.maxBytes) || DEFAULT_MAX_BYTES, 1), 10 * 1024 * 1024);
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 1), 30_000);
  const maxRedirects = Math.min(Math.max(Number(options.maxRedirects) || DEFAULT_MAX_REDIRECTS, 0), 5);
  let current = parsePublicHttpUrl(input);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const result = await requestOnce(current, { method, headers: options.headers || {}, timeoutMs, maxBytes });
    if (result.redirectTo) {
      if (redirectCount === maxRedirects) {
        throw new SafeFetchError('too_many_redirects', 'Too many redirects.');
      }
      current = parsePublicHttpUrl(new URL(result.redirectTo, current).toString());
      continue;
    }

    const body = result.body;
    return {
      ok: result.ok,
      status: result.status,
      headers: result.headers,
      url: current.toString(),
      text: async () => body.toString('utf8'),
      json: async () => JSON.parse(body.toString('utf8')),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  }

  throw new SafeFetchError('fetch_failed', 'The destination request failed.');
}

module.exports = {
  SafeFetchError,
  safeFetchPublicUrl,
  validatePublicHttpUrl,
};
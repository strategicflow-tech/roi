// ga4.js — Google Analytics 4 Data API helper
// Reads credentials from:
//   GA4_SERVICE_ACCOUNT_KEY  — JSON string of a GCP service account key file
//   GA4_PROPERTY_ID          — numeric GA4 property ID (e.g. "123456789")
//
// Usage (module):
//   const { queryPageViews } = require('./ga4');
//   const rows = await queryPageViews({ pagePath: '/landing-architecture-layer.html', startDate: 'today', endDate: 'today' });
//
// Usage (CLI):
//   node ga-query.js /landing-architecture-layer.html today today

'use strict';

const { BetaAnalyticsDataClient } = require('@google-analytics/data');

// ── Auth ─────────────────────────────────────────────────────────────────────

function getClient() {
  const raw = process.env.GA4_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error(
      'GA4_SERVICE_ACCOUNT_KEY secret is not set. ' +
      'Add it in Replit Secrets (see setup instructions).'
    );
  }

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new Error(
      'GA4_SERVICE_ACCOUNT_KEY is not valid JSON. ' +
      'Paste the entire contents of the service account .json file as the secret value.'
    );
  }

  return new BetaAnalyticsDataClient({ credentials });
}

function getPropertyId() {
  const pid = process.env.GA4_PROPERTY_ID;
  if (!pid) {
    throw new Error(
      'GA4_PROPERTY_ID secret is not set. ' +
      'Add the numeric GA4 property ID (e.g. "123456789") in Replit Secrets.'
    );
  }
  return pid.replace(/^properties\//, ''); // accept bare number or "properties/NNN"
}

// ── Core query ────────────────────────────────────────────────────────────────

/**
 * queryPageViews
 *
 * @param {object} opts
 * @param {string}   opts.pagePath   - URL path to filter on, e.g. '/landing-architecture-layer.html'
 *                                     Pass null / '' to get site-wide totals.
 * @param {string}   opts.startDate  - GA4 date string: 'today', 'yesterday', 'NdaysAgo', or 'YYYY-MM-DD'
 * @param {string}   opts.endDate    - same format as startDate
 * @param {string[]} [opts.metrics]  - default: ['screenPageViews', 'sessions', 'totalUsers']
 * @returns {Promise<{ summary: object, rows: object[] }>}
 */
async function queryPageViews({ pagePath, startDate = 'today', endDate = 'today', metrics }) {
  const client = getClient();
  const propertyId = getPropertyId();

  const metricNames = metrics || ['screenPageViews', 'sessions', 'totalUsers'];

  const request = {
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    metrics: metricNames.map(name => ({ name })),
    dimensions: [{ name: 'pagePath' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: pagePath ? 1 : 20,
  };

  if (pagePath) {
    request.dimensionFilter = {
      filter: {
        fieldName: 'pagePath',
        stringFilter: {
          matchType: 'EXACT',
          value: pagePath.startsWith('/') ? pagePath : '/' + pagePath,
          caseSensitive: false,
        },
      },
    };
  }

  const [response] = await client.runReport(request);

  const rows = (response.rows || []).map(row => {
    const out = { pagePath: row.dimensionValues[0].value };
    row.metricValues.forEach((mv, i) => {
      out[metricNames[i]] = Number(mv.value);
    });
    return out;
  });

  // Totals
  const summary = {};
  (response.totals || []).forEach(total => {
    total.metricValues.forEach((mv, i) => {
      summary[metricNames[i]] = Number(mv.value);
    });
  });

  return { summary, rows, dateRange: { startDate, endDate } };
}

/**
 * topPages — returns the top N pages by views for a date range (site-wide)
 */
async function topPages({ startDate = 'today', endDate = 'today', limit = 20 } = {}) {
  const client = getClient();
  const propertyId = getPropertyId();

  const [response] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'sessions' },
      { name: 'totalUsers' },
    ],
    dimensions: [{ name: 'pagePath' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit,
  });

  return (response.rows || []).map(row => ({
    pagePath: row.dimensionValues[0].value,
    screenPageViews: Number(row.metricValues[0].value),
    sessions: Number(row.metricValues[1].value),
    totalUsers: Number(row.metricValues[2].value),
  }));
}

module.exports = { queryPageViews, topPages, getClient, getPropertyId };

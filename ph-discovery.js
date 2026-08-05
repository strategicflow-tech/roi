'use strict';
/**
 * ph-discovery.js — Daily Product Hunt discovery pipeline
 *
 * Fetches today's PH launches, filters them, deduplicates against the directory,
 * picks the best 5, enriches with contact info, and inserts into directory_listings.
 *
 * Data source priority:
 *   1. PH GraphQL API — if PRODUCT_HUNT_TOKEN env var is set
 *   2. PH RSS feed + page scraping — no token required (fallback)
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ── Category mapping: PH topic slugs → ToolIndex categories ──────────────────
const TOPIC_MAP = {
  // Developer Tools
  'developer-tools': 'Developer Tools', 'devops': 'Developer Tools',
  'apis': 'Developer Tools', 'open-source': 'Developer Tools',
  'software-engineering': 'Developer Tools', 'github': 'Developer Tools',
  'databases': 'Developer Tools', 'cloud': 'Developer Tools',
  'cli': 'Developer Tools', 'ide': 'Developer Tools',
  // AI Tools
  'artificial-intelligence': 'AI Tools', 'machine-learning': 'AI Tools',
  'generative-ai': 'AI Tools', 'chatbots': 'AI Tools', 'llm': 'AI Tools',
  'ai-assistant': 'AI Tools', 'prompt-engineering': 'AI Tools',
  // Productivity
  'productivity': 'Productivity', 'task-management': 'Productivity',
  'note-taking': 'Productivity', 'time-management': 'Productivity',
  'writing-tools': 'Productivity', 'organization': 'Productivity',
  // Marketing
  'marketing': 'Marketing', 'email-marketing': 'Marketing', 'seo': 'Marketing',
  'content-marketing': 'Marketing', 'growth-hacking': 'Marketing',
  'copywriting': 'Marketing', 'landing-pages': 'Marketing',
  // Design
  'design-tools': 'Design', 'ux': 'Design', 'graphic-design': 'Design',
  'ui': 'Design', 'figma': 'Design', 'creative-tools': 'Design',
  'image-editing': 'Design', '3d': 'Design', 'illustrations': 'Design',
  // Finance
  'fintech': 'Finance', 'payments': 'Finance', 'finance': 'Finance',
  'accounting': 'Finance', 'invoicing': 'Finance', 'crypto': 'Finance',
  // Analytics
  'analytics': 'Analytics', 'data-visualization': 'Analytics',
  'business-intelligence': 'Analytics', 'data': 'Analytics',
  'monitoring': 'Analytics', 'logging': 'Analytics',
  // Social Media
  'social-media': 'Social Media', 'twitter': 'Social Media',
  'instagram': 'Social Media', 'linkedin': 'Social Media',
  'content-creation': 'Social Media', 'video': 'Social Media',
  // No-Code
  'no-code': 'No-Code', 'website-builder': 'No-Code', 'automation': 'No-Code',
  'low-code': 'No-Code', 'workflows': 'No-Code',
  // Sales
  'sales': 'Sales', 'crm': 'Sales', 'lead-generation': 'Sales',
  'outreach': 'Sales', 'cold-email': 'Sales',
  // HR & Recruiting
  'recruiting': 'HR & Recruiting', 'human-resources': 'HR & Recruiting',
  'hiring': 'HR & Recruiting', 'remote-work': 'HR & Recruiting',
};

// Topics/categories to skip entirely (consumer hardware, games, adult, etc.)
const SKIP_TOPICS = new Set([
  'gaming', 'games', 'hardware', 'wearables', 'home', 'travel', 'food',
  'health-fitness', 'parenting', 'pets', 'religion', 'dating', 'adult',
  'news', 'podcasts', 'music', 'books', 'education', 'kids', 'environment',
  'sports', 'lifestyle', 'fashion', 'beauty',
]);

// Known big/established company domains — skip anything from these
const BIG_DOMAINS = new Set([
  'google.com', 'apple.com', 'microsoft.com', 'amazon.com', 'meta.com',
  'facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 'netflix.com',
  'salesforce.com', 'oracle.com', 'ibm.com', 'sap.com', 'adobe.com',
  'atlassian.com', 'slack.com', 'zoom.us', 'hubspot.com', 'zendesk.com',
  'intercom.com', 'mailchimp.com', 'anthropic.com', 'openai.com',
  'github.com', 'gitlab.com', 'notion.so', 'figma.com', 'canva.com',
  'shopify.com', 'stripe.com', 'twilio.com', 'zapier.com', 'airtable.com',
  'monday.com', 'asana.com', 'clickup.com', 'trello.com', 'jira.atlassian.com',
  'vercel.com', 'netlify.com', 'cloudflare.com', 'heroku.com', 'aws.amazon.com',
  'azure.microsoft.com', 'cloud.google.com', 'dropbox.com', 'box.com',
  'webflow.com', 'wordpress.com', 'squarespace.com', 'wix.com', 'godaddy.com',
]);

// ── Timed fetch helper ────────────────────────────────────────────────────────
function timedFetch(url, timeoutMs = 12000, extraHeaders = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, {
    signal: ctrl.signal,
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ToolIndex/1.0; +https://strategic-flow-audit.replit.app/directory)',
      ...extraHeaders,
    },
  }).finally(() => clearTimeout(t));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normaliseDomain(urlStr) {
  try {
    return new URL(urlStr).hostname.toLowerCase().replace(/^www\./, '');
  } catch { return ''; }
}

// ── PART A: PH GraphQL API (requires PRODUCT_HUNT_TOKEN) ─────────────────────
async function fetchViaGraphQL(token) {
  // Get posts from the last 24h ordered by votes
  const now = new Date();
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  const postedAfter  = yesterday.toISOString().slice(0, 10);
  const postedBefore = now.toISOString().slice(0, 10);

  const query = `{
    posts(order: VOTES, first: 30, postedAfter: "${postedAfter}T00:00:00Z", postedBefore: "${postedBefore}T23:59:59Z") {
      edges {
        node {
          id name tagline url website votesCount
          thumbnail { url }
          topics { edges { node { name slug } } }
        }
      }
    }
  }`;

  const r = await fetch('https://api.producthunt.com/v2/api/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!r.ok) throw new Error(`PH GraphQL ${r.status}`);
  const data = await r.json();
  const edges = data?.data?.posts?.edges || [];

  return edges.map(e => ({
    name:    e.node.name,
    tagline: e.node.tagline || '',
    phUrl:   e.node.url,
    website: e.node.website || '',
    logo:    e.node.thumbnail?.url || '',
    votes:   e.node.votesCount || 0,
    topics:  (e.node.topics?.edges || []).map(t => t.node.slug),
  }));
}

// ── PART B: Atom feed + page scraping fallback ────────────────────────────────
// PH serves an Atom (not RSS) feed at /feed. Format:
//   <entry> blocks with <published>, <link rel="alternate" href="/products/...">,
//   and <id>tag:...,2005:Post/1234567</id>
// The redirect https://www.producthunt.com/r/p/{postId}?app_id=339
// resolves to the actual product website without auth.
async function fetchViaAtom() {
  const resp = await timedFetch('https://www.producthunt.com/feed', 15000, {
    'Accept': 'application/atom+xml, application/xml, text/xml, */*',
  });
  if (!resp.ok) throw new Error(`PH Atom feed ${resp.status}`);
  const xml = await resp.text();

  // Parse <entry> blocks (Atom format)
  const items = [];
  const entryRE = /<entry>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRE.exec(xml)) !== null) {
    const block = m[1];

    // Title
    const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(block);
    const name = (titleM?.[1] || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

    // Published date
    const pubM = /<published[^>]*>([\s\S]*?)<\/published>/i.exec(block);
    const pubDate = pubM?.[1]?.trim() || '';

    // PH product page link e.g. /products/claudemon
    const linkM = /<link\s[^>]*rel="alternate"[^>]*href="([^"]+)"/i.exec(block);
    const phUrl = linkM?.[1] || '';

    // Post ID from <id>tag:...,2005:Post/1213145</id>
    const idM = /Post\/(\d+)/.exec(block);
    const postId = idM?.[1] || '';

    // Tagline from <content> — strip HTML tags
    const contentM = /<content[^>]*>([\s\S]*?)<\/content>/i.exec(block);
    const contentRaw = contentM?.[1] || '';
    // Decode HTML entities, strip tags
    const tagline = contentRaw
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .split('Discussion')[0]  // strip the Discussion | Link footer
      .trim()
      .slice(0, 200);

    if (!name || !phUrl || !postId) continue;

    // Only include posts from the last 48h (PH uses Pacific Time, UTC-7)
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    try {
      if (pubDate && new Date(pubDate) < cutoff) continue;
    } catch {}

    items.push({ name, tagline, phUrl, postId });
  }

  console.log(`[ph-discovery] Atom feed: found ${items.length} recent entries`);

  // Enrich each entry
  const enriched = [];
  for (const item of items.slice(0, 25)) {
    await sleep(600);
    let website = '';
    let logo = '';
    let topics = [];

    // Step 1: Follow redirect to get actual product website
    // https://www.producthunt.com/r/p/{postId}?app_id=339 → 301 → product site
    try {
      const redirectUrl = `https://www.producthunt.com/r/p/${item.postId}?app_id=339`;
      const rr = await fetch(redirectUrl, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ToolIndex/1.0)' },
        signal: AbortSignal.timeout(8000),
      });
      const loc = rr.headers.get('location') || '';
      if (loc && !loc.includes('producthunt.com')) {
        // Strip UTM params
        try { website = new URL(loc).origin + new URL(loc).pathname; } catch { website = loc.split('?')[0]; }
      }
    } catch {}

    // Step 2: Scrape PH product page for logo (og:image) and topics
    try {
      const r = await timedFetch(item.phUrl, 12000);
      if (r.ok) {
        const html = await r.text();

        // Logo: prefer ph-files.imgix.net (product logo), else og:image
        const imgixM = /https:\/\/ph-files\.imgix\.net\/[a-f0-9-]+\.[a-z]+(?:\?[^"'\s]*)*/i.exec(html);
        if (imgixM) logo = imgixM[0].split('"')[0]; // stop at quote
        if (!logo) {
          const ogImgM = /property="og:image"\s+content="(https?:\/\/[^"]+)"/.exec(html)
                      || /content="(https?:\/\/[^"]+)"\s+property="og:image"/.exec(html);
          logo = ogImgM?.[1] || '';
        }

        // Website fallback from page if redirect didn't work
        if (!website) {
          const visitRE = /href="(https?:\/\/(?!www\.producthunt\.com)[^"?]{10,150})(?:[^"]*)"[^>]*(?:rel="noopener|>Visit|>Launch|Go to site)/i;
          const visitM = visitRE.exec(html);
          if (visitM) website = visitM[1];
        }

        // Topics from URL slugs
        const topicRE = /\/topics\/([a-z0-9-]+)/g;
        let tm;
        const seen = new Set();
        while ((tm = topicRE.exec(html)) !== null) {
          if (!seen.has(tm[1])) { topics.push(tm[1]); seen.add(tm[1]); }
        }
      }
    } catch (e) {
      console.warn(`[ph-discovery] page scrape failed for ${item.phUrl}: ${e.message}`);
    }

    if (website) {
      enriched.push({ ...item, website, logo, topics, votes: 0 });
    } else {
      console.log(`[ph-discovery] No website found for ${item.name} — skipping`);
    }
  }

  console.log(`[ph-discovery] Enriched: ${enriched.length} items with website URLs`);
  return enriched;
}

// ── Map PH topics to ToolIndex category ──────────────────────────────────────
function mapCategory(topics) {
  for (const slug of topics) {
    if (TOPIC_MAP[slug]) return TOPIC_MAP[slug];
  }
  return 'Other';
}

// Check if any topic is in the skip list
function shouldSkipTopics(topics) {
  return topics.some(s => SKIP_TOPICS.has(s));
}

// Check if this is a big company by website domain
function isBigCompany(website) {
  const domain = normaliseDomain(website);
  if (!domain) return false;
  if (BIG_DOMAINS.has(domain)) return true;
  // Also check if the domain itself is well-known (common TLD with short name suggests established company)
  return false;
}

// ── Deduplication against existing directory ──────────────────────────────────
async function getExistingDomains(pool) {
  const { rows } = await pool.query(
    `SELECT url, name, source_url FROM directory_listings WHERE status='active'`
  );
  const domains = new Set();
  const names = new Set();
  const phUrls = new Set();
  for (const r of rows) {
    const d = normaliseDomain(r.url || '');
    if (d) domains.add(d);
    if (r.name) names.add(r.name.toLowerCase().trim());
    if (r.source_url) phUrls.add(r.source_url.toLowerCase().trim());
  }
  return { domains, names, phUrls };
}

function isDuplicate(post, existing) {
  const domain = normaliseDomain(post.website);
  if (domain && existing.domains.has(domain)) return true;
  if (post.name && existing.names.has(post.name.toLowerCase().trim())) return true;
  if (post.phUrl && existing.phUrls.has(post.phUrl.toLowerCase().trim())) return true;
  return false;
}

// ── Contact enrichment (replicates extractContactEmail from server.js) ─────────
async function extractContact(productUrl) {
  const EMAIL_RE = /\b([a-zA-Z0-9._%+\-]{1,40}@[a-zA-Z0-9.\-]{1,60}\.[a-zA-Z]{2,10})\b/g;
  const SKIP_LOCAL  = /^(noreply|no-reply|donotreply|mailer-daemon|bounce|postmaster|unsubscribe|privacy@example|test|user|name|someone|your)/i;
  const SKIP_DOMAIN = /example\.|test\.|placeholder\.|sentry\.|mailchimp\.com|sendgrid\.net|amazonaws\.com|wixpress\.com|squarespace\.com/i;

  let base;
  try { base = new URL(productUrl).origin; } catch { return { status: 'invalid' }; }

  function clean(html) {
    return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  }

  function extractLinkedIn(html) {
    const LI_RE = /https?:\/\/(?:www\.)?linkedin\.com\/(in|company)\/([a-zA-Z0-9_%-]{2,80})\/?/g;
    const matches = [...html.matchAll(LI_RE)];
    if (!matches.length) return null;
    const personal = matches.find(x => x[1] === 'in');
    const chosen = personal || matches[0];
    return `https://www.linkedin.com/${chosen[1]}/${chosen[2]}/`;
  }

  function extractFromHtml(html) {
    const text = clean(html);
    // Priority 1: mailto: hrefs
    const mailtos = [...html.matchAll(/href=["']mailto:([^"'?\s]{3,80})["']/gi)]
      .map(m => m[1].split('?')[0].toLowerCase().trim())
      .filter(e => /^[^@]{1,40}@[^@]{1,60}\.[a-z]{2,10}$/.test(e)
               && !SKIP_LOCAL.test(e) && !SKIP_DOMAIN.test(e));
    if (mailtos.length) return mailtos[0];
    // Priority 2: contextual keywords
    const ctxMatches = [...text.matchAll(
      /(?:contact\s+us|email\s+us|reach\s+us|get\s+in\s+touch|write\s+to\s+us|send\s+us\s+an?\s+email|hello@|hi@|support@|team@)[\s\S]{0,400}/gi
    )];
    for (const m of ctxMatches) {
      const emails = [...m[0].matchAll(EMAIL_RE)].map(e => e[1].toLowerCase())
        .filter(e => !SKIP_LOCAL.test(e) && !SKIP_DOMAIN.test(e));
      if (emails.length) return emails[0];
    }
    // Priority 3: footer
    const footerHtml = text.match(/<footer[\s\S]{0,8000}/i)?.[0] || text.slice(-5000);
    const footerEmails = [...footerHtml.matchAll(EMAIL_RE)]
      .map(e => e[1].toLowerCase()).filter(e => !SKIP_LOCAL.test(e) && !SKIP_DOMAIN.test(e));
    if (footerEmails.length) return footerEmails[0];
    return null;
  }

  // Check robots.txt
  try {
    const rb = await timedFetch(`${base}/robots.txt`, 5000);
    if (rb?.ok) {
      const txt = await rb.text();
      if (/User-agent:\s*\*[\s\S]{0,300}Disallow:\s*\/\s*(\r?\n|$)/i.test(txt))
        return { status: 'blocked', source: `${base}/robots.txt` };
    }
  } catch {}

  // Pages to check — same order as server.js plus /terms and /tos
  const pages = [
    productUrl, `${base}/contact`, `${base}/about`, `${base}/support`,
    `${base}/privacy`, `${base}/terms`, `${base}/tos`, `${base}/imprint`,
  ];

  let foundLinkedIn = null;
  for (const page of pages) {
    try {
      const resp = await timedFetch(page, 10000);
      if (!resp?.ok) { await sleep(1200); continue; }
      const html = await resp.text().catch(() => '');
      const email = extractFromHtml(html);
      if (!foundLinkedIn) foundLinkedIn = extractLinkedIn(html);
      if (email) return { email, linkedin: foundLinkedIn, source: page, status: 'found' };
    } catch {}
    await sleep(1200);
  }
  if (foundLinkedIn) return { linkedin: foundLinkedIn, status: 'not_found' };
  return { status: 'not_found' };
}

// ── Main pipeline function — call this from the cron job ──────────────────────
async function runDailyPHDiscovery(pool, log = console.log, opts = {}) {
  log('[ph-discovery] Starting daily Product Hunt discovery…');

  // 1. Fetch today's PH posts
  let posts = [];
  const token = process.env.PRODUCT_HUNT_TOKEN;
  try {
    if (token) {
      log('[ph-discovery] Using PH GraphQL API (token set)');
      posts = await fetchViaGraphQL(token);
    } else {
      log('[ph-discovery] No PRODUCT_HUNT_TOKEN — using Atom feed fallback');
      posts = await fetchViaAtom();
    }
    log(`[ph-discovery] Raw posts fetched: ${posts.length}`);
  } catch (e) {
    log(`[ph-discovery] ERROR fetching PH data: ${e.message}`);
    return { inserted: 0, error: e.message };
  }

  // 2. Filter by category (must map to a known ToolIndex category)
  const categorised = posts.filter(p => {
    if (shouldSkipTopics(p.topics || [])) return false;
    const cat = mapCategory(p.topics || []);
    p._category = cat;
    return true; // keep even "Other" — better to have more candidates
  });
  log(`[ph-discovery] After topic filter: ${categorised.length}`);

  // 3. Exclude big companies
  const indie = categorised.filter(p => {
    if (isBigCompany(p.website || '')) {
      log(`[ph-discovery] Skipping big company: ${p.name}`);
      return false;
    }
    return true;
  });
  log(`[ph-discovery] After big company filter: ${indie.length}`);

  // 4. Require a real website URL
  const withSite = indie.filter(p => {
    const ws = (p.website || '').trim();
    if (!ws || ws === p.phUrl) return false; // no external site
    try { new URL(ws); return true; } catch { return false; }
  });
  log(`[ph-discovery] After website filter: ${withSite.length}`);

  // 5. Deduplicate against DB
  const existing = await getExistingDomains(pool);
  const fresh = withSite.filter(p => {
    if (isDuplicate(p, existing)) {
      log(`[ph-discovery] Duplicate skip: ${p.name}`);
      return false;
    }
    return true;
  });
  log(`[ph-discovery] After dedup: ${fresh.length}`);

  // 6. Pick best 5 — prefer posts with more votes (higher quality signal) and a logo
  const sorted = fresh.sort((a, b) => {
    const scoreA = (b.votes || 0) + (a.logo ? 10 : 0);
    const scoreB = (a.votes || 0) + (b.logo ? 10 : 0);
    return scoreB - scoreA;
  });
  const picks = sorted.slice(0, 5);
  log(`[ph-discovery] Selected ${picks.length} candidates`);

  if (!picks.length) {
    log('[ph-discovery] No new listings to insert today.');
    return { inserted: 0 };
  }

  // 7. Enrich with contact info + insert
  const inserted = [];
  for (const post of picks) {
    log(`[ph-discovery] Enriching: ${post.name} (${post.website})`);

    // Truncate description to ~160 chars like existing listings
    const desc = (post.tagline || '').slice(0, 160).trim();
    const category = post._category || 'Other';
    const logo = post.logo || '';

    // Contact enrichment (may take 20-60s per listing)
    let email = null, linkedin = null, emailStatus = 'pending', emailSource = null;
    try {
      const contact = await extractContact(post.website);
      email = contact.email || null;
      linkedin = contact.linkedin || null;
      emailStatus = contact.status || 'not_found';
      emailSource = contact.source || null;
      log(`[ph-discovery]   → email: ${email||'—'} | linkedin: ${linkedin||'—'}`);
    } catch (e) {
      log(`[ph-discovery]   → contact extraction failed: ${e.message}`);
    }

    try {
      const r = await pool.query(
        `INSERT INTO directory_listings
           (name, url, category, description, image_url,
            source, source_url, status, vote_count, score_pending,
            is_seeded, is_auto_imported,
            contact_email, contact_email_status, contact_email_source, contact_email_fetched_at,
            social_linkedin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',0,true,false,true,$8,$9,$10,NOW(),$11)
         ON CONFLICT DO NOTHING
         RETURNING id, name`,
        [
          post.name, post.website, category, desc, logo,
          'Product Hunt', post.phUrl,
          email, emailStatus, emailSource,
          linkedin,
        ]
      );
      if (r.rows.length) {
        inserted.push({ id: r.rows[0].id, name: r.rows[0].name, url: post.website, category, description: desc });
        log(`[ph-discovery]   → Inserted id=${r.rows[0].id}: ${r.rows[0].name}`);
      } else {
        log(`[ph-discovery]   → Skipped (ON CONFLICT): ${post.name}`);
      }
    } catch (e) {
      log(`[ph-discovery]   → DB insert error for ${post.name}: ${e.message}`);
    }

    await sleep(2000); // be polite between enrichments
  }

  log(`[ph-discovery] Done. Inserted ${inserted.length} new listings.`);

  // 8. AI enrichment for newly inserted listings (optional — only if enrichFn provided)
  if (inserted.length > 0 && typeof opts.enrichFn === 'function') {
    log(`[ph-discovery] Starting AI enrichment for ${inserted.length} new listings…`);
    for (const listing of inserted) {
      await sleep(2000);
      try {
        await opts.enrichFn(listing, pool, opts.claudeJsonFn);
        log(`[ph-discovery]   → AI insights stored for: ${listing.name}`);
      } catch (e) {
        log(`[ph-discovery]   → AI enrichment failed for ${listing.name}: ${e.message}`);
      }
    }
  }

  return { inserted: inserted.length, listings: inserted };
}

// ── Draft discovery helpers ───────────────────────────────────────────────────

// Fetch PH posts from last N days via GraphQL
async function fetchViaGraphQLDays(token, daysBack = 3) {
  const now = new Date();
  const start = new Date(now - daysBack * 24 * 60 * 60 * 1000);
  const postedAfter  = start.toISOString().slice(0, 10);
  const postedBefore = now.toISOString().slice(0, 10);

  const query = `{
    posts(order: VOTES, first: 60, postedAfter: "${postedAfter}T00:00:00Z", postedBefore: "${postedBefore}T23:59:59Z") {
      edges {
        node {
          id name tagline url website votesCount
          thumbnail { url }
          topics { edges { node { name slug } } }
        }
      }
    }
  }`;

  const r = await fetch('https://api.producthunt.com/v2/api/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`PH GraphQL ${r.status}`);
  const data = await r.json();
  const edges = data?.data?.posts?.edges || [];
  return edges.map(e => ({
    name:    e.node.name,
    tagline: e.node.tagline || '',
    phUrl:   e.node.url,
    website: e.node.website || '',
    logo:    e.node.thumbnail?.url || '',
    votes:   e.node.votesCount || 0,
    topics:  (e.node.topics?.edges || []).map(t => t.node.slug),
  }));
}

// Fetch PH posts from Atom feed with extended lookback (up to N hours)
async function fetchViaAtomExtended(daysBack = 3) {
  const resp = await timedFetch('https://www.producthunt.com/feed', 15000, {
    'Accept': 'application/atom+xml, application/xml, text/xml, */*',
  });
  if (!resp.ok) throw new Error(`PH Atom feed ${resp.status}`);
  const xml = await resp.text();
  const items = [];
  const entryRE = /<entry>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRE.exec(xml)) !== null) {
    const block = m[1];
    const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(block);
    const name = (titleM?.[1] || '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
    const pubM = /<published[^>]*>([\s\S]*?)<\/published>/i.exec(block);
    const pubDate = pubM?.[1]?.trim() || '';
    const linkM = /<link\s[^>]*rel="alternate"[^>]*href="([^"]+)"/i.exec(block);
    const phUrl = linkM?.[1] || '';
    const idM = /Post\/(\d+)/.exec(block);
    const postId = idM?.[1] || '';
    const contentM = /<content[^>]*>([\s\S]*?)<\/content>/i.exec(block);
    const contentRaw = contentM?.[1] || '';
    const tagline = contentRaw
      .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"')
      .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ')
      .split('Discussion')[0].trim().slice(0, 200);
    if (!name || !phUrl || !postId) continue;
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    try { if (pubDate && new Date(pubDate) < cutoff) continue; } catch {}
    items.push({ name, tagline, phUrl, postId });
  }
  // Reuse Atom enrichment logic (scrape websites + logos)
  const enriched = [];
  for (const item of items.slice(0, 40)) {
    await sleep(600);
    let website = '', logo = '', topics = [];
    try {
      const redirectUrl = `https://www.producthunt.com/r/p/${item.postId}?app_id=339`;
      const rr = await fetch(redirectUrl, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ToolIndex/1.0)' },
        signal: AbortSignal.timeout(8000),
      });
      const loc = rr.headers.get('location') || '';
      if (loc && !loc.includes('producthunt.com')) {
        try { website = new URL(loc).origin + new URL(loc).pathname; } catch { website = loc.split('?')[0]; }
      }
    } catch {}
    try {
      const r = await timedFetch(item.phUrl, 12000);
      if (r.ok) {
        const html = await r.text();
        const imgixM = /https:\/\/ph-files\.imgix\.net\/[a-f0-9-]+\.[a-z]+(?:\?[^"'\s]*)*/i.exec(html);
        if (imgixM) logo = imgixM[0].split('"')[0];
        if (!logo) {
          const ogImgM = /property="og:image"\s+content="(https?:\/\/[^"]+)"/.exec(html)
                      || /content="(https?:\/\/[^"]+)"\s+property="og:image"/.exec(html);
          logo = ogImgM?.[1] || '';
        }
        if (!website) {
          const visitRE = /href="(https?:\/\/(?!www\.producthunt\.com)[^"?]{10,150})(?:[^"]*)"[^>]*(?:rel="noopener|>Visit|>Launch|Go to site)/i;
          const visitM = visitRE.exec(html);
          if (visitM) website = visitM[1];
        }
        const topicRE = /\/topics\/([a-z0-9-]+)/g;
        let tm; const seen = new Set();
        while ((tm = topicRE.exec(html)) !== null) {
          if (!seen.has(tm[1])) { topics.push(tm[1]); seen.add(tm[1]); }
        }
      }
    } catch {}
    if (website) enriched.push({ ...item, website, logo, topics, votes: 0 });
  }
  return enriched;
}

// Dedup against BOTH active and draft listings
async function getExistingDomainsAll(pool) {
  const { rows } = await pool.query(
    `SELECT url, name, source_url FROM directory_listings WHERE status IN ('active','draft')`
  );
  const domains = new Set(), names = new Set(), phUrls = new Set();
  for (const r of rows) {
    const d = normaliseDomain(r.url || '');
    if (d) domains.add(d);
    if (r.name) names.add(r.name.toLowerCase().trim());
    if (r.source_url) phUrls.add(r.source_url.toLowerCase().trim());
  }
  return { domains, names, phUrls };
}

// ── Draft discovery pipeline — 15/day, email required before insert ───────────
async function runDailyPHDraftDiscovery(pool, log = console.log, resend, SENDER) {
  log('[ph-draft] Starting daily draft discovery (last 3 days, 15 max)…');

  // 1. Fetch PH posts from last 3 days
  let posts = [];
  const token = process.env.PRODUCT_HUNT_TOKEN;
  try {
    if (token) {
      log('[ph-draft] Using PH GraphQL API (3-day window)');
      posts = await fetchViaGraphQLDays(token, 3);
    } else {
      log('[ph-draft] No PRODUCT_HUNT_TOKEN — using Atom feed (3-day window)');
      posts = await fetchViaAtomExtended(3);
    }
    log(`[ph-draft] Raw posts fetched: ${posts.length}`);
  } catch(e) {
    log(`[ph-draft] ERROR fetching PH data: ${e.message}`);
    return { inserted: 0, error: e.message };
  }

  // 2. Filter by category
  const categorised = posts.filter(p => {
    if (shouldSkipTopics(p.topics || [])) return false;
    p._category = mapCategory(p.topics || []);
    return true;
  });
  log(`[ph-draft] After topic filter: ${categorised.length}`);

  // 3. Exclude big companies
  const indie = categorised.filter(p => !isBigCompany(p.website || ''));
  log(`[ph-draft] After big company filter: ${indie.length}`);

  // 4. Require real website
  const withSite = indie.filter(p => {
    const ws = (p.website || '').trim();
    if (!ws || ws === p.phUrl) return false;
    try { new URL(ws); return true; } catch { return false; }
  });
  log(`[ph-draft] After website filter: ${withSite.length}`);

  // 5. Dedup against BOTH active and draft listings
  const existing = await getExistingDomainsAll(pool);
  const fresh = withSite.filter(p => !isDuplicate(p, existing));
  log(`[ph-draft] After dedup: ${fresh.length}`);

  // 6. Sort by votes + logo, take up to 30 candidates to attempt (pick best 15 with emails)
  const sorted = fresh.sort((a, b) => {
    const sA = (a.votes || 0) + (a.logo ? 10 : 0);
    const sB = (b.votes || 0) + (b.logo ? 10 : 0);
    return sB - sA;
  });
  const candidates = sorted.slice(0, 30);
  log(`[ph-draft] Processing ${candidates.length} candidates to find emails…`);

  // 7. Contact extraction BEFORE insert — skip if no email found
  const inserted = [];
  for (const post of candidates) {
    if (inserted.length >= 15) break; // cap at 15 drafts per day

    log(`[ph-draft] Extracting contact for: ${post.name} (${post.website})`);
    let email = null, linkedin = null, emailStatus = 'not_found', emailSource = null;
    try {
      const contact = await extractContact(post.website);
      email = contact.email || null;
      linkedin = contact.linkedin || null;
      emailStatus = contact.status || 'not_found';
      emailSource = contact.source || null;
      log(`[ph-draft]   → email: ${email||'—'} | linkedin: ${linkedin||'—'}`);
    } catch(e) {
      log(`[ph-draft]   → contact extraction failed: ${e.message}`);
    }

    // Skip if no email found — draft pipeline requires email
    if (!email) {
      log(`[ph-draft]   → No email found, skipping (not inserting as draft)`);
      await sleep(1500);
      continue;
    }

    const desc = (post.tagline || '').slice(0, 160).trim();
    const category = post._category || 'Other';
    const logo = post.logo || '';

    // 8. Insert as draft
    try {
      const r = await pool.query(
        `INSERT INTO directory_listings
           (name, url, category, description, image_url,
            source, source_url, status, vote_count, score_pending,
            is_seeded, is_auto_imported,
            contact_email, contact_email_status, contact_email_source, contact_email_fetched_at,
            social_linkedin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',0,true,false,true,$8,$9,$10,NOW(),$11)
         ON CONFLICT DO NOTHING
         RETURNING id, name`,
        [
          post.name, post.website, category, desc, logo,
          'Product Hunt', post.phUrl,
          email, emailStatus, emailSource,
          linkedin,
        ]
      );
      if (!r.rows.length) {
        log(`[ph-draft]   → Skipped (ON CONFLICT): ${post.name}`);
        await sleep(1500);
        continue;
      }

      const newId = r.rows[0].id;
      const name  = r.rows[0].name;
      inserted.push({ id: newId, name, url: post.website });
      log(`[ph-draft]   → Inserted draft id=${newId}: ${name}`);

      // 9. Send draft claim email immediately
      const slugStr = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + newId;
      const listingUrl = `https://strategic-flow-audit.replit.app/directory/${slugStr}`;
      const draftHtml = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:32px auto;color:#1a1a2e;line-height:1.7;font-size:15px;">
<p>Hi,</p>
<p>Your app <strong>${name}</strong> is already in our ToolIndex database — but it&rsquo;s currently a private draft. Claiming it makes it public and gets you a permanent dofollow backlink from <strong>strategicflow.tech</strong>.</p>
<p>It takes about a minute to claim, and you can edit the description, logo, and links after. If it&rsquo;s not your product, no action needed.</p>
<p style="margin:28px 0;"><a href="${listingUrl}" style="display:inline-block;background:#00d4c8;color:#0a1628;padding:13px 28px;text-decoration:none;font-weight:700;border-radius:6px;font-size:15px;">Claim it free &rarr;</a></p>
<p style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:13px;color:#555;line-height:2;"><strong>Alex Iliescu</strong><br>Strategic Flow — <a href="https://strategicflow.tech" style="color:#00d4c8;">strategicflow.tech</a><br>ToolIndex — <a href="https://strategic-flow-audit.replit.app/directory" style="color:#00d4c8;">strategic-flow-audit.replit.app/directory</a><br>LinkedIn: <a href="https://www.linkedin.com/in/strategic-flow-tech" style="color:#00d4c8;">linkedin.com/in/strategic-flow-tech</a><br>Tenerife, Spain</p>
<p style="font-size:11px;color:#9ca3af;">Reply to let us know if you&rsquo;d rather not hear from us again.</p>
</div>`;
      const draftText = `Hi,\n\nYour app ${name} is already in our ToolIndex database — but it's currently a private draft. Claiming it makes it public and gets you a permanent dofollow backlink from strategicflow.tech.\n\nIt takes about a minute to claim, and you can edit the description, logo, and links after. If it's not your product, no action needed.\n\nClaim it free: ${listingUrl}\n\n--\nAlex Iliescu\nStrategic Flow — strategicflow.tech\nToolIndex — https://strategic-flow-audit.replit.app/directory\nLinkedIn: https://www.linkedin.com/in/strategic-flow-tech\nTenerife, Spain\n\nReply to let us know if you'd rather not hear from us again.`;

      try {
        await resend.emails.send({
          from:    SENDER,
          to:      email,
          replyTo: 'strategicflow@proton.me',
          subject: `Your ${name} listing on ToolIndex is ready — claim it to go live`,
          html:    draftHtml,
          text:    draftText,
        });
        await pool.query(
          `UPDATE directory_listings SET outreach_emailed_at=NOW() WHERE id=$1`,
          [newId]
        );
        log(`[ph-draft]   → Draft claim email sent → ${email} (${name})`);
      } catch(emailErr) {
        log(`[ph-draft]   → Email send failed for ${name}: ${emailErr.message}`);
      }

    } catch(e) {
      log(`[ph-draft]   → DB insert error for ${post.name}: ${e.message}`);
    }

    await sleep(2000);
  }

  log(`[ph-draft] Done. Inserted ${inserted.length} draft listings.`);
  return { inserted: inserted.length, listings: inserted };
}

module.exports = { runDailyPHDiscovery, runDailyPHDraftDiscovery };

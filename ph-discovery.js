'use strict';
/**
 * ph-discovery.js — Unified daily Product Hunt discovery pipeline (v2)
 *
 * Single job, runs once daily. A product is included only if ALL three hold:
 *   1. Posted on PH within the last 3 days
 *   2. Has a discoverable public contact email (extracted from product site)
 *   3. The maker/founder has actively replied to ≥1 comment on their own launch thread
 *
 * Products are inserted as status='draft' (hidden from /directory public listing).
 * A claim-invitation email is sent to the founder immediately after insert.
 * Target: 25 qualifying products per day.
 *
 * Data source:
 *   - PH GraphQL API (includes comments.isMakerComment) if PRODUCT_HUNT_TOKEN is set
 *   - PH Atom feed + page scraping fallback (no token required)
 */

const { URL } = require('url');

// ── Category mapping ──────────────────────────────────────────────────────────
const TOPIC_MAP = {
  'developer-tools': 'Developer Tools', 'devops': 'Developer Tools',
  'apis': 'Developer Tools', 'open-source': 'Developer Tools',
  'software-engineering': 'Developer Tools', 'github': 'Developer Tools',
  'databases': 'Developer Tools', 'cloud': 'Developer Tools',
  'cli': 'Developer Tools', 'ide': 'Developer Tools',
  'artificial-intelligence': 'AI Tools', 'machine-learning': 'AI Tools',
  'generative-ai': 'AI Tools', 'chatbots': 'AI Tools', 'llm': 'AI Tools',
  'ai-assistant': 'AI Tools', 'prompt-engineering': 'AI Tools',
  'productivity': 'Productivity', 'task-management': 'Productivity',
  'note-taking': 'Productivity', 'time-management': 'Productivity',
  'writing-tools': 'Productivity', 'organization': 'Productivity',
  'marketing': 'Marketing', 'email-marketing': 'Marketing', 'seo': 'Marketing',
  'content-marketing': 'Marketing', 'growth-hacking': 'Marketing',
  'copywriting': 'Marketing', 'landing-pages': 'Marketing',
  'design-tools': 'Design', 'ux': 'Design', 'graphic-design': 'Design',
  'ui': 'Design', 'figma': 'Design', 'creative-tools': 'Design',
  'image-editing': 'Design', '3d': 'Design', 'illustrations': 'Design',
  'fintech': 'Finance', 'payments': 'Finance', 'finance': 'Finance',
  'accounting': 'Finance', 'invoicing': 'Finance', 'crypto': 'Finance',
  'analytics': 'Analytics', 'data-visualization': 'Analytics',
  'business-intelligence': 'Analytics', 'data': 'Analytics',
  'monitoring': 'Analytics', 'logging': 'Analytics',
  'social-media': 'Social Media', 'twitter': 'Social Media',
  'instagram': 'Social Media', 'linkedin': 'Social Media',
  'content-creation': 'Social Media', 'video': 'Social Media',
  'no-code': 'No-Code', 'website-builder': 'No-Code', 'automation': 'No-Code',
  'low-code': 'No-Code', 'workflows': 'No-Code',
  'sales': 'Sales', 'crm': 'Sales', 'lead-generation': 'Sales',
  'outreach': 'Sales', 'cold-email': 'Sales',
  'recruiting': 'HR & Recruiting', 'human-resources': 'HR & Recruiting',
  'hiring': 'HR & Recruiting', 'remote-work': 'HR & Recruiting',
};

// Topics to skip (consumer hardware, games, lifestyle, etc.)
const SKIP_TOPICS = new Set([
  'gaming', 'games', 'hardware', 'wearables', 'home', 'travel', 'food',
  'health-fitness', 'parenting', 'pets', 'religion', 'dating', 'adult',
  'news', 'podcasts', 'music', 'books', 'education', 'kids', 'environment',
  'sports', 'lifestyle', 'fashion', 'beauty', 'crypto', 'web3', 'nft',
  'blockchain', 'defi',
]);

// Known big-company ROOT domains (stripped of subdomains)
const BIG_DOMAINS = new Set([
  'google.com', 'apple.com', 'microsoft.com', 'amazon.com', 'meta.com',
  'facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 'netflix.com',
  'salesforce.com', 'oracle.com', 'ibm.com', 'sap.com', 'adobe.com',
  'atlassian.com', 'slack.com', 'zoom.us', 'hubspot.com', 'zendesk.com',
  'intercom.com', 'mailchimp.com', 'anthropic.com', 'openai.com',
  'github.com', 'gitlab.com', 'notion.so', 'figma.com', 'canva.com',
  'shopify.com', 'stripe.com', 'twilio.com', 'zapier.com', 'airtable.com',
  'monday.com', 'asana.com', 'clickup.com', 'trello.com',
  'vercel.com', 'netlify.com', 'cloudflare.com', 'heroku.com',
  'dropbox.com', 'box.com', 'webflow.com', 'wordpress.com', 'squarespace.com',
  'wix.com', 'godaddy.com', 'nvidia.com', 'intel.com', 'qualcomm.com',
  'paypal.com', 'visa.com', 'mastercard.com', 'docker.com', 'hashicorp.com',
  'elastic.co', 'mongodb.com', 'redis.com', 'snowflake.com', 'databricks.com',
  'workday.com', 'servicenow.com', 'okta.com', 'crowdstrike.com',
  'datadog.com', 'splunk.com', 'pagerduty.com', 'twitch.tv', 'discord.com',
  'spotify.com', 'tiktok.com', 'pinterest.com', 'reddit.com', 'quora.com',
  'medium.com', 'substack.com', 'calendly.com', 'typeform.com',
  'dover.com', 'rippling.com', 'gusto.com', 'bamboohr.com', 'greenhouse.io',
  'lever.co', 'ashbyhq.com', 'gem.com', 'gong.io', 'salesloft.com',
  'outreach.io', 'apollo.io', 'zoominfo.com', 'clearbit.com',
]);

// Brand names that signal large/established companies (matched against product name)
const BIG_BRAND_RE = /\b(cloudflare|google|microsoft|apple|amazon|meta|facebook|instagram|twitter|linkedin|netflix|salesforce|oracle|adobe|atlassian|slack|zoom|hubspot|zendesk|intercom|mailchimp|anthropic|openai|github|gitlab|notion|figma|canva|shopify|stripe|twilio|zapier|airtable|monday\.com|asana|clickup|trello|vercel|netlify|heroku|dropbox|docker|kubernetes|hashicorp|elastic|mongodb|redis|snowflake|databricks|workday|servicenow|okta|crowdstrike|datadog|splunk|nvidia|intel|qualcomm|paypal|visa|mastercard|spotify|tiktok|pinterest|discord|twitch|wordpress|squarespace|godaddy|rippling|gusto|dover)\b/i;

// ── Helpers ───────────────────────────────────────────────────────────────────
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

// Full hostname without www
function normaliseDomain(urlStr) {
  try { return new URL(urlStr).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

// Root domain: blog.cloudflare.com → cloudflare.com
function rootDomain(urlStr) {
  try {
    const host = new URL(urlStr).hostname.toLowerCase().replace(/^www\./, '');
    const parts = host.split('.');
    // Handle: co.uk, com.au, etc. — take last 2 segments
    return parts.length > 2 ? parts.slice(-2).join('.') : host;
  } catch { return ''; }
}

function mapCategory(topics) {
  for (const slug of (topics || [])) {
    if (TOPIC_MAP[slug]) return TOPIC_MAP[slug];
  }
  return 'Other';
}

function shouldSkipTopics(topics) {
  return (topics || []).some(s => SKIP_TOPICS.has(s));
}

function isBigCompany(website, productName = '') {
  if (!website) return false;
  // Root domain check catches subdomains (blog.cloudflare.com → cloudflare.com)
  const rd = rootDomain(website);
  if (rd && BIG_DOMAINS.has(rd)) return true;
  // Full hostname check
  const full = normaliseDomain(website);
  if (full && BIG_DOMAINS.has(full)) return true;
  // Name-based check
  if (productName && BIG_BRAND_RE.test(productName)) return true;
  return false;
}

// ── Maker engagement: check PH page HTML ─────────────────────────────────────
// PH embeds Next.js JSON (window.__NEXT_DATA__) that includes isMakerComment.
// We also fall back to simpler regex patterns.
function checkMakerEngagementInHtml(html) {
  // Strategy 1: Next.js JSON data with isMakerComment:true
  if (/["']isMakerComment["']\s*:\s*true/i.test(html)) return true;
  // Strategy 2: isMaker flag anywhere in JS data
  if (/["']isMaker["']\s*:\s*true/i.test(html)) return true;
  // Strategy 3: "Maker" badge near comment content (PH sometimes renders this)
  const makerBadgeRE = /Maker[\s\S]{0,500}comment|comment[\s\S]{0,500}Maker/i;
  if (makerBadgeRE.test(html)) return true;
  return false;
}

// ── PART A: PH GraphQL API ────────────────────────────────────────────────────
async function fetchViaGraphQL(token, daysBack = 3) {
  const now   = new Date();
  const start = new Date(now - daysBack * 24 * 60 * 60 * 1000);
  const postedAfter  = start.toISOString().slice(0, 10);
  const postedBefore = now.toISOString().slice(0, 10);

  const query = `{
    posts(order: VOTES, first: 80, postedAfter: "${postedAfter}T00:00:00Z", postedBefore: "${postedBefore}T23:59:59Z") {
      edges {
        node {
          id name tagline url website votesCount
          thumbnail { url }
          topics { edges { node { name slug } } }
          comments(first: 30, order: VOTES) {
            edges { node { isMakerComment } }
          }
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

  return edges.map(e => {
    const comments = (e.node.comments?.edges || []).map(c => c.node);
    const hasMakerComment = comments.some(c => c.isMakerComment === true);
    return {
      name:           e.node.name,
      tagline:        e.node.tagline || '',
      phUrl:          e.node.url,
      website:        e.node.website || '',
      logo:           e.node.thumbnail?.url || '',
      votes:          e.node.votesCount || 0,
      topics:         (e.node.topics?.edges || []).map(t => t.node.slug),
      hasMakerComment,
    };
  });
}

// ── PART B: Atom feed + page scraping fallback ────────────────────────────────
async function fetchViaAtom(daysBack = 3) {
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
    const titleM   = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(block);
    const name     = (titleM?.[1] || '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
    const pubM     = /<published[^>]*>([\s\S]*?)<\/published>/i.exec(block);
    const pubDate  = pubM?.[1]?.trim() || '';
    const linkM    = /<link\s[^>]*rel="alternate"[^>]*href="([^"]+)"/i.exec(block);
    const phUrl    = linkM?.[1] || '';
    const idM      = /Post\/(\d+)/.exec(block);
    const postId   = idM?.[1] || '';
    const contentM = /<content[^>]*>([\s\S]*?)<\/content>/i.exec(block);
    const contentRaw = contentM?.[1] || '';
    const tagline  = contentRaw
      .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"')
      .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ')
      .split('Discussion')[0].trim().slice(0, 200);

    if (!name || !phUrl || !postId) continue;
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    try { if (pubDate && new Date(pubDate) < cutoff) continue; } catch {}

    items.push({ name, tagline, phUrl, postId });
  }

  console.log(`[ph-discovery] Atom feed: ${items.length} entries in last ${daysBack} days`);

  // Enrich each entry: get website, logo, topics, AND check maker engagement
  const enriched = [];
  for (const item of items.slice(0, 60)) {
    await sleep(600);
    let website = '', logo = '', topics = [], hasMakerComment = false;

    // Step 1: Follow redirect to get product website
    try {
      const redirectUrl = `https://www.producthunt.com/r/p/${item.postId}?app_id=339`;
      const rr = await fetch(redirectUrl, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ToolIndex/1.0)' },
        signal: AbortSignal.timeout(8000),
      });
      const loc = rr.headers.get('location') || '';
      if (loc && !loc.includes('producthunt.com')) {
        try { website = new URL(loc).origin + new URL(loc).pathname; }
        catch { website = loc.split('?')[0]; }
      }
    } catch {}

    // Step 2: Scrape PH product page for logo, topics, AND maker engagement
    try {
      const r = await timedFetch(item.phUrl, 12000);
      if (r.ok) {
        const html = await r.text();

        // Logo: prefer ph-files.imgix.net, fallback og:image
        const imgixM = /https:\/\/ph-files\.imgix\.net\/[a-f0-9-]+\.[a-z]+(?:\?[^"'\s]*)*/i.exec(html);
        if (imgixM) logo = imgixM[0].split('"')[0];
        if (!logo) {
          const ogM = /property="og:image"\s+content="(https?:\/\/[^"]+)"/.exec(html)
                   || /content="(https?:\/\/[^"]+)"\s+property="og:image"/.exec(html);
          logo = ogM?.[1] || '';
        }

        // Website fallback from page if redirect failed
        if (!website) {
          const visitRE = /href="(https?:\/\/(?!www\.producthunt\.com)[^"?]{10,150})(?:[^"]*)"[^>]*(?:rel="noopener|>Visit|>Launch|Go to site)/i;
          const visitM = visitRE.exec(html);
          if (visitM) website = visitM[1];
        }

        // Topics
        const topicRE = /\/topics\/([a-z0-9-]+)/g;
        let tm; const seenT = new Set();
        while ((tm = topicRE.exec(html)) !== null) {
          if (!seenT.has(tm[1])) { topics.push(tm[1]); seenT.add(tm[1]); }
        }

        // Maker engagement
        hasMakerComment = checkMakerEngagementInHtml(html);
      }
    } catch (e) {
      console.warn(`[ph-discovery] page scrape failed for ${item.phUrl}: ${e.message}`);
    }

    if (website) {
      enriched.push({ ...item, website, logo, topics, votes: 0, hasMakerComment });
    } else {
      console.log(`[ph-discovery] No website found for ${item.name} — skipping`);
    }
  }

  console.log(`[ph-discovery] Enriched: ${enriched.length} items with website`);
  return enriched;
}

// ── Contact extraction (email required before insert) ────────────────────────
async function extractContact(productUrl) {
  const EMAIL_RE    = /\b([a-zA-Z0-9._%+\-]{1,40}@[a-zA-Z0-9.\-]{1,60}\.[a-zA-Z]{2,10})\b/g;
  const SKIP_LOCAL  = /^(noreply|no-reply|donotreply|mailer-daemon|bounce|postmaster|unsubscribe|privacy@example|test|user|name|someone|your|info@example|hello@example|support@example)/i;
  const SKIP_DOMAIN = /example\.|test\.|placeholder\.|sentry\.|mailchimp\.com|sendgrid\.net|amazonaws\.com|wixpress\.com|squarespace\.com|cloudflare\.com|producthunt\.com/i;

  // Also skip obviously generic/legal emails less likely to reach a founder
  const DEPRIORITIZE = /^(abuse|legal|press|noreply|no-reply|privacy|security|dmca|billing|finance|accounting|webmaster|admin)/i;

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
    return `https://www.linkedin.com/${(personal || matches[0])[1]}/${(personal || matches[0])[2]}/`;
  }

  function extractFromHtml(html) {
    const text = clean(html);
    // Priority 1: mailto: hrefs
    const mailtos = [...html.matchAll(/href=["']mailto:([^"'?\s]{3,80})["']/gi)]
      .map(m => m[1].split('?')[0].toLowerCase().trim())
      .filter(e => /^[^@]{1,40}@[^@]{1,60}\.[a-z]{2,10}$/.test(e)
               && !SKIP_LOCAL.test(e) && !SKIP_DOMAIN.test(e));
    // Sort: personal/founder emails before generic
    const sorted = [
      ...mailtos.filter(e => !DEPRIORITIZE.test(e.split('@')[0])),
      ...mailtos.filter(e =>  DEPRIORITIZE.test(e.split('@')[0])),
    ];
    if (sorted.length) return sorted[0];

    // Priority 2: contextual keywords
    const ctxMatches = [...text.matchAll(
      /(?:contact\s+us|email\s+us|reach\s+us|get\s+in\s+touch|write\s+to\s+us|send\s+us\s+an?\s+email|hello@|hi@|hey@|support@|team@|founders?@|maker@|creator@)[\s\S]{0,400}/gi
    )];
    for (const m of ctxMatches) {
      const emails = [...m[0].matchAll(EMAIL_RE)].map(e => e[1].toLowerCase())
        .filter(e => !SKIP_LOCAL.test(e) && !SKIP_DOMAIN.test(e));
      if (emails.length) return emails[0];
    }

    // Priority 3: footer
    const footerHtml = text.match(/<footer[\s\S]{0,8000}/i)?.[0] || text.slice(-5000);
    const footerEmails = [...footerHtml.matchAll(EMAIL_RE)]
      .map(e => e[1].toLowerCase())
      .filter(e => !SKIP_LOCAL.test(e) && !SKIP_DOMAIN.test(e));
    const footerSorted = [
      ...footerEmails.filter(e => !DEPRIORITIZE.test(e.split('@')[0])),
      ...footerEmails.filter(e =>  DEPRIORITIZE.test(e.split('@')[0])),
    ];
    if (footerSorted.length) return footerSorted[0];

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

  const pages = [
    productUrl, `${base}/contact`, `${base}/about`, `${base}/support`,
    `${base}/privacy`, `${base}/terms`, `${base}/tos`, `${base}/imprint`,
  ];

  let foundLinkedIn = null;
  for (const page of pages) {
    try {
      const resp = await timedFetch(page, 10000);
      if (!resp?.ok) { await sleep(800); continue; }
      const html = await resp.text().catch(() => '');
      const email = extractFromHtml(html);
      if (!foundLinkedIn) foundLinkedIn = extractLinkedIn(html);
      if (email) return { email, linkedin: foundLinkedIn, source: page, status: 'found' };
    } catch {}
    await sleep(800);
  }
  if (foundLinkedIn) return { linkedin: foundLinkedIn, status: 'not_found' };
  return { status: 'not_found' };
}

// ── Dedup against both active and draft ──────────────────────────────────────
async function getExistingDomains(pool) {
  const { rows } = await pool.query(
    `SELECT url, name, source_url FROM directory_listings WHERE status IN ('active','draft')`
  );
  const domains = new Set(), names = new Set(), phUrls = new Set();
  for (const r of rows) {
    const d = normaliseDomain(r.url || '');
    if (d) domains.add(d);
    const rd = rootDomain(r.url || '');
    if (rd) domains.add(rd);
    if (r.name) names.add(r.name.toLowerCase().trim());
    if (r.source_url) phUrls.add(r.source_url.toLowerCase().trim());
  }
  return { domains, names, phUrls };
}

function isDuplicate(post, existing) {
  const domain = normaliseDomain(post.website);
  const rd     = rootDomain(post.website);
  if (domain && existing.domains.has(domain)) return true;
  if (rd     && existing.domains.has(rd))     return true;
  if (post.name && existing.names.has(post.name.toLowerCase().trim())) return true;
  if (post.phUrl && existing.phUrls.has(post.phUrl.toLowerCase().trim())) return true;
  return false;
}

// ── Build claim invitation email ──────────────────────────────────────────────
function buildDraftClaimEmail(name, listingUrl) {
  const subject = `Your ${name} listing on ToolIndex is ready — claim it to go live`;

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:32px auto;color:#1a1a2e;line-height:1.7;font-size:15px;">
<p>Hi,</p>
<p>I was browsing Product Hunt launches and noticed <strong>${name}</strong> — so I added it to <a href="https://strategic-flow-audit.replit.app/directory" style="color:#00d4c8;">ToolIndex</a>, our SaaS directory with a DR&nbsp;86 backlink from <strong>strategicflow.tech</strong>.</p>
<p>It's currently a <strong>private draft</strong> — only you can see it. Claiming it (takes ~60 seconds) makes it public and locks in your free dofollow backlink. You can edit the description, logo, and links after.</p>
<p style="margin:28px 0;"><a href="${listingUrl}" style="display:inline-block;background:#00d4c8;color:#0a1628;padding:13px 28px;text-decoration:none;font-weight:700;border-radius:6px;font-size:15px;">Claim your listing free &rarr;</a></p>
<p style="font-size:13px;color:#64748b;">If this isn't your product, no action needed — the draft will stay private.</p>
<p style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:13px;color:#555;line-height:2;"><strong>Alex Iliescu</strong><br>Strategic Flow — <a href="https://strategicflow.tech" style="color:#00d4c8;">strategicflow.tech</a><br>ToolIndex — <a href="https://strategic-flow-audit.replit.app/directory" style="color:#00d4c8;">strategic-flow-audit.replit.app/directory</a><br>LinkedIn: <a href="https://www.linkedin.com/in/strategic-flow-tech" style="color:#00d4c8;">linkedin.com/in/strategic-flow-tech</a><br>Tenerife, Spain</p>
<p style="font-size:11px;color:#9ca3af;">Reply to unsubscribe from future messages.</p>
</div>`;

  const text = `Hi,

I was browsing Product Hunt launches and noticed ${name} — so I added it to ToolIndex, our SaaS directory with a DR 86 backlink from strategicflow.tech.

It's currently a private draft — only you can see it. Claiming it (takes ~60 seconds) makes it public and locks in your free dofollow backlink. You can edit everything after.

Claim your listing free: ${listingUrl}

If this isn't your product, no action needed — the draft stays private.

--
Alex Iliescu
Strategic Flow — strategicflow.tech
ToolIndex — https://strategic-flow-audit.replit.app/directory
LinkedIn: https://www.linkedin.com/in/strategic-flow-tech
Tenerife, Spain

Reply to unsubscribe.`;

  return { subject, html, text };
}

// ── Main unified pipeline ─────────────────────────────────────────────────────
/**
 * runDailyPHDiscovery(pool, log, opts)
 *
 * opts:
 *   resend       — Resend client instance (required for email sending)
 *   SENDER       — from address string (required for email sending)
 *   enrichFn     — optional: async (listing, pool, claudeJsonFn) => void
 *   claudeJsonFn — optional: passed to enrichFn
 *   dryRun       — if true: go through all filtering but skip DB insert + email
 *   limit        — max products to insert (default: 25)
 */
async function runDailyPHDiscovery(pool, log = console.log, opts = {}) {
  const LIMIT = opts.limit || 25;
  log(`[ph-discovery] Starting unified daily PH discovery (target: ${LIMIT}/day)…`);

  // 1. Fetch posts (last 3 days)
  let posts = [];
  const token = process.env.PRODUCT_HUNT_TOKEN;
  try {
    if (token) {
      log('[ph-discovery] Using PH GraphQL API (3-day window, with comments)');
      posts = await fetchViaGraphQL(token, 3);
    } else {
      log('[ph-discovery] No PRODUCT_HUNT_TOKEN — using Atom feed + page scraping (3-day window)');
      posts = await fetchViaAtom(3);
    }
    log(`[ph-discovery] Fetched ${posts.length} raw posts`);
  } catch (e) {
    log(`[ph-discovery] ERROR fetching PH data: ${e.message}`);
    return { inserted: 0, error: e.message };
  }

  // 2. Basic filters: category, big company/brand, real website
  const stats = { total: posts.length, skipCategory: 0, skipBig: 0, skipNoSite: 0, skipDupe: 0, skipNoMaker: 0, skipNoEmail: 0, inserted: 0 };

  let candidates = posts.filter(p => {
    if (shouldSkipTopics(p.topics || [])) { stats.skipCategory++; return false; }
    p._category = mapCategory(p.topics || []);
    return true;
  });

  candidates = candidates.filter(p => {
    if (isBigCompany(p.website || '', p.name || '')) {
      log(`[ph-discovery] Skip big company: ${p.name}`);
      stats.skipBig++;
      return false;
    }
    return true;
  });

  candidates = candidates.filter(p => {
    const ws = (p.website || '').trim();
    if (!ws || ws === p.phUrl) { stats.skipNoSite++; return false; }
    try { new URL(ws); return true; } catch { stats.skipNoSite++; return false; }
  });

  log(`[ph-discovery] After basic filters: ${candidates.length} (skipped: ${stats.skipCategory} category, ${stats.skipBig} big company, ${stats.skipNoSite} no site)`);

  // 3. Dedup against DB
  const existing = await getExistingDomains(pool);
  candidates = candidates.filter(p => {
    if (isDuplicate(p, existing)) { stats.skipDupe++; return false; }
    return true;
  });
  log(`[ph-discovery] After dedup: ${candidates.length} fresh candidates (${stats.skipDupe} already in DB)`);

  // 4. Sort by votes desc (higher votes = better signal), prioritise those with logos
  candidates.sort((a, b) => {
    const sA = (a.votes || 0) * 2 + (a.logo ? 5 : 0) + (a.hasMakerComment ? 10 : 0);
    const sB = (b.votes || 0) * 2 + (b.logo ? 5 : 0) + (b.hasMakerComment ? 10 : 0);
    return sB - sA;
  });

  // 5. Per-candidate: check maker engagement + extract email, then insert
  const inserted = [];
  for (const post of candidates) {
    if (inserted.length >= LIMIT) break;

    log(`[ph-discovery] Processing: ${post.name} (${post.website})`);

    // ── Filter 1: Maker engagement ────────────────────────────────────────────
    // GraphQL path already has hasMakerComment; Atom path set it during page scrape.
    // For GraphQL path without comment data (older token), re-check via page scrape.
    let makerEngaged = post.hasMakerComment === true;

    if (!makerEngaged && token) {
      // GraphQL returned hasMakerComment=false. Double-check via page scrape for robustness.
      try {
        const r = await timedFetch(post.phUrl, 10000);
        if (r.ok) {
          const html = await r.text();
          makerEngaged = checkMakerEngagementInHtml(html);
        }
      } catch {}
    }

    if (!makerEngaged) {
      log(`[ph-discovery]   → SKIP (maker not active in comments): ${post.name}`);
      stats.skipNoMaker++;
      await sleep(300);
      continue;
    }
    log(`[ph-discovery]   → Maker is active in comments ✓`);

    // ── Filter 2: Contact email ───────────────────────────────────────────────
    let email = null, linkedin = null, emailStatus = 'not_found', emailSource = null;
    try {
      const contact = await extractContact(post.website);
      email       = contact.email   || null;
      linkedin    = contact.linkedin || null;
      emailStatus = contact.status  || 'not_found';
      emailSource = contact.source  || null;
      log(`[ph-discovery]   → email: ${email || '—'} | linkedin: ${linkedin || '—'}`);
    } catch (e) {
      log(`[ph-discovery]   → contact extraction error: ${e.message}`);
    }

    if (!email) {
      log(`[ph-discovery]   → SKIP (no public contact email found): ${post.name}`);
      stats.skipNoEmail++;
      await sleep(500);
      continue;
    }

    // ── All criteria passed — insert as draft ─────────────────────────────────
    if (opts.dryRun) {
      log(`[ph-discovery]   → DRY RUN: would insert ${post.name} → ${email}`);
      inserted.push({ name: post.name, url: post.website, email, dryRun: true });
      continue;
    }

    const desc     = (post.tagline || '').slice(0, 160).trim();
    const category = post._category || 'Other';
    const logo     = post.logo || '';

    try {
      const r = await pool.query(
        `INSERT INTO directory_listings
           (name, url, category, description, image_url,
            source, source_url, status, vote_count, score_pending,
            is_seeded, is_auto_imported,
            contact_email, contact_email_status, contact_email_source, contact_email_fetched_at,
            social_linkedin)
         VALUES ($1,$2,$3,$4,$5,'Product Hunt',$6,'draft',0,true,false,true,$7,$8,$9,NOW(),$10)
         ON CONFLICT DO NOTHING
         RETURNING id, name`,
        [
          post.name, post.website, category, desc, logo,
          post.phUrl,
          email, emailStatus, emailSource,
          linkedin,
        ]
      );

      if (!r.rows.length) {
        log(`[ph-discovery]   → CONFLICT (already exists): ${post.name}`);
        await sleep(500);
        continue;
      }

      const newId = r.rows[0].id;
      const name  = r.rows[0].name;
      log(`[ph-discovery]   → Inserted draft id=${newId}: ${name}`);

      // ── Send claim invitation email ───────────────────────────────────────
      let emailSent = false;
      if (opts.resend && opts.SENDER) {
        const slugStr    = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + newId;
        const listingUrl = `https://strategic-flow-audit.replit.app/directory/${slugStr}`;
        const { subject, html: htmlBody, text: textBody } = buildDraftClaimEmail(name, listingUrl);

        try {
          await opts.resend.emails.send({
            from:    opts.SENDER,
            to:      email,
            replyTo: 'strategicflow@proton.me',
            subject,
            html:    htmlBody,
            text:    textBody,
          });
          await pool.query(
            `UPDATE directory_listings SET outreach_emailed_at=NOW() WHERE id=$1`,
            [newId]
          );
          log(`[ph-discovery]   → ✉ Claim email sent → ${email}`);
          emailSent = true;
        } catch (emailErr) {
          // Check for Resend quota
          const isQuota = emailErr.statusCode === 429
            || /rate.?limit|quota|daily.?limit|too many/i.test(emailErr.message || '');
          if (isQuota) {
            log(`[ph-discovery]   → Resend quota hit — stopping email sends for today`);
            inserted.push({ id: newId, name, url: post.website, email, emailSent: false });
            break; // Stop the loop — quota exhausted
          }
          log(`[ph-discovery]   → Email send failed for ${name}: ${emailErr.message}`);
        }
      } else {
        log(`[ph-discovery]   → No resend/SENDER configured — skipping email`);
      }

      inserted.push({ id: newId, name, url: post.website, email, emailSent });

    } catch (e) {
      log(`[ph-discovery]   → DB insert error for ${post.name}: ${e.message}`);
    }

    await sleep(2000);
  }

  // 6. Optional AI enrichment
  const toEnrich = inserted.filter(l => l.id && typeof opts.enrichFn === 'function');
  if (toEnrich.length) {
    log(`[ph-discovery] AI enrichment for ${toEnrich.length} new listings…`);
    for (const listing of toEnrich) {
      await sleep(2000);
      try {
        await opts.enrichFn(listing, pool, opts.claudeJsonFn);
        log(`[ph-discovery]   → AI insights stored: ${listing.name}`);
      } catch (e) {
        log(`[ph-discovery]   → AI enrichment failed for ${listing.name}: ${e.message}`);
      }
    }
  }

  const emailsSent = inserted.filter(l => l.emailSent).length;
  log(`[ph-discovery] Done. Evaluated: ${stats.total} | Inserted: ${inserted.length} | Emails sent: ${emailsSent}`);
  log(`[ph-discovery] Skip breakdown — category: ${stats.skipCategory}, big co: ${stats.skipBig}, no site: ${stats.skipNoSite}, dupe: ${stats.skipDupe}, no maker engagement: ${stats.skipNoMaker}, no email: ${stats.skipNoEmail}`);

  return {
    inserted: inserted.length,
    emailsSent,
    listings: inserted,
    stats,
  };
}

module.exports = { runDailyPHDiscovery };

'use strict';
/**
 * ph-discovery.js — Unified daily Product Hunt discovery pipeline (v2)
 *
 * Single job, runs once daily. A product is included only if ALL three hold:
 *   1. Posted on PH within the last 3 days
 *   2. Has a discoverable public contact email (extracted from product site)
 *   3. commentsCount >= 5 (engagement proxy — PH API does not expose isMakerComment)
 *
 * Two insertion tracks (processed in order from highest votes):
 *   • "daily"  — top DAILY_LIMIT (default 10): inserted as status='active' (live in directory),
 *                founder gets a "you're live + paid options" notification email immediately.
 *   • "draft"  — next DRAFT_LIMIT (default 25): inserted as status='draft' (hidden),
 *                founder gets a claim-invitation email immediately.
 *
 * Both tracks email on insert → outreach queue stays clean (no pending rows to re-process).
 *
 * Data source:
 *   - PH GraphQL API (PRODUCT_HUNT_TOKEN) — preferred
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

// Known big-company ROOT domains (stripped of subdomains).
// Add any domain here whose company is funded/established enough that they
// don't need (or wouldn't care about) a free indie-directory backlink.
const BIG_DOMAINS = new Set([
  // Big tech
  'google.com', 'apple.com', 'microsoft.com', 'amazon.com', 'meta.com',
  'facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 'netflix.com',
  'salesforce.com', 'oracle.com', 'ibm.com', 'sap.com', 'adobe.com',
  'nvidia.com', 'intel.com', 'qualcomm.com', 'cisco.com', 'dell.com',
  'samsung.com', 'sony.com', 'lg.com',
  // Dev/infra
  'atlassian.com', 'github.com', 'gitlab.com', 'docker.com', 'hashicorp.com',
  'cloudflare.com', 'heroku.com', 'vercel.com', 'netlify.com',
  'elastic.co', 'mongodb.com', 'redis.com', 'snowflake.com', 'databricks.com',
  'datadog.com', 'splunk.com', 'pagerduty.com', 'newrelic.com',
  // AI — funded/established
  'openai.com', 'anthropic.com', 'mistral.ai', 'la-plateforme.ai',
  'cohere.com', 'huggingface.co', 'stability.ai', 'midjourney.com',
  'runway.ml', 'runwayml.com', 'perplexity.ai', 'replicate.com',
  'together.ai', 'groq.com', 'inflection.ai', 'xai.com', 'character.ai',
  'elevenlabs.io', 'jasper.ai', 'copy.ai', 'writesonic.com',
  // Collaboration / productivity
  'slack.com', 'zoom.us', 'notion.so', 'figma.com', 'canva.com',
  'dropbox.com', 'box.com', 'airtable.com', 'monday.com', 'asana.com',
  'clickup.com', 'trello.com', 'basecamp.com', 'linear.app',
  // Marketing / CRM
  'hubspot.com', 'zendesk.com', 'intercom.com', 'mailchimp.com',
  'calendly.com', 'typeform.com', 'webflow.com',
  // E-commerce / payments
  'shopify.com', 'stripe.com', 'paypal.com', 'visa.com', 'mastercard.com',
  'square.com', 'braintreepayments.com',
  // Hosting / publishing
  'wordpress.com', 'squarespace.com', 'wix.com', 'godaddy.com',
  'substack.com', 'medium.com',
  // Social / media
  'discord.com', 'twitch.tv', 'spotify.com', 'tiktok.com',
  'pinterest.com', 'reddit.com', 'quora.com',
  // SaaS
  'twilio.com', 'zapier.com', 'okta.com', 'workday.com', 'servicenow.com',
  'crowdstrike.com', 'zscaler.com', 'pendo.io', 'amplitude.com',
  'mixpanel.com', 'segment.com', 'braze.com', 'klaviyo.com',
  // Recruiting / HR
  'dover.com', 'rippling.com', 'gusto.com', 'bamboohr.com', 'greenhouse.io',
  'lever.co', 'ashbyhq.com', 'gem.com', 'workable.com',
  // Sales
  'gong.io', 'salesloft.com', 'outreach.io', 'apollo.io',
  'zoominfo.com', 'clearbit.com', 'seamless.ai',
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
// NOTE: This heuristic is the fallback used when PRODUCT_HUNT_TOKEN is not set.
// It parses PH's Next.js __NEXT_DATA__ JSON and looks for isMakerComment:true
// inside the comments array specifically — NOT the broader isMaker profile flag
// (which is true for every maker on the platform, not just those who replied).
// Even with this improvement, false positives are possible. Set PRODUCT_HUNT_TOKEN
// for the authoritative GraphQL check.
// makerUsernames: optional array of known maker usernames from GraphQL (for extra signal)
function checkMakerEngagementInHtml(html, makerUsernames = []) {
  // Strategy 1: Extract and parse PH's __NEXT_DATA__ JSON blob.
  // PH embeds the full post data (including comment metadata) here via Next.js.
  const nextDataMatch = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]+?)<\/script>/i.exec(html);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const str  = JSON.stringify(data);
      // ONLY match "isMakerComment":true — the per-comment field.
      // Do NOT match "isMaker":true (that's a maker profile flag, always true for any maker).
      if (/"isMakerComment"\s*:\s*true/.test(str)) return true;
      // __NEXT_DATA__ parsed cleanly → treat as authoritative: no maker comment found.
      // Also check supplementary: known maker username appearing in a comment block.
      if (makerUsernames.length) {
        // Look for username inside a comment-like JSON context (not just anywhere on page)
        // Pattern: "username":"alice" appearing within 2000 chars of a "body": field
        for (const u of makerUsernames) {
          const escaped = u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (new RegExp(`"body"[^}]{0,2000}"username"\\s*:\\s*"${escaped}"`).test(str) ||
              new RegExp(`"username"\\s*:\\s*"${escaped}"[^}]{0,2000}"body"`).test(str)) {
            return true;
          }
        }
      }
      return false;
    } catch {
      // JSON parse failed — fall through to raw regex
    }
  }

  // Strategy 2: Raw HTML regex fallback (only if __NEXT_DATA__ extraction failed).
  if (/"isMakerComment"\s*:\s*true/.test(html)) return true;
  return false;
}

// ── PART A: PH GraphQL API ────────────────────────────────────────────────────
async function fetchViaGraphQL(token, daysBack = 3) {
  const now   = new Date();
  const start = new Date(now - daysBack * 24 * 60 * 60 * 1000);
  // PH GraphQL requires YYYY-MM-DD date strings — full ISO timestamps return 0 results
  const postedAfter = start.toISOString().slice(0, 10);

  // PH GraphQL v2 limitations:
  //   - isMakerComment does not exist on Comment type
  //   - comment user IDs are redacted (id:"0") — cross-reference impossible
  // Maker engagement proxy: commentsCount >= 5.
  // A product with 5+ community comments almost always has the maker responding.
  // first:40 stays under the 500k complexity cap.
  const query = `{
    posts(order: VOTES, first: 40, postedAfter: "${postedAfter}") {
      edges {
        node {
          id name tagline url website votesCount commentsCount
          thumbnail { url }
          topics { edges { node { slug } } }
        }
      }
    }
  }`;
  // NOTE: post.id is numeric (e.g., 1214897) and used to build the
  // /r/p/{id}?app_id=339 redirect URL which bypasses Cloudflare bot protection
  // (unlike the /r/XXXXX?utm_campaign=... format returned by GraphQL's `website` field).

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
  if (data.errors?.length) {
    throw new Error(`PH GraphQL errors: ${data.errors.map(e => e.message).join('; ')}`);
  }
  const edges = data?.data?.posts?.edges || [];

  return edges.map(e => ({
    id:              e.node.id,       // numeric post ID — used for /r/p/{id} redirect
    name:            e.node.name,
    tagline:         e.node.tagline || '',
    phUrl:           e.node.url,
    website:         e.node.website || '',
    logo:            e.node.thumbnail?.url || '',
    votes:           e.node.votesCount || 0,
    commentsCount:   e.node.commentsCount || 0,
    topics:          (e.node.topics?.edges || []).map(t => t.node.slug),
    // Proxy: commentsCount >= 5 → likely active discussion with maker responding
    hasMakerComment: (e.node.commentsCount || 0) >= 5,
  }));
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

        // Maker engagement proxy: extract commentsCount from page JSON
        // PH embeds Apollo/window state with "commentsCount":N in the HTML
        const ccMatch = /"commentsCount"\s*:\s*(\d+)/.exec(html);
        const cc = ccMatch ? parseInt(ccMatch[1], 10) : 0;
        hasMakerComment = cc >= 5;
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

// ── Email: "you're live on ToolIndex + paid options" (for daily/active track) ──
function buildDailyLiveEmail(name, listingUrl) {
  const subject = `${name} is live on ToolIndex (DR 86) — here's how to boost it`;

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:32px auto;color:#1a1a2e;line-height:1.7;font-size:15px;">
<p>Hi,</p>
<p>Good news — <strong>${name}</strong> is now <strong>live on <a href="https://strategic-flow-audit.replit.app/directory" style="color:#00d4c8;">ToolIndex</a></strong>, our SaaS directory hosted on a DR&nbsp;86 domain. Your listing includes a permanent dofollow backlink from <strong>strategicflow.tech</strong>.</p>
<p style="margin:28px 0;"><a href="${listingUrl}" style="display:inline-block;background:#00d4c8;color:#0a1628;padding:13px 28px;text-decoration:none;font-weight:700;border-radius:6px;font-size:15px;">View your live listing &rarr;</a></p>

<p style="margin:0 0 8px;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#9ca3af;">Want more visibility?</p>
<table style="width:100%;border-collapse:collapse;font-size:14px;">
  <tr style="background:#f9fafb;">
    <td style="padding:10px 14px;border:1px solid #e5e7eb;font-weight:700;">Featured placement</td>
    <td style="padding:10px 14px;border:1px solid #e5e7eb;color:#374151;">Pin your listing at the top of your category. Starts at <strong>$9/mo</strong>.</td>
  </tr>
  <tr>
    <td style="padding:10px 14px;border:1px solid #e5e7eb;font-weight:700;">Daily boost</td>
    <td style="padding:10px 14px;border:1px solid #e5e7eb;color:#374151;">Appear in the marquee + homepage spotlight for 24 hours. <strong>$29/day</strong>.</td>
  </tr>
  <tr style="background:#f9fafb;">
    <td style="padding:10px 14px;border:1px solid #e5e7eb;font-weight:700;">Claim &amp; edit</td>
    <td style="padding:10px 14px;border:1px solid #e5e7eb;color:#374151;">Update your description, logo, and links — <strong>free</strong>. Verify in 60 sec.</td>
  </tr>
</table>

<p style="margin:24px 0 0;font-size:14px;color:#374151;">All options are at <a href="${listingUrl}" style="color:#00d4c8;">your listing page</a> — scroll to the Boost section. Reply to this email if you have questions.</p>

<p style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:13px;color:#555;line-height:2;"><strong>Alex Iliescu</strong><br>Strategic Flow — <a href="https://strategicflow.tech" style="color:#00d4c8;">strategicflow.tech</a><br>ToolIndex — <a href="https://strategic-flow-audit.replit.app/directory" style="color:#00d4c8;">strategic-flow-audit.replit.app/directory</a><br>LinkedIn: <a href="https://www.linkedin.com/in/strategic-flow-tech" style="color:#00d4c8;">linkedin.com/in/strategic-flow-tech</a><br>Tenerife, Spain</p>
<p style="font-size:11px;color:#9ca3af;">Reply to unsubscribe from future messages.</p>
</div>`;

  const text = `Hi,

${name} is now live on ToolIndex — our SaaS directory on a DR 86 domain (strategicflow.tech). Your listing includes a permanent dofollow backlink.

View your listing: ${listingUrl}

Want more visibility?
- Featured placement: pin your listing at the top of your category. From $9/mo.
- Daily boost: appear in the marquee + homepage spotlight for 24 hours. $29/day.
- Claim & edit: update description, logo, links for free. Takes 60 seconds.

All options are on your listing page — scroll to the Boost section.

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
 *   dailyLimit   — max products to insert as active with upsell email (default: 10)
 *   draftLimit   — max products to insert as draft with claim email (default: 25)
 */
async function runDailyPHDiscovery(pool, log = console.log, opts = {}) {
  const DAILY_LIMIT = opts.dailyLimit ?? 10;
  const DRAFT_LIMIT = opts.draftLimit ?? 25;
  const LIMIT = DAILY_LIMIT + DRAFT_LIMIT;
  log(`[ph-discovery] Starting unified daily PH discovery (daily/active: ${DAILY_LIMIT}, draft: ${DRAFT_LIMIT})…`);

  // 1. Fetch posts (last 3 days)
  let posts = [];
  const token = process.env.PRODUCT_HUNT_TOKEN;
  try {
    if (token) {
      log('[ph-discovery] PH GraphQL API active (3-day window, YYYY-MM-DD filter).');
      log('[ph-discovery] Maker engagement proxy: commentsCount >= 5 (PH API does not expose isMakerComment).');
      posts = await fetchViaGraphQL(token, 3);
    } else {
      log('[ph-discovery] ⚠ WARNING: PRODUCT_HUNT_TOKEN not set — falling back to Atom feed.');
      log('[ph-discovery] ⚠ Maker engagement checked via __NEXT_DATA__ page scrape (same as token path).');
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
  //    Track A (daily):  first DAILY_LIMIT passing candidates → status='active' + upsell email
  //    Track B (draft):  next  DRAFT_LIMIT passing candidates → status='draft'  + claim email
  const inserted = [];   // all successfully inserted records
  let dailyCount = 0;    // how many inserted into the "daily/active" track
  let draftCount = 0;    // how many inserted into the "draft" track
  let quotaHit   = false;

  for (const post of candidates) {
    if (dailyCount >= DAILY_LIMIT && draftCount >= DRAFT_LIMIT) break;
    if (quotaHit) break;

    // Determine which track this candidate will go into (if it passes filters)
    // Daily track fills first (higher signal products go live immediately)
    const targetTrack = dailyCount < DAILY_LIMIT ? 'daily' : 'draft';

    log(`[ph-discovery] Processing [${targetTrack}]: ${post.name} (${post.website})`);

    // ── Resolve real product website ──────────────────────────────────────────
    // GraphQL's `website` field returns PH tracking redirects (/r/XXXXX?utm_campaign=...)
    // which are blocked by Cloudflare bot protection (403 + cf-mitigated: challenge).
    // The /r/p/{id}?app_id=339 format used by the Atom feed is NOT Cloudflare-protected
    // and returns a clean 301 redirect to the real product website.
    if (!post.website || post.website.includes('producthunt.com')) {
      let resolved = false;

      // Primary: use /r/p/{numeric-id}?app_id=339 (bypasses Cloudflare on most products)
      if (post.id) {
        const resolveUrl = `https://www.producthunt.com/r/p/${post.id}?app_id=339`;
        try {
          const rr = await fetch(resolveUrl, {
            redirect: 'manual',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ToolIndex/1.0)' },
            signal: AbortSignal.timeout(10000),
          });
          const loc = rr.headers.get('location') || '';
          if (loc && !loc.includes('producthunt.com')) {
            post.website = loc.split('?')[0].replace(/\/$/, '');
            log(`[ph-discovery]   → resolved website (/r/p/${post.id}): ${post.website}`);
            resolved = true;
          } else if (rr.status === 403) {
            log(`[ph-discovery]   → /r/p/${post.id} blocked (403) — product site has strict bot protection`);
          }
        } catch(e) {
          log(`[ph-discovery]   → /r/p/${post.id} fetch error: ${e.message}`);
        }
      }

      // Fallback: follow redirect chain on the GraphQL website URL
      if (!resolved && post.website) {
        try {
          const rr = await fetch(post.website, {
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ToolIndex/1.0)' },
            signal: AbortSignal.timeout(10000),
          });
          if (rr.ok && rr.url && !rr.url.includes('producthunt.com')) {
            post.website = rr.url.split('?')[0].replace(/\/$/, '');
            log(`[ph-discovery]   → resolved website (follow): ${post.website}`);
            resolved = true;
          }
        } catch {}
      }
    }

    // Re-check big company with resolved domain
    if (isBigCompany(post.website, post.name)) {
      log(`[ph-discovery]   → SKIP (big company after domain resolve): ${post.name} → ${post.website}`);
      stats.skipBig++;
      await sleep(300);
      continue;
    }

    // ── Maker engagement proxy: commentsCount >= 5 ───────────────────────────
    // PH GraphQL v2 does not expose isMakerComment; commentsCount >= 5 is the
    // best available signal that meaningful discussion exists on the launch thread.
    const makerEngaged = post.hasMakerComment === true;
    if (!makerEngaged) {
      log(`[ph-discovery]   → SKIP (commentsCount < 5, low engagement): ${post.name} (${post.commentsCount ?? 0} comments)`);
      stats.skipNoMaker++;
      await sleep(300);
      continue;
    }
    log(`[ph-discovery]   → Active discussion ✓ (${post.commentsCount ?? '?'} comments)`);

    if (!post.website || post.website.includes('producthunt.com')) {
      log(`[ph-discovery]   → SKIP (could not resolve real product website): ${post.name}`);
      stats.skipNoSite++;
      await sleep(300);
      continue;
    }

    // ── Contact email ─────────────────────────────────────────────────────────
    // Daily/active track: email is OPTIONAL — listing goes live regardless.
    //   Email is used only to send the founder notification; no email = no email sent.
    // Draft track: email is REQUIRED — the listing is hidden; without email we
    //   cannot invite the founder to claim it (the whole point of the draft track).
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

    if (!email && targetTrack === 'draft') {
      log(`[ph-discovery]   → SKIP (no contact email — draft track requires it): ${post.name}`);
      stats.skipNoEmail++;
      await sleep(500);
      continue;
    }
    if (!email) {
      log(`[ph-discovery]   → No email found — inserting as active without notification: ${post.name}`);
    }

    // ── Dry run ───────────────────────────────────────────────────────────────
    if (opts.dryRun) {
      log(`[ph-discovery]   → DRY RUN [${targetTrack}]: would insert ${post.name} → ${email || '(no email)'}`);
      inserted.push({ name: post.name, url: post.website, email, track: targetTrack, dryRun: true });
      if (targetTrack === 'daily') dailyCount++; else draftCount++;
      continue;
    }

    const desc     = (post.tagline || '').slice(0, 160).trim();
    const category = post._category || 'Other';
    const logo     = post.logo || '';
    // Daily track: insert as 'active' (visible in directory immediately)
    // Draft track: insert as 'draft'  (hidden until claimed)
    const insertStatus = targetTrack === 'daily' ? 'active' : 'draft';

    try {
      const r = await pool.query(
        `INSERT INTO directory_listings
           (name, url, category, description, image_url,
            source, source_url, status, vote_count, score_pending,
            is_seeded, is_auto_imported,
            contact_email, contact_email_status, contact_email_source, contact_email_fetched_at,
            social_linkedin)
         VALUES ($1,$2,$3,$4,$5,'Product Hunt',$6,$7,0,true,false,true,$8,$9,$10,NOW(),$11)
         ON CONFLICT DO NOTHING
         RETURNING id, name`,
        [
          post.name, post.website, category, desc, logo,
          post.phUrl, insertStatus,
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
      log(`[ph-discovery]   → Inserted [${insertStatus}] id=${newId}: ${name}`);

      // ── Send the right email for each track ──────────────────────────────────
      let emailSent = false;
      if (opts.resend && opts.SENDER) {
        const slugStr    = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + newId;
        const listingUrl = `https://strategic-flow-audit.replit.app/directory/${slugStr}`;

        const { subject, html: htmlBody, text: textBody } = targetTrack === 'daily'
          ? buildDailyLiveEmail(name, listingUrl)   // "you're live + paid options"
          : buildDraftClaimEmail(name, listingUrl);  // "private draft — claim it"

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
          log(`[ph-discovery]   → ✉ ${targetTrack === 'daily' ? 'Live notification' : 'Claim'} email sent → ${email}`);
          emailSent = true;
        } catch (emailErr) {
          const isQuota = emailErr.statusCode === 429
            || /rate.?limit|quota|daily.?limit|too many/i.test(emailErr.message || '');
          if (isQuota) {
            log(`[ph-discovery]   → Resend quota hit — stopping email sends for today`);
            inserted.push({ id: newId, name, url: post.website, email, track: targetTrack, emailSent: false });
            if (targetTrack === 'daily') dailyCount++; else draftCount++;
            quotaHit = true;
            break;
          }
          log(`[ph-discovery]   → Email send failed for ${name}: ${emailErr.message}`);
        }
      } else {
        log(`[ph-discovery]   → No resend/SENDER configured — skipping email`);
      }

      inserted.push({ id: newId, name, url: post.website, email, track: targetTrack, emailSent });
      if (targetTrack === 'daily') dailyCount++; else draftCount++;

    } catch (e) {
      log(`[ph-discovery]   → DB insert error for ${post.name}: ${e.message}`);
    }

    await sleep(2000);
  }

  // 6. Optional AI enrichment (both tracks)
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
  const dailyInserted = inserted.filter(l => l.track === 'daily').length;
  const draftInserted = inserted.filter(l => l.track === 'draft').length;
  log(`[ph-discovery] Done. Evaluated: ${stats.total} | Active (daily): ${dailyInserted} | Draft: ${draftInserted} | Emails sent: ${emailsSent}`);
  log(`[ph-discovery] Skip breakdown — category: ${stats.skipCategory}, big co: ${stats.skipBig}, no site: ${stats.skipNoSite}, dupe: ${stats.skipDupe}, no maker engagement: ${stats.skipNoMaker}, no email: ${stats.skipNoEmail}`);

  return {
    inserted: inserted.length,
    dailyInserted,
    draftInserted,
    emailsSent,
    listings: inserted,
    stats,
  };
}

module.exports = { runDailyPHDiscovery, buildDailyLiveEmail, buildDraftClaimEmail };

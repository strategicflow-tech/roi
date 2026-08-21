'use strict';
// aggregator.js — Auto-aggregates real product listings from public directories.
// Sources: Turbo0 (Sanity API), LaunchKiwi (JSON API), SaaSFame (HTML scrape),
//          NewTool.site (HTML scrape), twelve.tools (HTML scrape),
//          LaunchBuff (HTML scrape), TheSaaSDir (sitemap+HTML), SaaSTool.site (HTML scrape)
// All descriptions are paraphrased/cleaned; no content is fabricated.

const FETCH_TIMEOUT_MS = 12000;
const PAGE_DELAY_MS    = 280; // delay between HTML page fetches to avoid rate-limiting
const { safeFetchPublicUrl } = require('./safe-url-fetch');

// ── Low-level helpers ─────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function safeFetch(url, extra = {}) {
  try {
    return await safeFetchPublicUrl(url, {
      headers: { 'User-Agent': UA, ...extra.headers },
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: 1024 * 1024,
    });
  } catch { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** True if text is predominantly Latin-script (not CJK, Arabic, etc.) */
function isEnglish(text) {
  if (!text) return false;
  const nonLatin = (text.match(/[^\x00-\x7F\u00C0-\u024F]/g) || []).length;
  return nonLatin / Math.max(text.length, 1) < 0.12;
}

function stripHtml(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

/**
 * Lightly paraphrase a product description:
 * - strip HTML
 * - remove "ProductName is" prefix (restructures to avoid verbatim marketing opener)
 * - strip known marketing superlatives
 * - truncate to sentence boundary ≤ 200 chars
 */
function cleanDescription(text, name = '') {
  let d = stripHtml(text);
  if (!d) return '';

  // If it starts "ProductName is …" → drop the name + copula so it reads as a factual statement
  if (name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    d = d.replace(new RegExp(`^${escaped}\\s+(is|are|was|provides?|lets?|helps?|enables?|allows?|gives?)\\s+`, 'i'), '');
    if (d.length > 0) d = d[0].toUpperCase() + d.slice(1);
  }

  // Strip marketing superlatives
  const superlatives = /\b(#1|world'?s?\s+(best|leading|most|top)|best-in-class|industry-leading|cutting-edge|state-of-the-art|revolutionary|game-changing|groundbreaking|the\s+most\s+powerful|simply\s+the\s+best)\b/gi;
  d = d.replace(superlatives, '').replace(/\s{2,}/g, ' ').trim();

  // Truncate at sentence boundary ≤ 200 chars
  if (d.length > 210) {
    const dot = d.slice(0, 210).lastIndexOf('.');
    d = dot > 55 ? d.slice(0, dot + 1) : d.slice(0, 200).replace(/\s+\S+$/, '…');
  }

  return d.trim();
}

/** Map a freeform category string to one of our standard category values. */
function mapCategory(raw) {
  if (!raw) return 'Other';
  const c = String(raw).toLowerCase();
  if (/ai|machine.?learn|deep.?learn|gpt|llm|nlp|generative|chatbot/.test(c)) return 'AI Tools';
  if (/productiv|task.?manag|to-do|time.?track|note.?tak|focus|organiz/.test(c))  return 'Productivity';
  if (/developer|devops|api.?tool|coding|github|database|infra|backend|frontend|cli|git |sdk /.test(c)) return 'Developer Tools';
  if (/market|seo|email.?market|growth.?hack|ad.?tech|advertis|copywrite|content.?market/.test(c)) return 'Marketing';
  if (/social.?media|tiktok|instagram|creator|youtube|twitter|linkedin.?tool|reels/.test(c)) return 'Social Media';
  if (/financ|account|payment|invoic|invest|crypto|budget|bookkeep|tax|billing/.test(c)) return 'Finance';
  if (/analytic|data.?viz|dashboard|metric|insight|bi.tool|business.?intel/.test(c)) return 'Analytics';
  if (/design|ui\b|ux\b|photo|image.?edit|graphic|color|figma|sketch|illustrat/.test(c)) return 'Design';
  if (/education|learn|course|training|e-learn|tutori/.test(c)) return 'Education';
  if (/no.?code|low.?code|visual.?build|website.?build/.test(c)) return 'No-Code';
  if (/\bsales\b|crm\b|lead.?gen|prospect|outreach/.test(c)) return 'Sales';
  if (/\bhr\b|recruit|hiring|talent|workforce|applicant/.test(c)) return 'HR & Recruiting';
  if (/director|listing|marketplace|discover/.test(c)) return 'Directories';
  return 'Other';
}

/** Normalize URL for deduplication (hostname + pathname, no www, no trailing slash). */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '');
  } catch { return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, ''); }
}

// ── Global content filter (applied to ALL sources before insert) ──────────────
// Rejects listings that are not genuine software/SaaS products.
const GLOBAL_BLOCKLIST = new RegExp([
  // Gambling / betting
  'casino','slot\\s+gacor','slot\\s+online','gambling','togel','judi','sbobet','taruhan',
  'poker\\s+online','bet\\b','betting','jackpot.*spin','gacor\\s+maxwin','slot.*maxwin',
  // Adult / escort
  'escort','porn','adult.?content','xxx','onlyfans\\s+clone','nsfw',
  // Physical retail — general
  'interior.?door','flooring.?store','furniture.?store','mattress.?store',
  'cigar.?deal','cigar.?coupon','cheap.?cigar','tobacco.?shop',
  'luxury.?watch.?store','jewellery.?shop','jewelry.?store',
  // Physical retail — hair & beauty supply
  'hair.?extension','lace.?wig','human.?hair.?wig','wig.?store','hair.?wig',
  'braiding.?hair','clip.?in.?hair','remy.?hair','virgin.?hair',
  'nail.?supply','beauty.?supply.?store','wholesale.?hair',
  // Predatory finance
  'forex.?signal','loan.?shark','payday.?loan','free.?money.?guaranteed',
  // Spam markers
  'vape.?shop','vaping.?store','free.?slots','play.?slots',
].join('|'), 'i');

/**
 * Returns true if the URL is a blog post, marketplace product listing,
 * or hosted-storefront page rather than a SaaS product homepage.
 */
function isBlogOrMarketplaceUrl(url) {
  try {
    const u    = new URL(url);
    const path = u.pathname.toLowerCase();
    const host = u.hostname.toLowerCase().replace(/^www\./, '');

    // Blog / article / news post paths — e.g. /blog/my-post, /articles/foo, /news/bar
    // Uses a word-boundary check: /blog/ must be a path segment, not part of a hostname.
    if (/\/(blog|posts?|articles?|news|press|updates?|stories|story|insights?|learn|resources?)\/[a-z0-9]/.test(path)) return true;

    // Marketplace product pages (not homepages)
    if (host === 'amazon.com' || host.endsWith('.amazon.com')) return true;
    if (host === 'etsy.com'   && /\/listing\//.test(path))      return true;
    if (host === 'ebay.com'   || host.endsWith('.ebay.com'))    return true;
    if (host === 'aliexpress.com' || host.endsWith('.aliexpress.com')) return true;
    // Shopify storefront product pages (*.myshopify.com/products/…)
    if (host.endsWith('.myshopify.com') && /\/products\//.test(path)) return true;
    // Gumroad individual product pages (gumroad.com/l/xxx)
    if (host === 'gumroad.com' && /^\/l\//.test(path)) return true;

    return false;
  } catch { return false; }
}

/** Returns true if this listing should be rejected from the directory */
function isBlockedContent(name, description, url) {
  const text = `${name} ${description || ''} ${url || ''}`;
  if (GLOBAL_BLOCKLIST.test(text)) return true;
  if (isBlogOrMarketplaceUrl(url)) return true;
  // Reject if description is predominantly non-Latin (Indonesian/Arabic slot spam, etc.)
  const nonLatin = (text.match(/[\u0600-\u06FF\u0E00-\u0E7F\u4E00-\u9FFF\u0400-\u04FF]/g) || []).length;
  if (nonLatin / Math.max(text.length, 1) > 0.15) return true;
  return false;
}

// ── Source 1: Turbo0 via Sanity CMS public API ────────────────────────────────
// Project ID: 7tbt32ra  Dataset: production  Type: item
// link field = actual product URL; image.asset->url = screenshot
const TURBO0_BLOCKLIST = GLOBAL_BLOCKLIST;

async function fetchTurbo0(limit = 300) {
  const results = [];
  const batchSize = 100;
  let offset = 0;

  while (results.length < limit) {
    const query = `*[_type == "item" && defined(link) && link != "" && defined(description) && length(description) > 15 && defined(name) && defined(slug)][${offset}..${offset + batchSize - 1}]{name, "slug": slug.current, description, link, "imageUrl": image.asset->url, "cat": categories[0]->name}`;
    const apiUrl = `https://7tbt32ra.api.sanity.io/v2021-10-21/data/query/production?query=${encodeURIComponent(query)}`;

    const resp = await safeFetch(apiUrl, { headers: { 'Accept': 'application/json' } });
    if (!resp || !resp.ok) break;

    let data;
    try { data = await resp.json(); } catch { break; }

    const items = data.result || [];
    if (items.length === 0) break;

    for (const item of items) {
      if (results.length >= limit) break;
      if (!item.name || !item.link) continue;
      if (isBlockedContent(item.name, item.description || '', item.link || '')) continue;
      if (!isEnglish(item.name + ' ' + (item.description || ''))) continue;

      let productUrl = item.link.trim();
      if (!productUrl.startsWith('http')) productUrl = 'https://' + productUrl;

      const desc = cleanDescription(item.description, item.name);
      if (!desc || desc.length < 15) continue;

      results.push({
        name:        item.name.trim().slice(0, 80),
        url:         productUrl,
        category:    mapCategory(item.cat || ''),
        description: desc.slice(0, 300),
        image_url:   item.imageUrl || null,
        source:      'Turbo0',
        source_url:  `https://turbo0.com/item/${item.slug}`,
        source_id:   `turbo0:${item.slug}`,
      });
    }

    if (items.length < batchSize) break;
    offset += batchSize;
    await sleep(150);
  }

  return results;
}

// ── Source 2: LaunchKiwi JSON API ─────────────────────────────────────────────
async function fetchLaunchKiwi() {
  const resp = await safeFetch('https://launchkiwi.com/api/tools', {
    headers: { 'Accept': 'application/json' },
  });
  if (!resp || !resp.ok) return [];

  let tools;
  try { tools = await resp.json(); } catch { return []; }
  if (!Array.isArray(tools)) return [];

  return tools
    .filter(t => t.name && t.url && t.status === 'active' && !isBlockedContent(t.name, t.tagline || '', t.url))
    .map(t => {
      // Prefer tagline (1 line) over full HTML long description
      const rawDesc = t.tagline || stripHtml(t.longDescription || '').slice(0, 300);
      const desc    = cleanDescription(rawDesc, t.name);
      const catRaw  = (Array.isArray(t.tags) ? t.tags[0] : null) || t.category || '';

      return {
        name:        t.name.trim().slice(0, 80),
        url:         t.url,
        category:    mapCategory(catRaw),
        description: (desc || t.tagline || '').slice(0, 300),
        image_url:   t.logoUrl || t.screenshotUrl || null,
        source:      'LaunchKiwi',
        source_url:  'https://launchkiwi.com',
        source_id:   `launchkiwi:${t.id}`,
      };
    })
    .filter(t => t.description.length > 10);
}

// ── Source 3: SaaSFame (HTML scrape) ─────────────────────────────────────────
// Product URL is in the "Visit Website" link as href="https://...?utm_source=saasfame.com&..."
async function fetchSaaSFame(limit = 25) {
  const smResp = await safeFetch('https://saasfame.com/sitemap.xml');
  if (!smResp || !smResp.ok) return [];
  const smXml  = await smResp.text();

  const itemUrls = [...smXml.matchAll(/<loc>(https?:\/\/[^<]+)<\/loc>/g)]
    .map(m => m[1])
    .filter(u => u.includes('/item/'))
    .slice(0, limit * 3);  // extra headroom for failures

  const results = [];
  for (const itemUrl of itemUrls) {
    if (results.length >= limit) break;

    const resp = await safeFetch(itemUrl);
    if (!resp || !resp.ok) { await sleep(PAGE_DELAY_MS); continue; }
    const html = await resp.text().catch(() => '');

    // Product URL has utm_source=saasfame.com — extract and clean it
    const rawHref = html.match(/href="(https?:\/\/[^"]*utm_source=saasfame[^"]*)"/)?.[1];
    if (!rawHref) { await sleep(PAGE_DELAY_MS); continue; }

    let productUrl;
    try {
      const u    = new URL(rawHref.replace(/&amp;/g, '&'));
      productUrl = u.origin + (u.pathname !== '/' ? u.pathname.replace(/\/+$/, '') : '');
    } catch { await sleep(PAGE_DELAY_MS); continue; }

    const name    = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/)?.[1]?.trim();
    const rawDesc = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/)?.[1];
    const imgUrl  = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/)?.[1];

    if (!name || !rawDesc) { await sleep(PAGE_DELAY_MS); continue; }
    if (!isEnglish(name + ' ' + rawDesc)) { await sleep(PAGE_DELAY_MS); continue; }

    const desc = cleanDescription(rawDesc, name);
    if (!desc || desc.length < 15) { await sleep(PAGE_DELAY_MS); continue; }

    const slug = itemUrl.split('/item/')[1] || '';
    results.push({
      name:        name.slice(0, 80),
      url:         productUrl,
      category:    'Other',    // category not reliably extractable from OG tags
      description: desc.slice(0, 300),
      image_url:   imgUrl || null,
      source:      'SaaSFame',
      source_url:  itemUrl,
      source_id:   `saasfame:${slug}`,
    });

    await sleep(PAGE_DELAY_MS);
  }

  return results;
}

// ── Source 4: twelve.tools (HTML scrape) ─────────────────────────────────────
// Each category page exposes tools via: title="visit [Name]" href="[URL]"
// 117 categories; we scrape a curated subset of tech-relevant ones.
const TWELVE_CATEGORIES = [
  'productivity','marketing','analytics','design','developer-tools','developer-apis',
  'seo','social-media','email','sales','automation','no-code','content-creators',
  'e-commerce','feedback-tools','writing','databases','cloud-computing',
  'project-management','finance','saas-boilerplates','security','monitoring',
  'lead-generation','cms','form-builders','recruiting','screenshots',
  'collaboration','knowledge-management',
];
const TWELVE_SKIP = /twitter\.com|x\.com|facebook|instagram|linkedin\.com|youtube|ramen\.tools|500\.tools|wired\.business|climate\.stripe|limonbello\.com\/tools\/morning/i;

async function fetchTwelveTools(limit = 120) {
  const results = [];
  const seen    = new Set();

  for (const cat of TWELVE_CATEGORIES) {
    if (results.length >= limit) break;
    const resp = await safeFetch(`https://twelve.tools/c/${cat}`);
    if (!resp || !resp.ok) { await sleep(300); continue; }
    const html = await resp.text().catch(() => '');

    // Extract all  title="visit [Name]" href="[URL]"  pairs
    const matches = [...html.matchAll(/title="visit ([^"]{2,80})"[^>]*href="(https?:\/\/[^"]{4,200})"/gi)];
    for (const [, name, url] of matches) {
      if (results.length >= limit) break;
      if (TWELVE_SKIP.test(url)) continue;
      const key = url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        name:        name.trim().slice(0, 80),
        url:         url.replace(/\/$/, ''),
        category:    mapCategory(cat.replace(/-/g, ' ')),
        description: '',          // filled by per-URL og:description fetch in runAggregation
        image_url:   null,
        source:      'twelve.tools',
        source_url:  `https://twelve.tools/c/${cat}`,
        source_id:   `twelve:${key}`,
        _needsDesc:  true,
      });
    }
    await sleep(320);
  }
  return results;
}

// ── Source 5: NewTool.site (HTML scrape) ──────────────────────────────────────
// Sitemap has localhost:3000 URLs — rewrite to newtool.site
const NT_SKIP_DOMAINS = /newtool|twitter|x\.com|linkedin|facebook|instagram|youtube|google|sanity\.|cdn\.|producthunt|github\.com/i;

async function fetchNewTool(limit = 25) {
  const smResp = await safeFetch('https://newtool.site/sitemap.xml');
  if (!smResp || !smResp.ok) return [];
  const smXml  = await smResp.text();

  const itemUrls = [...smXml.matchAll(/<loc>(https?:\/\/[^<]+)<\/loc>/g)]
    .map(m => m[1].replace(/^https?:\/\/[^/]+/, 'https://newtool.site'))
    .filter(u => u.includes('/item/'))
    .slice(0, limit * 3);

  const results = [];
  for (const itemUrl of itemUrls) {
    if (results.length >= limit) break;

    const resp = await safeFetch(itemUrl);
    if (!resp || !resp.ok) { await sleep(PAGE_DELAY_MS); continue; }
    const html = await resp.text().catch(() => '');

    const name    = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/)?.[1]?.replace(/ - NewTool.*$/i, '').trim();
    const rawDesc = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/)?.[1];
    const imgUrl  = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/)?.[1];

    // Find first external link with target="_blank" that isn't social/CDN/tracking
    const productUrl = [...html.matchAll(/href="(https?:\/\/[^"]{5,120})"\s[^>]*target="_blank"/g)]
      .map(m => m[1])
      .find(u => !NT_SKIP_DOMAINS.test(u) && !u.includes('newtool'));

    if (!name || !rawDesc || !productUrl) { await sleep(PAGE_DELAY_MS); continue; }
    if (!isEnglish(name + ' ' + rawDesc))  { await sleep(PAGE_DELAY_MS); continue; }

    const desc = cleanDescription(rawDesc, name);
    if (!desc || desc.length < 15) { await sleep(PAGE_DELAY_MS); continue; }

    const slug = itemUrl.split('/item/')[1] || '';
    results.push({
      name:        name.slice(0, 80),
      url:         productUrl,
      category:    'Other',
      description: desc.slice(0, 300),
      image_url:   imgUrl || null,
      source:      'NewTool.site',
      source_url:  itemUrl,
      source_id:   `newtool:${slug}`,
    });

    await sleep(PAGE_DELAY_MS);
  }

  return results;
}

// ── Source 6: LaunchBuff (launchbuff.com) ─────────────────────────────────────
// /products page lists all tools — h2 names + ?ref=launchbuff URLs paired by position.
const LAUNCHBUFF_SKIP_NAMES = /^(all\s+products?|best|submit|compete|win|three\s+steps|not\s+another|more\s+than|winner|real\s+backlink|categor)/i;
const LAUNCHBUFF_SKIP_URLS  = /launchbuff|twitter|x\.com|facebook|instagram|linkedin|youtube|google/i;

async function fetchLaunchBuff(limit = 200) {
  const resp = await safeFetch('https://launchbuff.com/products');
  if (!resp || !resp.ok) return [];
  const html = await resp.text().catch(() => '');

  // All h2/h3 headings on the page — first is "All Products" (nav), rest are product names
  const names = [...html.matchAll(/<h\d[^>]*>([^<]{2,80})<\/h\d>/gi)]
    .map(m => m[1].trim())
    .filter(n => n.length >= 2 && !LAUNCHBUFF_SKIP_NAMES.test(n));

  // All external product URLs (stripped of ?ref=launchbuff)
  const urls = [...html.matchAll(/href="(https?:\/\/(?!launchbuff)[^"]*\?ref=launchbuff[^"]*)"/gi)]
    .map(m => { try { const u = new URL(m[1]); return `${u.origin}${u.pathname}`.replace(/\/+$/, ''); } catch { return null; } })
    .filter(Boolean);

  const results = [];
  const seen    = new Set();
  const count   = Math.min(names.length, urls.length, limit);

  for (let i = 0; i < count; i++) {
    const name = names[i];
    const url  = urls[i];
    if (!name || !url || LAUNCHBUFF_SKIP_URLS.test(url)) continue;
    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isEnglish(name)) continue;

    results.push({
      name:       name.slice(0, 80),
      url,
      category:   'Other',
      description: '',
      image_url:  null,
      source:     'LaunchBuff',
      source_url: 'https://launchbuff.com/products',
      source_id:  `launchbuff:${key}`,
      _needsDesc: true,
    });
  }
  return results;
}

// ── Source 7: TheSaaSDir (thesaasdir.com) ────────────────────────────────────
// 189 product pages in sitemap. Each page:
//   - Name  : <h1>Name</h1>
//   - Desc  : <meta name="description" content="…">
//   - ExtURL: first href with utm_source=thesaasdir.com (HTML entities decoded, UTM stripped)
const THESAASDIR_SKIP = /thesaasdir|twitter|x\.com|facebook|instagram|linkedin|youtube|google|cdn\.|gstatic|aitooltrek|verifiedtools|wired\.business|sellwithboost/i;

function htmlDecode(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function fetchTheSaaSDir(limit = 80) {
  const smResp = await safeFetch('https://thesaasdir.com/sitemap.xml');
  if (!smResp || !smResp.ok) return [];
  const smXml = await smResp.text().catch(() => '');

  const productUrls = [...smXml.matchAll(/<loc>(https?:\/\/thesaasdir\.com\/product\/[^<]+)<\/loc>/gi)]
    .map(m => m[1].trim())
    .slice(0, limit * 2);

  const results = [];
  for (const pageUrl of productUrls) {
    if (results.length >= limit) break;
    const resp = await safeFetch(pageUrl);
    if (!resp || !resp.ok) { await sleep(500); continue; }
    const html = await resp.text().catch(() => '');

    // Name from <h1> (the product page always has <h1>ProductName</h1>)
    const name = html.match(/<h1[^>]*>([^<]{2,80})<\/h1>/i)?.[1]?.trim();
    // Description from <meta name="description">
    const rawDesc = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)?.[1]
                 || html.match(/<meta[^>]+content="([^"]+)"[^>]+name="description"/i)?.[1];
    // First external URL with utm_source=thesaasdir.com (HTML-decoded)
    const rawMatch = html.match(/href="(https?:\/\/[^"]*utm_source=thesaasdir[^"]{0,300})"/i)?.[1];
    if (!name || !rawMatch) { await sleep(400); continue; }

    // HTML-decode &amp; then strip UTM params
    const decodedRaw = htmlDecode(rawMatch);
    let extUrl = decodedRaw;
    try {
      const u = new URL(decodedRaw);
      ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'].forEach(p => u.searchParams.delete(p));
      extUrl = u.toString().replace(/\?$/, '').replace(/\/+$/, '');
    } catch { extUrl = decodedRaw.replace(/[?&]utm_[^&]+/g,'').replace(/[?&]+$/,''); }

    if (THESAASDIR_SKIP.test(extUrl)) { await sleep(400); continue; }
    if (!isEnglish(name)) { await sleep(400); continue; }

    const slug = pageUrl.split('/product/')[1]?.replace(/\/$/, '') || '';
    const key  = normalizeUrl(extUrl);
    results.push({
      name:        name.slice(0, 80),
      url:         extUrl,
      category:    'Other',
      description: rawDesc ? cleanDescription(rawDesc, name).slice(0, 300) : '',
      image_url:   null,
      source:      'TheSaaSDir',
      source_url:  pageUrl,
      source_id:   `thesaasdir:${slug}`,
    });
    await sleep(450);
  }
  return results;
}

// ── Source 8: SaaSTool.site ───────────────────────────────────────────────────
// NOTE: saastool.site product listing pages are JavaScript-rendered — no product links
// appear in the static HTML (only badge/partner links do). This source is disabled.
// Keeping the stub so the runner doesn't crash if called directly.
async function fetchSaaSTool(_limit = 60) { return []; }

// ── Main runner ───────────────────────────────────────────────────────────────

/**
 * runAggregation(pool, opts?)
 * Pulls from all sources, deduplicates by URL, and inserts new listings.
 * Returns { new, skipped, errors, sources, newIds }
 */
async function runAggregation(pool, opts = {}) {
  const { verbose = true, maxNew = 30 } = opts;
  const log = (...a) => { if (verbose) console.log('[aggregator]', ...a); };

  const stats = { new: 0, skipped: 0, errors: 0, sources: {}, newIds: [] };

  log('=== Aggregation run started ===');
  const t0 = Date.now();

  // ── Fetch all sources ─────────────────────────────────────────────────────────
  let turbo0 = [], launchkiwi = [], saasfame = [], newtool = [], twelve = [];
  let launchbuff = [], thesaasdir = [];

  // Parallel: JSON API + single-page scrapers (low rate-limit concern)
  await Promise.all([
    fetchTurbo0(300).then(r => { turbo0 = r; log(`Turbo0: ${r.length}`); }).catch(e => { log('Turbo0 error:', e.message); stats.errors++; }),
    fetchLaunchKiwi().then(r => { launchkiwi = r; log(`LaunchKiwi: ${r.length}`); }).catch(e => { log('LaunchKiwi error:', e.message); stats.errors++; }),
    fetchLaunchBuff(200).then(r => { launchbuff = r; log(`LaunchBuff: ${r.length}`); }).catch(e => { log('LaunchBuff error:', e.message); stats.errors++; }),
  ]);

  // Sequential HTML scrapers (rate-limited per-page fetches)
  await fetchSaaSFame(50).then(r => { saasfame = r; log(`SaaSFame: ${r.length}`); }).catch(e => { log('SaaSFame error:', e.message); stats.errors++; });
  await fetchNewTool(25).then(r => { newtool = r; log(`NewTool.site: ${r.length}`); }).catch(e => { log('NewTool error:', e.message); stats.errors++; });
  await fetchTwelveTools(120).then(r => { twelve = r; log(`twelve.tools: ${r.length}`); }).catch(e => { log('twelve.tools error:', e.message); stats.errors++; });
  await fetchTheSaaSDir(80).then(r => { thesaasdir = r; log(`TheSaaSDir: ${r.length}`); }).catch(e => { log('TheSaaSDir error:', e.message); stats.errors++; });

  const all = [...turbo0, ...launchkiwi, ...saasfame, ...newtool, ...twelve, ...launchbuff, ...thesaasdir];
  log(`Raw total: ${all.length}`);

  // ── Deduplicate by normalised URL (first occurrence wins) ──
  const seen = new Set();
  const deduped = [];
  for (const item of all) {
    const key = normalizeUrl(item.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  log(`After dedup: ${deduped.length}`);

  // ── Also skip URLs already in DB ──────────────────────────────────────────
  // Load existing URLs in one query
  let existingUrls = new Set();
  try {
    const ex = await pool.query('SELECT url FROM directory_listings');
    ex.rows.forEach(r => existingUrls.add(normalizeUrl(r.url)));
  } catch(e) { log('Could not load existing URLs:', e.message); }

  const truly_new = deduped.filter(i => {
    if (existingUrls.has(normalizeUrl(i.url))) return false;
    if (isBlockedContent(i.name, i.description, i.url)) {
      log(`[filter] Blocked: "${i.name}" (${i.url})`);
      return false;
    }
    return true;
  });
  log(`Truly new (not already in DB): ${truly_new.length}`);
  if (truly_new.length > maxNew) {
    log(`⚠️  Cap applied: limiting insertions to ${maxNew} (found ${truly_new.length} new). Pass maxNew option to raise the limit.`);
    truly_new.splice(maxNew);
  }

  // ── Resolve names/descriptions for entries that need a per-URL og fetch ──────
  const needsDesc = truly_new.filter(i => i._needsDesc);
  if (needsDesc.length > 0) {
    log(`Fetching og:title/og:description for ${needsDesc.length} entries (LaunchBuff, SaaSTool, twelve.tools)…`);
    for (const item of needsDesc) {
      const resp = await safeFetch(item.url).catch(() => null);
      if (resp && resp.ok) {
        const html = await resp.text().catch(() => '');
        const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]{2,80})"/i)?.[1]?.trim()
                     || html.match(/<meta[^>]+content="([^"]{2,80})"[^>]+property="og:title"/i)?.[1]?.trim();
        const ogDesc  = html.match(/<meta[^>]+(?:property="og:description"|name="description")[^>]+content="([^"]{15,300})"/i)?.[1]
                     || html.match(/<meta[^>]+content="([^"]{15,300})"[^>]+(?:property="og:description"|name="description")/i)?.[1];
        const ogImg   = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]{8,})"[^>]*/i)?.[1]
                     || html.match(/<meta[^>]+content="([^"]{8,})"[^>]*property="og:image"/i)?.[1];
        // Update name from og:title when _needsName is set (e.g. SaaSTool domain-derived names)
        if (item._needsName && ogTitle && isEnglish(ogTitle)) {
          item.name = ogTitle.slice(0, 80);
          delete item._needsName;
        }
        if (ogDesc) item.description = cleanDescription(ogDesc, item.name).slice(0, 300);
        // Skip og:image here — frontend uses Clearbit; storing og:image causes screenshot logos
        // if (ogImg && !item.image_url) item.image_url = ogImg.slice(0, 500);
      }
      if (!item.description || item.description.length < 10) {
        item.description = `${item.name} — listed on ${item.source || 'a SaaS directory'}.`;
      }
      delete item._needsDesc;
      await sleep(250);
    }
  }

  // ── Insert ────────────────────────────────────────────────────────────────
  for (const item of truly_new) {
    try {
      const r = await pool.query(
        `INSERT INTO directory_listings
           (name, url, category, description, image_url, source, source_url, source_id,
            is_auto_imported, score_pending, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, TRUE, FALSE, 'active')
         ON CONFLICT (url) DO NOTHING
         RETURNING id`,
        [item.name, item.url, item.category, item.description,
         item.image_url, item.source, item.source_url, item.source_id]
      );
      if (r.rows.length > 0) {
        stats.new++;
        stats.newIds.push(r.rows[0].id);
        stats.sources[item.source] = (stats.sources[item.source] || 0) + 1;
      } else {
        stats.skipped++;
      }
    } catch(e) {
      log(`Insert error for "${item.name}":`, e.message);
      stats.errors++;
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`Done in ${elapsed}s. New: ${stats.new}, Skipped: ${stats.skipped}, Errors: ${stats.errors}`);
  log('By source:', JSON.stringify(stats.sources));

  return stats;
}

module.exports = { runAggregation };

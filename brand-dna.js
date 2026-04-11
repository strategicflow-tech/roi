// brand-dna.js — Website Brand DNA Extraction Engine

async function extractBrandDNA(websiteUrl) {
  try {
    let url = websiteUrl.trim();
    if (!url.startsWith('http')) url = 'https://' + url;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StrategicFlowBot/1.0; +https://strategic-flow-audit.replit.app)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(12000)
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    // Fetch external stylesheets in parallel alongside other extraction work
    const [externalCss, logo, textContent, ctaVerbs, industry, audience, meta] = await Promise.all([
      fetchExternalCSS(html, url),
      Promise.resolve(extractLogo(html, url)),
      Promise.resolve(extractReadableText(html)),
      Promise.resolve(extractCTAVerbs(html)),
      Promise.resolve(detectIndustry(html)),
      Promise.resolve(detectAudience(html)),
      Promise.resolve(extractMeta(html))
    ]);

    const colors = extractColors(html, externalCss);
    const logoSvg = !logo ? extractLogoSvg(html) : null;
    const theme = detectTheme(html, externalCss);
    const primaryCtaUrl = extractPrimaryCTA(html, url);

    return { success: true, url, colors, logo, logoSvg, theme, primaryCtaUrl, textContent: textContent.slice(0, 2500), ctaVerbs, industry, audience, meta };
  } catch (err) {
    return { success: false, error: err.message, url: websiteUrl };
  }
}

// ─── EXTERNAL STYLESHEET FETCHING ────────────────────────────────────────────

async function fetchExternalCSS(html, baseUrl) {
  // Match both attribute orderings: rel before href and href before rel
  const hrefs = new Set();
  const patterns = [
    /<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/gi,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']stylesheet["']/gi
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) hrefs.add(m[1]);
  }

  // Resolve URLs, skip font/icon CDNs that contain no brand colors, cap at 4 files
  const urls = [...hrefs]
    .map(h => resolveUrl(h, baseUrl))
    .filter(u => {
      if (!u) return false;
      const lower = u.toLowerCase();
      return !lower.includes('fonts.googleapis')
          && !lower.includes('fonts.gstatic')
          && !lower.includes('fontawesome')
          && !lower.includes('cdnjs.cloudflare')
          && !lower.includes('bootstrapcdn')
          && !lower.includes('jsdelivr.net/npm/bootstrap');
    })
    .slice(0, 4);

  if (!urls.length) return '';

  const fetches = urls.map(cssUrl =>
    fetch(cssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StrategicFlowBot/1.0)' },
      signal: AbortSignal.timeout(5000)
    })
      .then(r => r.ok ? r.text() : '')
      .catch(() => '')        // any individual failure is silent — others still run
  );

  const chunks = await Promise.all(fetches);
  return chunks.join('\n');
}

// ─── COLOR EXTRACTION ───────────────────────────────────────────────────────

// extractColors now accepts the full external CSS text as a second argument.
// Inline <style> blocks inside the HTML are the fallback; external CSS is primary
// for frequency-based extraction on modern sites that externalise their stylesheets.

function extractColors(html, externalCss = '') {
  const results = [];
  const seen    = new Set();

  const add = (type, value) => {
    const k = (value || '').toLowerCase().trim();
    if (k && !seen.has(k)) { seen.add(k); results.push({ type, value: value.trim() }); }
  };

  // 1. <meta name="theme-color"> — always in the HTML, highest priority
  const tm = html.match(/name=["']theme-color["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/content=["']([^"']+)["'][^>]+name=["']theme-color["']/i);
  if (tm) add('theme-color', tm[1]);

  // 2. CSS custom properties that look like brand primaries.
  //    Search both the HTML (inline <style>) and the fetched external CSS.
  //    Only match 6-digit hex codes — 3/4/8-digit variants often represent alpha or
  //    transparent values (e.g. #0000) that are meaningless as brand colours.
  const cssSource = externalCss + '\n' + html;
  const cssVarRe  = /--((?:color-)?(?:primary|brand|accent|cta|button|highlight|main))(?:-[\w]+)?:\s*(#[0-9a-fA-F]{6})\b/gi;
  let m;
  while ((m = cssVarRe.exec(cssSource)) !== null) {
    if (!isNeutral(m[2])) add(`css:${m[1]}`, m[2]);
  }

  // 3. Frequency analysis — most-used non-neutral hex codes.
  //    Prefer external CSS over inline blocks (external CSS is checked first so its
  //    colours land in `freq` and get counted; inline blocks are appended after).
  const inlineBlocks = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []).join(' ');
  const freqSource   = externalCss + '\n' + inlineBlocks;

  if (freqSource.trim()) {
    const freq  = {};
    const hexRe = /#([0-9a-fA-F]{6})\b/g;
    let h;
    while ((h = hexRe.exec(freqSource)) !== null) {
      const c = '#' + h[1].toUpperCase();
      if (!isNeutral(c)) freq[c] = (freq[c] || 0) + 1;
    }
    // Take the top 4 by frequency, excluding any already added via CSS vars or theme-color
    Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .forEach(([c]) => add('frequent', c));
  }

  return results.slice(0, 5);
}

function isNeutral(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lum        = (r * 299 + g * 587 + b * 114) / 1000;
  const saturation = Math.max(r, g, b) - Math.min(r, g, b);
  return lum < 18 || lum > 238 || saturation < 15;
}

// ─── LOGO EXTRACTION ────────────────────────────────────────────────────────

function extractLogo(html, baseUrl) {
  // Derive the apex domain of the company site so we can verify image ownership.
  let companyApex = '';
  try {
    const parts = new URL(baseUrl).hostname.split('.');
    companyApex = parts.slice(-2).join('.');          // e.g. "memrise.com"
  } catch {}

  // Known CDN / media / social aggregator domains whose images are never a company logo.
  const thirdPartyPatterns = [
    'condenast', 'hearst', 'meredith', 'wordpress.com', 'wp.com',
    'cloudfront.net', 'akamaized.net', 'fastly.net', 'imgix.net',
    'cloudinary.com', 'unsplash.com', 'pexels.com', 'gettyimages',
    'shutterstock', 'istockphoto', 'squarespace-cdn', 'wixstatic',
    'shopify.com/s/files', 'fbcdn.net', 'twimg.com',
  ];

  const isCompanyOwned = (imageUrl) => {
    if (!imageUrl) return false;
    try {
      const hostname = new URL(imageUrl).hostname;
      // Reject any known third-party / CDN domain
      if (thirdPartyPatterns.some(p => imageUrl.includes(p))) return false;
      // Must share the apex domain with the company site
      return companyApex && hostname.includes(companyApex);
    } catch { return false; }
  };

  // Paths that indicate this is an OG/social-preview image, not an actual logo
  const isOGImagePath = (url) =>
    /opengraph|og[-_]image|og[-_]preview|social[-_]preview|social[-_]card|twitter[-_]card|open-graph/i.test(url);

  // Social auth / third-party provider logos — never a company's own logo
  // e.g. "Sign in with Google" button images
  const SOCIAL_PROVIDER_RE = /\b(google|facebook|apple|github|microsoft|twitter|linkedin|slack|discord|oauth|sign[-_]?in|sso|openid)\b/i;

  // Returns true when the full <img> tag (attributes string) references a social-auth icon
  const isSocialProviderImg = (imgAttrs) => {
    const altM = imgAttrs.match(/\balt=["']([^"']*)["']/i);
    const classM = imgAttrs.match(/\bclass=["']([^"']*)["']/i);
    const idM   = imgAttrs.match(/\bid=["']([^"']*)["']/i);
    const srcM  = imgAttrs.match(/\bsrc=["']([^"']*)["']/i);
    const filename = srcM ? (srcM[1].split('/').pop().replace(/\?.*$/, '')) : '';
    return SOCIAL_PROVIDER_RE.test(altM?.[1] || '')
        || SOCIAL_PROVIDER_RE.test(classM?.[1] || '')
        || SOCIAL_PROVIDER_RE.test(idM?.[1] || '')
        || SOCIAL_PROVIDER_RE.test(filename);
  };

  // Find first valid logo img in a chunk of HTML.
  // Returns the resolved URL or null.
  const findLogoInScope = (scopeHtml) => {
    const imgRe = /<img([^>]+)>/gi;
    let m;
    while ((m = imgRe.exec(scopeHtml)) !== null) {
      const attrs = m[1];
      const hasLogoSignal =
        /(?:class|alt|id)=["'][^"']*logo[^"']*["']/i.test(attrs)
        || /src=["'][^"']*\/(?:logo|brand)[^"']*\.(?:png|svg|webp|jpg)["']/i.test(attrs);
      if (!hasLogoSignal) continue;
      if (isSocialProviderImg(attrs)) continue;
      const srcM = attrs.match(/\bsrc=["']([^"']+)["']/i);
      if (!srcM) continue;
      const resolved = resolveUrl(srcM[1], baseUrl);
      if (!isOGImagePath(resolved)) return resolved;
    }
    return null;
  };

  // 1. Search specifically inside <header> and <nav> elements for logo <img> tags
  const headerNavMatch = html.match(/<(?:header|nav)\b[^>]*>([\s\S]{0,8000}?)<\/(?:header|nav)>/i);
  if (headerNavMatch) {
    const found = findLogoInScope(headerNavMatch[1]);
    if (found) return found;
  }

  // 2. Global scan — same rules, entire document
  const found = findLogoInScope(html);
  if (found) return found;

  // Nothing reliable found — return null so only company name text is shown
  return null;
}

function extractLogoSvg(html) {
  // Only needed when no raster/URL logo was found.
  // Looks for inline SVG logos inside header/nav elements.

  // Limit search scope to the top of the page (header/nav area)
  const navAreaMatch = html.match(/<(?:header|nav)\b[^>]*>([\s\S]{0,6000}?)<\/(?:header|nav)>/i);
  const searchArea = navAreaMatch ? navAreaMatch[1] : html.slice(0, 6000);

  // 1. SVG with role="img" in header/nav — strong signal it's a logo
  const svgRole = searchArea.match(/<svg\b[^>]*\brole=["']img["'][^>]*>[\s\S]*?<\/svg>/i);
  if (svgRole) return cleanSvgForEmail(svgRole[0]);

  // 2. SVG with aria-label in header/nav — also a strong signal
  const svgAria = searchArea.match(/<svg\b[^>]*\baria-label=["'][^"']+["'][^>]*>[\s\S]*?<\/svg>/i);
  if (svgAria) return cleanSvgForEmail(svgAria[0]);

  // 3. SVG inside an anchor or container whose class/id contains "logo" or "brand"
  const logoSvg = html.match(/(?:class|id)=["'][^"']*(?:logo|brand)[^"']*["'][^>]*>[\s\S]{0,300}?(<svg\b[\s\S]*?<\/svg>)/i);
  if (logoSvg) return cleanSvgForEmail(logoSvg[1]);

  return null;
}

function cleanSvgForEmail(svg) {
  if (!svg) return null;
  let cleaned = svg
    .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .trim();
  // Reject oversized SVGs — they are likely decorative, not a logo mark
  if (cleaned.length > 10000) return null;
  return cleaned;
}

// ─── THEME DETECTION ────────────────────────────────────────────────────────
// Determines if the page uses a dark or light color scheme by examining
// body/html background-color in CSS, color-scheme declarations, and HTML attributes.

function detectTheme(html, externalCss = '') {
  const cssSource = externalCss + '\n' + html;

  // 1. Explicit color-scheme declarations
  if (/color-scheme\s*:\s*['"]?dark['"]?/i.test(cssSource)) return 'dark';
  if (/data-theme=["']dark["']/i.test(html)) return 'dark';
  if (/class=["'][^"']*\bdark\b[^"']*["']/i.test(html.slice(0, 500))) return 'dark';

  // 2. Look for body/html/main background-color in CSS
  const bgPatterns = [
    /body\s*\{[^}]*background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8})/i,
    /html\s*\{[^}]*background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8})/i,
    /:root\s*\{[^}]*--(?:bg|background|surface|base)(?:-color)?[^:]*:\s*(#[0-9a-fA-F]{3,8})/i,
  ];
  for (const re of bgPatterns) {
    const m = cssSource.match(re);
    if (m) {
      let hex = m[1];
      // Expand 3-digit hex to 6-digit
      if (hex.length === 4) hex = '#' + hex[1]+hex[1]+hex[2]+hex[2]+hex[3]+hex[3];
      if (hex.length === 7) {
        const r = parseInt(hex.slice(1,3), 16);
        const g = parseInt(hex.slice(3,5), 16);
        const b = parseInt(hex.slice(5,7), 16);
        const lum = (r * 299 + g * 587 + b * 114) / 1000;
        // #444444 has lum = 68. Anything darker → dark theme
        if (lum < 68) return 'dark';
        return 'light';
      }
    }
  }

  // 3. Check meta theme-color (often dark on dark-themed sites)
  const tm = html.match(/name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{6})["']/i)
           || html.match(/content=["'](#[0-9a-fA-F]{6})["'][^>]+name=["']theme-color["']/i);
  if (tm) {
    const r = parseInt(tm[1].slice(1,3), 16);
    const g = parseInt(tm[1].slice(3,5), 16);
    const b = parseInt(tm[1].slice(5,7), 16);
    if ((r * 299 + g * 587 + b * 114) / 1000 < 68) return 'dark';
  }

  return 'light'; // default
}

// ─── PRIMARY CTA EXTRACTION ──────────────────────────────────────────────────
// Finds the most prominent action URL on the page — used as the newsletter CTA href.

function extractPrimaryCTA(html, baseUrl) {
  // 1. <a> with class/id strongly signalling a primary CTA button
  const ctaClassRe = /<a\b[^>]*(?:class|id)=["'][^"']*(?:cta|btn-primary|button--primary|hero-cta|primary-btn|signup|get-started)[^"']*["'][^>]*href=["']([^"'#][^"']+)["']/i;
  const ctaClassRe2 = /<a\b[^>]*href=["']([^"'#][^"']+)["'][^>]*(?:class|id)=["'][^"']*(?:cta|btn-primary|button--primary|hero-cta|primary-btn|signup|get-started)[^"']*["']/i;
  const m1 = html.match(ctaClassRe) || html.match(ctaClassRe2);
  if (m1) {
    const resolved = resolveUrl(m1[1], baseUrl);
    if (resolved && resolved.startsWith('http')) return resolved;
  }

  // 2. Anchor whose visible text matches common signup/start/try/learn patterns
  const signupRe = /<a\b[^>]*href=["']([^"'#][^"']+)["'][^>]*>\s*(?:<[^>]+>)?\s*(Get started|Start free|Sign up free|Try free|Start for free|Get started free|Start building|Try it free|Sign up|Try|Learn more|Get Started)\b/i;
  const m2 = html.match(signupRe);
  if (m2) {
    const resolved = resolveUrl(m2[1], baseUrl);
    if (resolved && resolved.startsWith('http')) return resolved;
  }

  // 3. og:url — clean canonical URL of the page
  const ogUrl = html.match(/property=["']og:url["'][^>]+content=["']([^"']+)["']/i)
              || html.match(/content=["']([^"']+)["'][^>]+property=["']og:url["']/i);
  if (ogUrl && ogUrl[1] && ogUrl[1].startsWith('http')) return ogUrl[1];

  return null;
}

function resolveUrl(url, base) {
  if (!url) return null;
  if (url.startsWith('data:')) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  try { return new URL(url, base).href; } catch { return url; }
}

// ─── TEXT EXTRACTION ────────────────────────────────────────────────────────

function extractReadableText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── CTA VERB EXTRACTION ────────────────────────────────────────────────────

function extractCTAVerbs(html) {
  const btnRe = /<(?:button|a)[^>]*>([^<]{2,50})<\/(?:button|a)>/gi;
  const verbs = new Set();
  const verbRe = /^(Get|Start|Try|Book|See|Join|Explore|Discover|Learn|Download|Access|Claim|Build|Create|Sign\s+up|Log\s+in|Watch|Request|Schedule|Contact|Buy|Shop)\b/i;
  let m;
  while ((m = btnRe.exec(html)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    const v = text.match(verbRe);
    if (v) verbs.add(v[1]);
  }
  return [...verbs].slice(0, 6);
}

// ─── INDUSTRY DETECTION ─────────────────────────────────────────────────────

function detectIndustry(html) {
  const t = html.toLowerCase();
  const map = {
    'SaaS / Software':       ['saas', 'software', 'platform', 'dashboard', 'api', 'integration', 'workflow', 'automation', 'cloud'],
    'Fintech':               ['payment', 'invoice', 'banking', 'finance', 'transaction', 'payroll', 'accounting', 'revenue'],
    'E-commerce':            ['shop', 'store', 'product', 'checkout', 'cart', 'shipping', 'order', 'ecommerce'],
    'Healthcare':            ['health', 'medical', 'patient', 'clinic', 'therapy', 'wellness', 'doctor', 'pharma'],
    'EdTech':                ['learn', 'course', 'education', 'student', 'skill', 'training', 'certification', 'curriculum'],
    'Marketing Tech':        ['marketing', 'campaign', 'email', 'seo', 'ads', 'content', 'analytics', 'attribution'],
    'AI / Machine Learning': ['ai', 'artificial intelligence', 'machine learning', 'model', 'neural', 'llm', 'gpt', 'copilot'],
    'HR / Recruitment':      ['hiring', 'recruitment', 'candidate', 'resume', 'hr', 'talent', 'onboarding', 'workforce'],
    'Cybersecurity':         ['security', 'cyber', 'threat', 'vulnerability', 'compliance', 'zero trust', 'siem', 'soc']
  };
  let best = { industry: 'Technology / SaaS', score: 0 };
  for (const [industry, kws] of Object.entries(map)) {
    const score = kws.filter(k => t.includes(k)).length;
    if (score > best.score) best = { industry, score };
  }
  return best.industry;
}

// ─── AUDIENCE DETECTION ─────────────────────────────────────────────────────

function detectAudience(html) {
  const t = html.toLowerCase();
  const b2b = ['enterprise', 'team', 'business', 'company', 'organization', 'startup', 'professional', 'manager', 'ceo', 'cto', 'founder', 'sales team', 'b2b'].filter(s => t.includes(s)).length;
  const b2c = ['personal', 'individual', 'family', 'lifestyle', 'your life', 'everyday', 'subscription', 'consumer', 'b2c'].filter(s => t.includes(s)).length;
  if (b2b > b2c + 1) return 'B2B';
  if (b2c > b2b + 1) return 'B2C';
  return 'B2B';
}

// ─── META EXTRACTION ────────────────────────────────────────────────────────

function extractMeta(html) {
  const title   = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
  const desc    = (html.match(/name=["']description["'][^>]+content=["']([^"']+)["']/i)
                 || html.match(/content=["']([^"']+)["'][^>]+name=["']description["']/i) || [])[1] || '';
  const ogTitle = (html.match(/property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
                 || html.match(/content=["']([^"']+)["'][^>]+property=["']og:title["']/i) || [])[1] || '';
  return { title: (ogTitle || title).trim(), description: desc.trim() };
}

module.exports = { extractBrandDNA };

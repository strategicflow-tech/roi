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

    return { success: true, url, colors, logo, textContent: textContent.slice(0, 2500), ctaVerbs, industry, audience, meta };
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
  const og = html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (og && og[1]) return resolveUrl(og[1], baseUrl);

  const tw = html.match(/name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (tw && tw[1]) return resolveUrl(tw[1], baseUrl);

  const logoSrc = html.match(/<img[^>]+(?:class|alt|id)=["'][^"']*logo[^"']*["'][^>]+src=["']([^"']+)["']/i)
                || html.match(/<img[^>]+src=["']([^"']*\/(?:logo|brand)[^"']*\.(?:png|svg|webp|jpg))["']/i);
  if (logoSrc && logoSrc[1]) return resolveUrl(logoSrc[1], baseUrl);

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

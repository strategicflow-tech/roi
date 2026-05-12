function generateShowcaseHtml({
  companyName, primaryColor, logoUrl, sourceUrl,
  originalSubject, originalBody,
  rebuiltSubject, previewText, hookHeadline, hookLead,
  bodyParagraphs, featureCards, ctaText, ctaUrl,
  originalScore, rebuiltScore, scoreReason,
  flags, abSubjects, contentCalendar, whatChanged,
  originalImages, originalGifs, originalTables,
  rebuiltEmailHtml
}) {
  const BG        = '#07090f';
  const CARD_BG   = '#0f1119';
  const BORDER    = 'rgba(255,255,255,0.08)';
  const accent    = (primaryColor && /^#[0-9a-fA-F]{6}$/.test(primaryColor)) ? primaryColor : '#00e5a0';
  const esc       = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const safeArr   = a => Array.isArray(a) ? a : [];
  const mdToHtml  = t => esc(t).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  const PARA_LABELS = new Set(['THE PROBLEM','THE SHIFT','THE CONSEQUENCE','P1','P2','P3','P4','P5']);
  function isProductImage(url) {
    if (!url) return false;
    const l = url.toLowerCase();
    const skip = [
      'logo','favicon','avatar','gravatar','icon','badge','keyboard-shortcuts','typelogo',
      'youtube','youtu.be','rmode=crop','width=40','height=40','width=32','height=32',
      'width=96','height=96','1646653490249','630c6d4e','promoengine','300x300',
      'author','profile','headshot','.svg'
    ];
    if (skip.some(s => l.includes(s))) return false;
    const wm = url.match(/[?&]width=(\d+)/i);
    if (wm && parseInt(wm[1]) < 100) return false;
    return true;
  }
  function deduplicateImages(images) {
    const seen = new Set();
    return images.filter(img => {
      const base = (img.url || img).split('?')[0];
      if (seen.has(base)) return false;
      seen.add(base);
      return true;
    });
  }

  // Adapt the Before/After comparison block for the showcase white email frame —
  // adds cell background tints; source colors are already dark-on-white from buildNewsletterHTML.
  function adaptEmailBodyForShowcase(html) {
    if (!html) return html;
    return html
      // Before cell: add light grey background (source already has rgba(0,0,0,0.08) border)
      .replace(
        'border-right:1px solid rgba(0,0,0,0.08);vertical-align:top;"',
        'border-right:1px solid rgba(0,0,0,0.08);vertical-align:top;background:#f9f9f7;"'
      )
      // After cell: add light-blue background
      .replace(
        'style="width:50%;padding:16px 20px;vertical-align:top;"',
        'style="width:50%;padding:16px 20px;vertical-align:top;background:#f0f7ff;"'
      );
  }

  // Decode already-escaped HTML entities before re-encoding —
  // originalBody from the scraper may contain &#039; &#8217; &vert; etc.
  // Applying esc() directly would double-escape them to &amp;#039; etc.
  function prepareBodyText(text) {
    if (!text) return '';
    const decoded = text
      .replace(/&amp;/g,  '&')
      .replace(/&lt;/g,   '<')
      .replace(/&gt;/g,   '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&vert;/g, '|')
      .replace(/&[a-z]+;/gi, ' ');
    return decoded
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  const origScore  = Number(originalScore) || 0;
  const rebScore   = Number(rebuiltScore)  || 0;
  const scoreImprv = rebScore - origScore;

  const flagsArr        = safeArr(flags);
  const abArr           = safeArr(abSubjects);
  const calArr          = safeArr(contentCalendar);
  const changedArr      = safeArr(whatChanged);
  const bodyParaArr     = safeArr(bodyParagraphs);
  const tablesArr       = safeArr(originalTables);
  const imgsArr         = deduplicateImages(safeArr(originalImages).filter(img => img.url && isProductImage(img.url)));
  const gifsArr         = deduplicateImages(safeArr(originalGifs).filter(gif => gif.url && isProductImage(gif.url)));
  const featureCardsArr = safeArr(featureCards).filter(c => (c.title || c.body) && !PARA_LABELS.has((c.title || '').trim().toUpperCase()));

  function scoreBar(val, max, color) {
    const pct = Math.min(100, Math.round((val / max) * 100));
    return `<div class="score-bar-track"><div class="score-bar-fill" style="width:${pct}%;background:${color};"></div></div>`;
  }

  function extractEmailBody(html) {
    if (!html || typeof html !== 'string') return '';
    const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    return m ? m[1] : html;
  }

  const emailBodyHtml = adaptEmailBodyForShowcase(extractEmailBody(rebuiltEmailHtml));

  /* ─── BEFORE TAB ────────────────────────────────────────────────── */
  const beforeTab = `
<div class="tab-panel" id="tab-before">

  <div class="card">
    <div class="card-label">Original Subject Line</div>
    <div class="subject-orig">${esc(originalSubject)}</div>
  </div>

  <div class="card">
    <div class="card-label">Original Email Body</div>
    <div class="orig-body">${prepareBodyText(originalBody || '').replace(/\n{2,}/g,'</p><p class="ob-p">').replace(/\n/g,'<br>')}</div>
  </div>

  ${imgsArr.length || gifsArr.length ? `
  <div class="card">
    <div class="card-label">Product Images (${imgsArr.length + gifsArr.length})</div>
    <div class="img-grid">
      ${[...imgsArr, ...gifsArr].map(img => `<img src="${img.url}" alt="${esc(img.alt || '')}" class="prod-img" loading="lazy">`).join('')}
    </div>
  </div>` : ''}

  ${tablesArr.length ? `
  <div class="card">
    <div class="card-label">Original Tables</div>
    ${tablesArr.map(t => `<div class="tbl-wrap">${t.html}</div>`).join('')}
  </div>` : ''}

  ${flagsArr.length ? `
  <div class="card">
    <div class="card-label">Issues Found &mdash; ${flagsArr.length}</div>
    <div class="flags">
      ${flagsArr.map(f => {
        const txt = typeof f === 'string' ? f : (f.issue || f.title || JSON.stringify(f));
        return `<div class="flag-row"><span class="flag-x">✕</span><span>${esc(txt)}</span></div>`;
      }).join('')}
    </div>
  </div>` : ''}

</div>`;

  /* ─── AFTER TAB ─────────────────────────────────────────────────── */
  const afterTab = `
<div class="tab-panel" id="tab-after" style="display:none">

  <div class="card">
    <div class="card-label">Rebuilt Subject Line</div>
    <div class="subject-rebuilt" style="border-color:${accent};background:${accent}14;">${esc(rebuiltSubject)}</div>
    ${previewText ? `<div class="preview-text">Preview: ${esc(previewText)}</div>` : ''}
  </div>

  ${emailBodyHtml ? `
  <div class="card email-card">
    <div class="card-label">Rebuilt Newsletter</div>
    <div class="email-shell">
      <div class="email-frame">
        ${emailBodyHtml}
      </div>
    </div>
  </div>` : (hookHeadline || featureCardsArr.length || bodyParaArr.length ? `
  <div class="card">
    <div class="card-label">Rebuilt Content</div>
    ${hookHeadline ? `<div class="hook-headline">${esc(hookHeadline)}</div>` : ''}
    ${hookLead ? `<div class="hook-lead">${mdToHtml(hookLead)}</div>` : ''}
    ${featureCardsArr.length
      ? featureCardsArr.map(c => `<div class="body-para"><div class="para-lbl">${esc(c.title || '')}</div><p>${mdToHtml(c.body || c.text || c.content || c.description || '')}</p></div>`).join('')
      : bodyParaArr.map((p, i) => `<div class="body-para"><div class="para-lbl">${['THE PROBLEM','THE SHIFT','THE CONSEQUENCE'][i]||`P${i+1}`}</div><p>${mdToHtml(typeof p === 'string' ? p : '')}</p></div>`).join('')
    }
  </div>` : '')}

  ${origScore || rebScore ? `
  <div class="card">
    <div class="card-label">Conversion Score</div>
    <div class="score-grid">
      <div class="score-col">
        <div class="score-head">Original</div>
        <div class="score-num muted">${origScore}<span class="score-den">/10</span></div>
        ${scoreBar(origScore, 10, 'rgba(255,255,255,0.25)')}
      </div>
      <div class="score-col">
        <div class="score-head" style="color:${accent};">Strategic Flow</div>
        <div class="score-num" style="color:${accent};">${rebScore}<span class="score-den">/10</span></div>
        ${scoreBar(rebScore, 10, accent)}
      </div>
    </div>
    ${scoreImprv > 0 ? `<div class="score-delta" style="color:${accent};">+${scoreImprv} point improvement</div>` : ''}
    ${scoreReason ? `<div class="score-reason">${esc(scoreReason)}</div>` : ''}
  </div>` : ''}

  ${abArr.length ? `
  <div class="card">
    <div class="card-label">A/B Subject Variants</div>
    ${abArr.map(v => `
    <div class="ab-card">
      <div class="ab-subject">${esc(v.subject || '')}</div>
      <div class="ab-meta">
        ${v.angle ? `<span class="ab-angle">${esc(v.angle)}</span>` : ''}
        ${v.predicted_lift ? `<span class="ab-lift" style="color:${accent};">↑ ${esc(v.predicted_lift)}</span>` : ''}
      </div>
      ${v.reasoning ? `<div class="ab-reason">${esc(v.reasoning)}</div>` : ''}
    </div>`).join('')}
  </div>` : ''}

  ${calArr.length ? `
  <div class="card">
    <div class="card-label">30-Day Content Calendar</div>
    ${calArr.map((c, i) => `
    <div class="cal-card">
      <div class="cal-week" style="color:${accent};">Week ${i + 1}${c.timing ? ` &middot; ${esc(c.timing)}` : ''}</div>
      <div class="cal-subject">${esc(c.subject_line || c.topic || '')}</div>
      ${c.why_now ? `<div class="cal-why">${esc(c.why_now)}</div>` : ''}
    </div>`).join('')}
  </div>` : ''}

</div>`;

  /* ─── WHAT CHANGED TAB ──────────────────────────────────────────── */
  const changedTab = `
<div class="tab-panel" id="tab-changed" style="display:none">

  ${changedArr.length ? changedArr.map((item, i) => `
  <div class="change-card">
    <div class="ch-num" style="background:${accent};color:#07090f;">${i + 1}</div>
    <div class="ch-body-wrap">
      <div class="ch-title">${esc(item.title || item)}</div>
      ${item.body ? `<div class="ch-body">${esc(item.body)}</div>` : ''}
    </div>
  </div>`).join('') : `
  <div class="card" style="color:#bbbbbb;font-size:14px;">
    Strategic upgrade details unavailable for this audit.
  </div>`}

  <div class="card methodology-card">
    <div class="card-label">Strategic Flow Methodology</div>
    <p class="meth-p">Every rebuild follows the same 5-criterion framework: subject curiosity, hook strength, feature-to-outcome translation, social proof specificity, and CTA ownership language.</p>
    <p class="meth-p">Each criterion is scored 0&ndash;2 points for a maximum of 10. Rebuilds target a minimum of 8/10 before delivery.</p>
  </div>

  <div class="upgrade-cta">
    <h2 class="ucta-h">This is a free preview.</h2>
    <p class="ucta-p">Want full A/B subject lines, audience segments &amp; content calendar for every send?</p>
    <a href="https://strategic-flow-pro.replit.app/packages" class="ucta-btn" style="background:${accent};color:#07090f;">See Pro Plans &rarr;</a>
  </div>

</div>`;

  /* ─── FULL HTML ─────────────────────────────────────────────────── */
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Strategic Flow &mdash; ${esc(companyName)} Audit</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;background:${BG};color:#fff;min-height:100vh;line-height:1.6}
a{color:${accent}}
/* ── Header ── */
.hdr{background:#09111e;border-bottom:1px solid ${BORDER};padding:18px 0}
.hdr-inner{max-width:960px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.brand{display:flex;align-items:center;gap:10px}
.brand-logo{width:32px;height:32px;object-fit:contain;border-radius:6px}
.brand-name{font-size:17px;font-weight:800;color:#fff}
.brand-name em{color:${accent};font-style:normal}
.company-tag{font-size:12px;color:#cccccc;background:rgba(255,255,255,0.05);padding:4px 12px;border-radius:100px;border:1px solid ${BORDER};white-space:nowrap}
/* ── Layout ── */
.main{max-width:960px;margin:0 auto;padding:36px 24px 80px}
.page-title{font-size:30px;font-weight:900;margin-bottom:4px}
.page-title em{color:${accent};font-style:normal}
.page-meta{font-size:13px;color:#bbbbbb;margin-bottom:28px}
.src-link{font-size:12px;color:#aaaaaa;margin-bottom:24px;display:block}
.src-link a{color:${accent};text-decoration:none}
/* ── Tabs ── */
.tabs{display:flex;gap:2px;border-bottom:1px solid ${BORDER};margin-bottom:28px;overflow-x:auto}
.tab-btn{padding:10px 22px;font-size:13px;font-weight:600;color:#bbbbbb;background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;margin-bottom:-1px;white-space:nowrap;transition:color .15s,border-color .15s}
.tab-btn:hover{color:#eeeeee}
.tab-btn.active{color:${accent};border-bottom-color:${accent}}
/* ── Card ── */
.card{background:${CARD_BG};border:1px solid ${BORDER};border-radius:14px;padding:24px;margin-bottom:18px}
.card-label{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#bbbbbb;margin-bottom:14px}
/* ── Before ── */
.subject-orig{font-size:19px;font-weight:800;padding:14px 18px;border-radius:8px;border:2px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.04);line-height:1.3}
.orig-body{font-size:14px;color:#dddddd;line-height:1.75;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow-y:auto}
.orig-body p,.ob-p{margin-bottom:10px}
.img-grid{display:flex;flex-wrap:wrap;gap:12px;margin-top:4px}
.prod-img{max-width:100%;max-height:380px;object-fit:contain;border-radius:8px;display:block}
.tbl-wrap{overflow-x:auto;margin-top:10px;font-size:13px;color:#e0e0e0}
.flags{display:flex;flex-direction:column;gap:8px}
.flag-row{display:flex;align-items:flex-start;gap:10px;font-size:13px;color:#dddddd;background:rgba(239,68,68,0.07);border:1px solid rgba(239,68,68,0.18);border-radius:8px;padding:10px 14px}
.flag-x{color:#ef4444;flex-shrink:0;font-weight:700;font-size:11px;margin-top:2px}
/* ── After ── */
.subject-rebuilt{font-size:19px;font-weight:800;padding:14px 18px;border-radius:8px;border:2px solid;line-height:1.3}
.preview-text{font-size:12px;color:#bbbbbb;margin-top:8px;font-style:italic}
.email-card{padding:20px}
.email-shell{background:#f0f0f0;border-radius:10px;padding:8px;overflow-x:hidden}
.email-frame{background:#ffffff;width:100%;max-width:100%;margin:0 auto;border-radius:4px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.18)}
.email-frame table{max-width:100% !important;}
.email-frame img{max-width:100% !important;height:auto !important;}
.email-frame td[width]{width:auto !important;}
.hook-headline{font-size:20px;font-weight:800;margin-bottom:10px;color:#fff}
.hook-lead{font-size:14px;color:#dddddd;line-height:1.65;margin-bottom:16px}
.body-para{margin-bottom:14px;padding:12px 14px;background:rgba(255,255,255,0.04);border-radius:8px;border-left:2px solid rgba(255,255,255,0.1)}
.body-para:last-child{margin-bottom:0}
.para-lbl{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${accent};margin-bottom:5px}
.body-para p{font-size:14px;color:#eeeeee;line-height:1.6}
.score-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.score-col{text-align:center;padding:16px;background:rgba(255,255,255,0.04);border-radius:10px}
.score-head{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#bbbbbb;margin-bottom:8px}
.score-num{font-size:44px;font-weight:900;line-height:1}
.score-num.muted{color:#bbbbbb}
.score-den{font-size:18px;opacity:0.55;font-weight:600}
.score-bar-track{background:rgba(255,255,255,0.07);border-radius:100px;height:6px;width:100%;margin-top:10px}
.score-bar-fill{height:6px;border-radius:100px;transition:width .4s}
.score-delta{text-align:center;margin-top:12px;font-size:13px;font-weight:700}
.score-reason{font-size:13px;color:#cccccc;margin-top:10px;line-height:1.55}
.ab-card{padding:14px 16px;background:rgba(255,255,255,0.04);border:1px solid ${BORDER};border-radius:10px;margin-bottom:10px}
.ab-card:last-child{margin-bottom:0}
.ab-subject{font-size:15px;font-weight:700;margin-bottom:8px;color:#fff}
.ab-meta{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.ab-angle{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#aaaaaa;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:4px}
.ab-lift{font-size:13px;font-weight:700}
.ab-reason{font-size:13px;color:#cccccc;line-height:1.5}
.cal-card{padding:14px 16px;background:rgba(255,255,255,0.04);border:1px solid ${BORDER};border-radius:10px;margin-bottom:10px}
.cal-card:last-child{margin-bottom:0}
.cal-week{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;margin-bottom:5px}
.cal-subject{font-size:15px;font-weight:700;color:#fff;margin-bottom:5px}
.cal-why{font-size:13px;color:#cccccc;line-height:1.5}
/* ── What Changed ── */
.change-card{display:flex;align-items:flex-start;gap:14px;background:${CARD_BG};border:1px solid ${BORDER};border-radius:14px;padding:20px 22px;margin-bottom:14px}
.ch-num{flex-shrink:0;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:900;margin-top:1px}
.ch-body-wrap{flex:1}
.ch-title{font-size:15px;font-weight:800;margin-bottom:6px;color:#fff}
.ch-body{font-size:13px;color:#cccccc;line-height:1.65}
.methodology-card{border-left:3px solid rgba(255,255,255,0.12)}
.meth-p{font-size:13px;color:#cccccc;line-height:1.65;margin-bottom:10px}
.meth-p:last-child{margin-bottom:0}
.upgrade-cta{background:${accent}0d;border:2px solid ${accent};border-radius:16px;padding:40px 32px;text-align:center;margin:28px 0}
.ucta-h{font-size:24px;font-weight:900;color:#fff;margin-bottom:12px}
.ucta-p{font-size:15px;color:#cccccc;margin-bottom:24px;line-height:1.6}
.ucta-btn{display:inline-block;padding:14px 32px;font-weight:800;font-size:15px;border-radius:8px;text-decoration:none;letter-spacing:.3px}
/* ── Footer ── */
.ftr{text-align:center;padding:28px 24px;border-top:1px solid ${BORDER};color:#888888;font-size:12px}
.ftr a{color:${accent};text-decoration:none}
/* ── Responsive ── */
@media(max-width:620px){
  .score-grid{grid-template-columns:1fr}
  .tabs{overflow-x:auto}
  .tab-btn{padding:10px 14px;font-size:12px}
  .page-title{font-size:22px}
  .email-shell{padding:4px;}
  .email-frame{max-width:100%;width:100%;}
  .email-card{padding:10px;}
}
</style>
</head>
<body>

<header class="hdr">
  <div class="hdr-inner">
    <div class="brand">
      <span class="brand-name">Strategic<em>Flow</em></span>
    </div>
    <span class="company-tag">${esc(companyName)} &mdash; Email Audit</span>
  </div>
</header>

<main class="main">
  <h1 class="page-title">Email <em>Teardown</em></h1>
  <p class="page-meta">Audit by Strategic Flow &mdash; ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</p>
  ${sourceUrl ? `<span class="src-link">Source: <a href="${esc(sourceUrl)}" target="_blank" rel="noopener">${esc(sourceUrl)}</a></span>` : ''}

  <div class="tabs">
    <button class="tab-btn active" onclick="show('before',this)">Before</button>
    <button class="tab-btn" onclick="show('after',this)">After &mdash; Strategic Flow</button>
    <button class="tab-btn" onclick="show('changed',this)">What Changed &amp; Why</button>
  </div>

  ${beforeTab}
  ${afterTab}
  ${changedTab}
</main>

<footer class="ftr">
  Rebuilt by <a href="https://strategic-flow-audit.replit.app" target="_blank" rel="noopener">Strategic Flow</a> &mdash; conversion email platform for B2B newsletters.
</footer>

<script>
function show(id, btn) {
  document.querySelectorAll('.tab-panel').forEach(function(el){ el.style.display='none'; });
  document.querySelectorAll('.tab-btn').forEach(function(el){ el.classList.remove('active'); });
  document.getElementById('tab-' + id).style.display = '';
  btn.classList.add('active');
}
</script>
</body>
</html>`;
}

function extractVisualAssets(rawHtml, baseUrl) {
  const images = [];
  const gifs   = [];
  const tables = [];
  if (!rawHtml || typeof rawHtml !== 'string') return { images, gifs, tables };

  const AD_TRACKING_DOMAINS = [
    'doubleclick.net','googlesyndication.com','googleadservices.com',
    'adnxs.com','adsrvr.org','adsafeprotected.com','moatads.com',
    'scorecardresearch.com','quantserve.com','omtrdc.net',
    'demdex.net','trk.email','go2cloud.org','impactradius.com',
    'pxf.io','sjv.io','tk-ads.','cdn.branch.io','app.link'
  ];

  const imgRegex = /<img([^>]*)>/gi;
  const seen = new Set();
  let match;
  while ((match = imgRegex.exec(rawHtml)) !== null) {
    const attrs = match[1] || '';

    const srcM = attrs.match(/\bsrc=["']([^"']+)["']/i);
    if (!srcM) continue;
    let url = srcM[1] || '';
    if (!url) continue;
    if (!url.startsWith('http')) {
      try { url = new URL(url, baseUrl).href; } catch (_) { continue; }
    }

    // Skip SVG files (icon sprites, logos — not content images); strip fragment too
    if (url.split('?')[0].split('#')[0].toLowerCase().endsWith('.svg')) continue;

    // Deduplicate by base URL (strip query string and fragment)
    const baseKey = url.split('?')[0].split('#')[0];
    if (seen.has(baseKey)) continue;
    seen.add(baseKey);

    const altM = attrs.match(/\balt=["']([^"']*)["']/i);
    const alt = altM ? altM[1] : '';

    // Extract explicit width/height attributes (handle both quoted and unquoted)
    const wAttrM = attrs.match(/\bwidth=["']?(\d+)["']?/i);
    const hAttrM = attrs.match(/\bheight=["']?(\d+)["']?/i);
    const wAttr = wAttrM ? parseInt(wAttrM[1]) : null;
    const hAttr = hAttrM ? parseInt(hAttrM[1]) : null;

    // Filter tracking pixels: explicit dimension < 10px
    if ((wAttr !== null && wAttr < 10) || (hAttr !== null && hAttr < 10)) continue;

    // Filter content images: keep if no explicit width, or width >= 200px
    // Icons/thumbnails with explicit width 10–199 are excluded
    if (wAttr !== null && wAttr < 200) continue;

    // Filter ad/tracking domains
    const urlLower = url.toLowerCase();
    if (AD_TRACKING_DOMAINS.some(d => urlLower.includes(d))) continue;

    if (url.includes('.gif')) {
      gifs.push({ url, alt });
    } else if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(url) || url.startsWith('https://')) {
      images.push({ url, alt });
    }
  }

  const tableRegex = /<table[\s\S]*?<\/table>/gi;
  while ((match = tableRegex.exec(rawHtml)) !== null) {
    tables.push({ html: match[0], caption: '' });
  }

  return { images, gifs, tables };
}

module.exports = { generateShowcaseHtml, extractVisualAssets };

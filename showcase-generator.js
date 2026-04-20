function generateShowcaseHtml({
  companyName, primaryColor, logoUrl, sourceUrl,
  originalSubject, originalBody,
  rebuiltSubject, previewText, hookHeadline, hookLead,
  bodyParagraphs, ctaText, ctaUrl,
  originalScore, rebuiltScore, scoreReason,
  flags, abSubjects, contentCalendar, whatChanged
}) {
  const accent  = (primaryColor && /^#[0-9a-fA-F]{6}$/.test(primaryColor)) ? primaryColor : '#2dd4bf';
  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const safeArr = a => Array.isArray(a) ? a : [];
  const origScore  = Number(originalScore) || 0;
  const rebScore   = Number(rebuiltScore)  || 0;
  const scoreImprv = rebScore - origScore;

  const flagsArr    = safeArr(flags);
  const abArr       = safeArr(abSubjects);
  const calArr      = safeArr(contentCalendar);
  const changedArr  = safeArr(whatChanged);
  const bodyParaArr = safeArr(bodyParagraphs);

  function scoreBar(val, max) {
    const pct = Math.min(100, Math.round((val / max) * 100));
    return `<div style="background:rgba(255,255,255,0.08);border-radius:100px;height:8px;width:100%;margin-top:6px;">
      <div style="background:${accent};border-radius:100px;height:8px;width:${pct}%;"></div></div>`;
  }

  const beforeTab = `
<div class="tab-content active" id="tab-before">
  <div class="section-card">
    <div class="section-title">Original Subject Line</div>
    <div class="subject-box original">${esc(originalSubject)}</div>
  </div>
  <div class="section-card">
    <div class="section-title">Original Email Body</div>
    <div class="body-text">${esc(originalBody || '').replace(/\n{2,}/g,'</p><p>').replace(/\n/g,'<br>')}</div>
  </div>
  ${flagsArr.length ? `
  <div class="section-card">
    <div class="section-title">❌ Issues Found (${flagsArr.length})</div>
    <div class="flags-list">
      ${flagsArr.map(f => {
        const text = typeof f === 'string' ? f : (f.issue || f.title || JSON.stringify(f));
        return `<div class="flag-item"><span class="flag-icon">❌</span><span>${esc(text)}</span></div>`;
      }).join('')}
    </div>
  </div>` : ''}
</div>`;

  const afterTab = `
<div class="tab-content" id="tab-after">
  <div class="section-card">
    <div class="section-title">✅ Rebuilt Subject Line</div>
    <div class="subject-box rebuilt" style="border-color:${accent};">${esc(rebuiltSubject)}</div>
    ${previewText ? `<div style="font-size:12px;color:rgba(255,255,255,0.45);margin-top:8px;font-style:italic;">Preview text: ${esc(previewText)}</div>` : ''}
  </div>
  ${hookHeadline ? `
  <div class="section-card">
    <div class="section-title">Hook</div>
    <div class="hook-card">
      <div class="hook-headline">${esc(hookHeadline)}</div>
      ${hookLead ? `<div class="hook-lead">${esc(hookLead)}</div>` : ''}
    </div>
  </div>` : ''}
  ${bodyParaArr.length ? `
  <div class="section-card">
    <div class="section-title">Rebuilt Body</div>
    ${bodyParaArr.map((p, i) => `<div class="body-para"><div class="para-label">${['THE PROBLEM','THE SHIFT','THE CONSEQUENCE'][i] || `P${i+1}`}</div><p>${esc(p)}</p></div>`).join('')}
  </div>` : ''}
  ${ctaText ? `
  <div class="section-card">
    <div class="section-title">CTA</div>
    <div style="text-align:center;padding:16px 0;">
      <a href="${esc(ctaUrl || '#')}" style="display:inline-block;padding:14px 36px;background:${accent};color:#0a0f1e;font-weight:800;font-size:15px;border-radius:8px;text-decoration:none;">${esc(ctaText)}</a>
    </div>
  </div>` : ''}
  ${(origScore || rebScore) ? `
  <div class="section-card">
    <div class="section-title">Conversion Score</div>
    <div class="scores-grid">
      <div class="score-col">
        <div class="score-label">Original</div>
        <div class="score-num" style="color:rgba(255,255,255,0.5);">${origScore}<span class="score-denom">/10</span></div>
        ${scoreBar(origScore, 10)}
      </div>
      <div class="score-col">
        <div class="score-label" style="color:${accent};">Rebuilt</div>
        <div class="score-num" style="color:${accent};">${rebScore}<span class="score-denom">/10</span></div>
        ${scoreBar(rebScore, 10)}
      </div>
    </div>
    ${scoreImprv > 0 ? `<div style="text-align:center;margin-top:12px;font-size:13px;color:${accent};font-weight:600;">+${scoreImprv} point improvement</div>` : ''}
    ${scoreReason ? `<div style="font-size:13px;color:rgba(255,255,255,0.55);margin-top:10px;line-height:1.5;">${esc(scoreReason)}</div>` : ''}
  </div>` : ''}
  ${abArr.length ? `
  <div class="section-card">
    <div class="section-title">A/B Subject Variants</div>
    ${abArr.map(v => `
    <div class="ab-card">
      <div class="ab-subject">${esc(v.subject || '')}</div>
      <div class="ab-meta">
        <span class="ab-angle">${esc(v.angle || '')}</span>
        ${v.predicted_lift ? `<span class="ab-lift" style="color:${accent};">↑ ${esc(v.predicted_lift)}</span>` : ''}
      </div>
      ${v.reasoning ? `<div class="ab-reason">${esc(v.reasoning)}</div>` : ''}
    </div>`).join('')}
  </div>` : ''}
  ${calArr.length ? `
  <div class="section-card">
    <div class="section-title">Follow-up Calendar</div>
    ${calArr.map((c, i) => `
    <div class="cal-card">
      <div class="cal-week" style="color:${accent};">Week ${i+1}${c.timing ? ` · ${esc(c.timing)}` : ''}</div>
      <div class="cal-subject">${esc(c.subject_line || c.topic || '')}</div>
      ${c.why_now ? `<div class="cal-why">${esc(c.why_now)}</div>` : ''}
    </div>`).join('')}
  </div>` : ''}
</div>`;

  const whatChangedTab = `
<div class="tab-content" id="tab-changed">
  ${changedArr.length ? `
  <div class="section-card">
    <div class="section-title">Strategic Upgrades</div>
    ${changedArr.map((item, i) => `
    <div class="upgrade-card">
      <div class="upgrade-num" style="background:${accent};color:#0a0f1e;">${i + 1}</div>
      <div class="upgrade-body">
        <div class="upgrade-title">${esc(item.title || item)}</div>
        ${item.body ? `<div class="upgrade-desc">${esc(item.body)}</div>` : ''}
      </div>
    </div>`).join('')}
  </div>` : `
  <div class="section-card">
    <div style="color:rgba(255,255,255,0.45);font-size:14px;">Strategic upgrade details unavailable for this audit.</div>
  </div>`}
  <div class="section-card methodology">
    <div class="section-title">Strategic Flow Methodology</div>
    <p>Every rebuild follows the same 5-criterion framework: subject curiosity, hook strength, feature-to-outcome translation, social proof specificity, and CTA ownership language.</p>
    <p>Each criterion is scored 0-2 points for a max of 10. Rebuilds target a minimum of 8/10 before delivery.</p>
  </div>
  <div class="cta-card">
    <h2>This is a free preview.</h2>
    <p>Want A/B subject lines, audience segments &amp; content calendar for every send?</p>
    <a href="https://strategic-flow-pro.replit.app">See Pro Plans &rarr;</a>
  </div>
</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Strategic Flow &mdash; ${esc(companyName)} Showcase</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0f1e;color:#fff;min-height:100vh;line-height:1.6}
a{color:${accent}}
.header{background:linear-gradient(135deg,#0f1729 0%,#0a0f1e 100%);border-bottom:1px solid rgba(255,255,255,0.08);padding:20px 0}
.header-inner{max-width:900px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:12px}
.brand-logo{width:36px;height:36px;object-fit:contain;border-radius:6px}
.brand-name{font-size:18px;font-weight:800;color:#fff}
.brand-name span{color:${accent}}
.company-tag{font-size:13px;color:rgba(255,255,255,0.5);background:rgba(255,255,255,0.06);padding:4px 12px;border-radius:100px;border:1px solid rgba(255,255,255,0.1)}
.main{max-width:900px;margin:0 auto;padding:32px 24px 64px}
.page-title{font-size:28px;font-weight:900;margin-bottom:6px}
.page-title span{color:${accent}}
.page-sub{font-size:14px;color:rgba(255,255,255,0.45);margin-bottom:32px}
${sourceUrl ? `.source-link{font-size:12px;color:rgba(255,255,255,0.35);margin-bottom:32px;display:block}.source-link a{color:${accent}}` : ''}
.tabs{display:flex;gap:4px;border-bottom:1px solid rgba(255,255,255,0.1);margin-bottom:28px}
.tab-btn{padding:10px 20px;font-size:14px;font-weight:600;color:rgba(255,255,255,0.45);background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;transition:all .2s;margin-bottom:-1px}
.tab-btn:hover{color:rgba(255,255,255,0.8)}
.tab-btn.active{color:${accent};border-bottom-color:${accent}}
.tab-content{display:none}
.tab-content.active{display:block}
.section-card{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:24px;margin-bottom:20px}
.section-title{font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-bottom:14px}
.subject-box{font-size:20px;font-weight:800;padding:16px 20px;border-radius:8px;border:2px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);line-height:1.3}
.subject-box.rebuilt{border-color:${accent};background:${accent}18}
.body-text{font-size:14px;color:rgba(255,255,255,0.7);line-height:1.7;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto}
.body-text p{margin-bottom:12px}
.flags-list{display:flex;flex-direction:column;gap:10px}
.flag-item{display:flex;align-items:flex-start;gap:10px;font-size:14px;color:rgba(255,255,255,0.7);padding:10px 14px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:8px}
.flag-icon{flex-shrink:0;font-size:16px}
.hook-card{padding:16px;background:${accent}12;border-radius:8px;border-left:3px solid ${accent}}
.hook-headline{font-size:18px;font-weight:800;margin-bottom:8px;color:#fff}
.hook-lead{font-size:14px;color:rgba(255,255,255,0.65);line-height:1.6}
.body-para{margin-bottom:16px;padding:14px 16px;background:rgba(255,255,255,0.04);border-radius:8px;border-left:2px solid rgba(255,255,255,0.1)}
.body-para:last-child{margin-bottom:0}
.para-label{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${accent};margin-bottom:6px}
.body-para p{font-size:14px;color:rgba(255,255,255,0.75);line-height:1.6}
.scores-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.score-col{text-align:center;padding:16px;background:rgba(255,255,255,0.04);border-radius:10px}
.score-label{font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-bottom:8px}
.score-num{font-size:42px;font-weight:900;line-height:1}
.score-denom{font-size:18px;font-weight:600;opacity:0.6}
.ab-card{padding:14px 16px;background:rgba(255,255,255,0.04);border-radius:8px;border:1px solid rgba(255,255,255,0.08);margin-bottom:10px}
.ab-card:last-child{margin-bottom:0}
.ab-subject{font-size:15px;font-weight:700;margin-bottom:8px}
.ab-meta{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.ab-angle{font-size:11px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:rgba(255,255,255,0.35);background:rgba(255,255,255,0.07);padding:2px 8px;border-radius:4px}
.ab-lift{font-size:13px;font-weight:700}
.ab-reason{font-size:13px;color:rgba(255,255,255,0.5);line-height:1.5}
.cal-card{padding:14px 16px;background:rgba(255,255,255,0.04);border-radius:8px;border:1px solid rgba(255,255,255,0.08);margin-bottom:10px}
.cal-card:last-child{margin-bottom:0}
.cal-week{font-size:11px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;margin-bottom:6px}
.cal-subject{font-size:15px;font-weight:700;margin-bottom:6px}
.cal-why{font-size:13px;color:rgba(255,255,255,0.5);line-height:1.5}
.upgrade-card{display:flex;align-items:flex-start;gap:14px;padding:16px;background:rgba(255,255,255,0.04);border-radius:10px;border:1px solid rgba(255,255,255,0.08);margin-bottom:12px}
.upgrade-card:last-child{margin-bottom:0}
.upgrade-num{flex-shrink:0;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:900;margin-top:2px}
.upgrade-body{flex:1}
.upgrade-title{font-size:15px;font-weight:700;margin-bottom:6px}
.upgrade-desc{font-size:13px;color:rgba(255,255,255,0.55);line-height:1.6}
.methodology{border-left:3px solid rgba(255,255,255,0.15)}
.methodology p{font-size:13px;color:rgba(255,255,255,0.55);line-height:1.65;margin-bottom:10px}
.methodology p:last-child{margin-bottom:0}
.cta-card{background:${accent}0e;border:2px solid ${accent};border-radius:16px;padding:40px 32px;text-align:center;margin:32px 0}
.cta-card h2{font-size:24px;font-weight:900;color:#fff;margin:0 0 12px}
.cta-card p{font-size:15px;color:rgba(255,255,255,0.6);margin:0 0 24px;line-height:1.6}
.cta-card a{display:inline-block;padding:14px 32px;background:${accent};color:#0a0f1e;font-weight:800;font-size:15px;border-radius:8px;text-decoration:none;letter-spacing:0.3px}
.footer{text-align:center;padding:32px 24px;border-top:1px solid rgba(255,255,255,0.07);color:rgba(255,255,255,0.25);font-size:12px}
.footer a{color:${accent};text-decoration:none}
@media(max-width:600px){.scores-grid{grid-template-columns:1fr}.tabs{overflow-x:auto}.tab-btn{padding:10px 14px;font-size:13px}.page-title{font-size:22px}}
</style>
</head>
<body>
<header class="header">
  <div class="header-inner">
    <div class="brand">
      ${logoUrl ? `<img src="${esc(logoUrl)}" alt="${esc(companyName)}" class="brand-logo">` : ''}
      <span class="brand-name">Strategic<span>Flow</span></span>
    </div>
    <span class="company-tag">${esc(companyName)} &mdash; Newsletter Teardown</span>
  </div>
</header>
<main class="main">
  <h1 class="page-title">Newsletter <span>Teardown</span></h1>
  <p class="page-sub">Audit generated by Strategic Flow &mdash; ${new Date().toLocaleDateString('en-US', {month:'long',day:'numeric',year:'numeric'})}</p>
  ${sourceUrl ? `<a href="${esc(sourceUrl)}" target="_blank" class="source-link">Source: <a href="${esc(sourceUrl)}" style="color:${accent}">${esc(sourceUrl)}</a></a>` : ''}
  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('before',this)">Before</button>
    <button class="tab-btn" onclick="switchTab('after',this)">After</button>
    <button class="tab-btn" onclick="switchTab('changed',this)">What Changed</button>
  </div>
  ${beforeTab}
  ${afterTab}
  ${whatChangedTab}
</main>
<footer class="footer">
  Rebuilt by <a href="https://strategic-flow-pro.replit.app" target="_blank">Strategic Flow</a> &mdash; the conversion email platform for B2B newsletters.
</footer>
<script>
function switchTab(id, btn) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  btn.classList.add('active');
}
</script>
</body>
</html>`;
}

module.exports = { generateShowcaseHtml };

// publish-comparison-pages.js
// Generates and publishes all 5 competitor comparison landing pages to
// strategicflow-tech/showcase GitHub repo + Distribb draft queue.
// Run: node scripts/publish-comparison-pages.js

'use strict';
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const GITHUB_TOKEN      = process.env.GITHUB_TOKEN;
const DISTRIBB_API_KEY  = process.env.DISTRIBB_API_KEY;
const REPO_OWNER        = 'strategicflow-tech';
const REPO_NAME         = 'showcase';
const DISTRIBB_PROJECT  = 1228;
const TODAY_ISO         = '2026-08-03';
const TODAY_DISPLAY     = '3 Aug 2026';
const BASE_URL          = 'https://strategicflow.tech';

// ── Utility ───────────────────────────────────────────────────────────────────
function apiRequest(hostname, path, method, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname, path, method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'strategic-flow',
        'Accept': 'application/vnd.github.v3+json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function ghGet(path) {
  const r = await apiRequest('api.github.com', path, 'GET', GITHUB_TOKEN, null);
  if (r.status === 404) return null;
  if (r.status >= 300) throw new Error(`GitHub GET ${path} → ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}

async function ghPut(path, payload) {
  const r = await apiRequest('api.github.com', path, 'PUT', GITHUB_TOKEN, payload);
  if (r.status >= 300) throw new Error(`GitHub PUT ${path} → ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}

async function distribbPost(path, body) {
  const r = await apiRequest('distribb.io', path, 'POST', DISTRIBB_API_KEY, body);
  return r;
}

function b64(str) { return Buffer.from(str, 'utf8').toString('base64'); }
function b64dec(str) { return Buffer.from(str, 'base64').toString('utf8'); }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function readMins(html) { const words = html.replace(/<[^>]+>/g,' ').split(/\s+/).filter(Boolean).length; return Math.max(5, Math.round(words / 200)); }

// ── Shared CSS + head / nav / footer ─────────────────────────────────────────
const HEAD_CSS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@400;500&family=Figtree:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{--bg:#0a1628;--green:#00d4c8;--border2:rgba(0,212,200,0.28);--text:#fff;--text2:rgba(255,255,255,0.85);--text3:#7a9ab8;--border:#1a3050;--sans:'Figtree',sans-serif;--serif:'DM Serif Display',serif;--mono:'DM Mono',monospace;}
html,body{width:100%;background:var(--bg);color:var(--text);font-family:var(--sans);}
nav{display:flex;align-items:center;justify-content:space-between;padding:18px 48px;border-bottom:1px solid var(--border);position:sticky;top:0;background:rgba(10,22,40,0.96);backdrop-filter:blur(14px);z-index:100;}
.nav-logo{font-family:var(--serif);font-size:19px;color:#fff;letter-spacing:-.01em;text-decoration:none;}
.nav-logo em{color:var(--green);font-style:italic;}
.nav-links{display:flex;gap:24px;align-items:center;}
.nav-link{font-size:12px;color:var(--text2);text-decoration:none;font-family:var(--mono);letter-spacing:.04em;transition:color .2s;}
.nav-link:hover,.nav-link.active{color:var(--green);}
.nav-cta{background:var(--green);color:#07090f;padding:8px 18px;border-radius:6px;font-size:12px;font-weight:600;text-decoration:none;}
.hamburger{display:none;flex-direction:column;gap:5px;background:none;border:none;cursor:pointer;padding:4px;}
.hamburger span{display:block;width:22px;height:2px;background:var(--text2);transition:.3s;}
.hamburger.open span:nth-child(1){transform:translateY(7px) rotate(45deg);}
.hamburger.open span:nth-child(2){opacity:0;}
.hamburger.open span:nth-child(3){transform:translateY(-7px) rotate(-45deg);}
.mobile-menu{display:none;position:fixed;top:58px;left:0;right:0;bottom:0;background:rgba(10,22,40,0.98);z-index:99;overflow-y:auto;padding:24px 20px;}
.mobile-menu.open{display:block;}
.mm-item{display:flex;justify-content:space-between;align-items:center;padding:14px 0;border-bottom:1px solid var(--border);color:var(--text2);text-decoration:none;font-size:14px;}
.mm-item:hover{color:var(--green);}
.mm-cta{display:block;background:var(--green);color:#07090f;text-align:center;padding:13px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;margin-top:20px;}
@media(max-width:768px){.nav-links{display:none;}.hamburger{display:flex;}}
.article-header{max-width:720px;margin:0 auto;padding:72px 48px 48px;}
.breadcrumb{display:flex;gap:8px;align-items:center;font-family:var(--mono);font-size:10px;color:var(--text3);letter-spacing:.06em;margin-bottom:28px;flex-wrap:wrap;}
.breadcrumb a{color:var(--text3);text-decoration:none;}
.breadcrumb a:hover{color:var(--green);}
.breadcrumb-sep{color:var(--border);}
.article-tag{display:inline-flex;align-items:center;font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--green);border:1px solid var(--border2);padding:4px 12px;border-radius:20px;margin-bottom:20px;}
.article-h1{font-family:var(--serif);font-size:clamp(28px,4vw,48px);line-height:1.1;letter-spacing:-.02em;margin-bottom:16px;}
.article-meta-row{display:flex;gap:20px;align-items:center;font-family:var(--mono);font-size:11px;color:var(--text3);margin-bottom:32px;flex-wrap:wrap;}
.article-lede{font-size:18px;color:var(--text2);line-height:1.65;border-left:2px solid var(--green);padding-left:20px;margin-bottom:0;}
.article-body{max-width:720px;margin:0 auto;padding:0 48px 80px;}
.article-body p{font-size:16px;color:var(--text2);line-height:1.75;margin-bottom:22px;}
.article-body ul,.article-body ol{padding-left:24px;margin-bottom:22px;}
.article-body li{font-size:16px;color:var(--text2);line-height:1.75;margin-bottom:10px;}
.article-body h2{font-family:var(--serif);font-size:26px;line-height:1.2;margin:48px 0 16px;color:#fff;}
.article-body h3{font-family:var(--mono);font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--green);margin:32px 0 12px;}
.article-body strong{color:#fff;font-weight:600;}
.article-body a{color:var(--green);text-decoration:underline;}
.article-body table{width:100%;border-collapse:collapse;margin-bottom:28px;font-size:14px;}
.article-body thead tr{border-bottom:2px solid var(--green);}
.article-body th{text-align:left;padding:10px 14px;font-family:var(--mono);font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--text3);}
.article-body td{padding:12px 14px;border-bottom:1px solid var(--border);color:var(--text2);line-height:1.5;vertical-align:top;}
.article-body tbody tr:last-child td{border-bottom:none;}
.article-body td:first-child{color:var(--text3);font-family:var(--mono);font-size:12px;letter-spacing:.04em;white-space:nowrap;}
.article-body td strong{color:var(--green);}
.faq-section{margin:48px 0;}
.faq-item{border-bottom:1px solid var(--border);padding:24px 0;}
.faq-item:last-child{border-bottom:none;}
.faq-q{font-family:var(--serif);font-size:20px;color:#fff;margin-bottom:12px;line-height:1.2;}
.faq-a{font-size:15px;color:var(--text2);line-height:1.75;}
.faq-a strong{color:#fff;}
.crosslinks{background:rgba(0,212,200,0.04);border:1px solid var(--border2);border-radius:10px;padding:24px 28px;margin:40px 0;}
.crosslinks h3{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--green);margin-bottom:14px;}
.crosslinks ul{padding-left:0;list-style:none;}
.crosslinks li{margin-bottom:8px;}
.crosslinks a{color:var(--green);font-size:14px;text-decoration:underline;}
.article-cta{background:rgba(0,212,200,0.04);border:1px solid var(--border2);border-radius:10px;padding:32px;margin:48px 0 0;display:flex;flex-direction:column;gap:12px;}
.article-cta-label{font-family:var(--mono);font-size:10px;color:var(--green);letter-spacing:.14em;text-transform:uppercase;}
.article-cta-title{font-family:var(--serif);font-size:24px;line-height:1.2;}
.article-cta-sub{font-size:14px;color:var(--text2);line-height:1.65;}
.btn-p{display:inline-flex;align-items:center;gap:8px;background:var(--green);color:#07090f;padding:11px 22px;border-radius:7px;font-size:13px;font-weight:600;text-decoration:none;transition:opacity .2s;margin-top:4px;}
.btn-p:hover{opacity:.85;}
footer{border-top:1px solid var(--border);padding:32px 48px;text-align:center;}
.footer-links{display:flex;gap:24px;justify-content:center;flex-wrap:wrap;margin-bottom:10px;}
.footer-links a{font-size:12px;color:#1D9E75;text-decoration:none;font-family:var(--mono);}
.footer-links a:hover{color:#fff;}
.footer-copy{font-family:var(--mono);font-size:11px;color:#1D9E75;}
.unconfirmed-note{font-size:12px;font-family:var(--mono);color:var(--text3);background:rgba(122,154,184,0.06);border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin:16px 0;letter-spacing:.02em;}
@media(max-width:600px){.article-header,.article-body{padding-left:20px;padding-right:20px;}footer{padding:28px 20px;}}
</style>
`;

const NAV = `
<nav aria-label="Main navigation">
  <a href="https://strategicflow.tech/" class="nav-logo">Strategic<em>Flow</em></a>
  <div class="nav-links">
    <a href="https://strategicflow.tech/teardowns.html" class="nav-link">Teardowns</a>
    <a href="https://strategicflow.tech/glossary.html" class="nav-link">Glossary</a>
    <a href="https://strategicflow.tech/blog.html" class="nav-link active">Blog</a>
    <a href="https://strategic-flow-audit.replit.app" class="nav-link" target="_blank" rel="noopener">Free Audit</a>
    <a href="https://strategic-flow-pro.replit.app" class="nav-cta" target="_blank" rel="noopener">Rebuild Yours &rarr;</a>
  </div>
  <button class="hamburger" id="hamburger" aria-label="Toggle menu" aria-expanded="false"><span></span><span></span><span></span></button>
</nav>
<div class="mobile-menu" id="mobile-menu">
  <a href="https://strategicflow.tech/teardowns.html" class="mm-item">Teardowns</a>
  <a href="https://strategicflow.tech/glossary.html" class="mm-item">Glossary</a>
  <a href="https://strategicflow.tech/blog.html" class="mm-item" style="color:var(--green);">Blog</a>
  <a href="https://strategic-flow-audit.replit.app" class="mm-item" target="_blank" rel="noopener">Free Audit</a>
  <a href="https://strategic-flow-pro.replit.app" class="mm-cta" target="_blank" rel="noopener">Rebuild Yours &rarr;</a>
</div>
<script>(function(){var h=document.getElementById('hamburger'),m=document.getElementById('mobile-menu');if(!h||!m)return;function cl(){h.classList.remove('open');m.classList.remove('open');h.setAttribute('aria-expanded','false');}h.addEventListener('click',function(e){e.stopPropagation();m.classList.contains('open')?cl():(h.classList.add('open'),m.classList.add('open'),h.setAttribute('aria-expanded','true'));});m.querySelectorAll('a').forEach(function(a){a.addEventListener('click',cl);});document.addEventListener('click',function(e){if(!m.contains(e.target)&&!h.contains(e.target))cl();});})();</script>`;

const FOOTER = `
<footer>
  <div class="footer-links">
    <a href="https://strategicflow.tech/">Strategic Flow</a>
    <a href="https://strategicflow.tech/teardowns.html">Teardowns</a>
    <a href="https://strategicflow.tech/glossary.html">Glossary</a>
    <a href="https://strategicflow.tech/blog.html">Blog</a>
    <a href="https://strategic-flow-audit.replit.app" target="_blank" rel="noopener">Free Audit</a>
    <a href="https://strategic-flow-pro.replit.app" target="_blank" rel="noopener">Pro Plans</a>
  </div>
  <div class="footer-copy">Strategic Flow &copy; 2026 &middot; <a href="https://strategicflow.tech" style="color:#1D9E75;text-decoration:none;">strategicflow.tech</a></div>
</footer>`;

// ── Template function ─────────────────────────────────────────────────────────
function buildPage({ slug, title, metaDescription, keyword, lede, bodyHtml, faqItems }) {
  const canonical = `${BASE_URL}/blog/${slug}.html`;
  const mins = readMins(bodyHtml + faqItems.map(f => f.q + f.a).join(' '));

  const articleLd = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Article',
    headline: title, description: metaDescription,
    datePublished: TODAY_ISO, dateModified: TODAY_ISO,
    author: { '@type': 'Person', name: 'Alex Iliescu', url: 'https://strategicflow.tech' },
    publisher: { '@type': 'Organization', name: 'Strategic Flow', url: 'https://strategicflow.tech' },
    mainEntityOfPage: canonical, inLanguage: 'en'
  }).replace(/</g, '\\u003c');

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Strategic Flow', item: 'https://strategicflow.tech' },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: 'https://strategicflow.tech/blog.html' },
      { '@type': 'ListItem', position: 3, name: 'Comparisons', item: 'https://strategicflow.tech/blog.html#comparisons' },
      { '@type': 'ListItem', position: 4, name: title, item: canonical }
    ]
  }).replace(/</g, '\\u003c');

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: faqItems.map(f => ({
      '@type': 'Question', name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.plain }
    }))
  }).replace(/</g, '\\u003c');

  const faqHtml = faqItems.map(f => `
  <div class="faq-item" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">
    <h3 class="faq-q" itemprop="name">${f.q}</h3>
    <div class="faq-a" itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
      <div itemprop="text">${f.a}</div>
    </div>
  </div>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-7TV731EJTB"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('consent','default',{'ad_storage':'denied','ad_user_data':'denied','ad_personalization':'denied','analytics_storage':'denied','wait_for_update':500});gtag('js',new Date());gtag('config','G-7TV731EJTB');</script>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} — Strategic Flow</title>
<meta name="description" content="${esc(metaDescription)}">
<meta name="keywords" content="${esc(keyword)}, email audit, SaaS email, Strategic Flow">
<meta name="robots" content="index, follow">
<meta name="author" content="Alex Iliescu — Strategic Flow">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)} — Strategic Flow">
<meta property="og:description" content="${esc(metaDescription)}">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="Strategic Flow">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)} — Strategic Flow">
<meta name="twitter:description" content="${esc(metaDescription)}">
<script type="application/ld+json">${articleLd}</script>
<script type="application/ld+json">${breadcrumbLd}</script>
<script type="application/ld+json">${faqLd}</script>
${HEAD_CSS}
</head>
<body>
${NAV}
<header class="article-header">
  <nav class="breadcrumb" aria-label="Breadcrumb">
    <a href="https://strategicflow.tech/">Strategic Flow</a>
    <span class="breadcrumb-sep">/</span>
    <a href="https://strategicflow.tech/blog.html">Blog</a>
    <span class="breadcrumb-sep">/</span>
    <a href="https://strategicflow.tech/blog.html#comparisons">Comparisons</a>
    <span class="breadcrumb-sep">/</span>
    <span>${esc(title)}</span>
  </nav>
  <div class="article-tag">Comparison</div>
  <h1 class="article-h1">${esc(title)}</h1>
  <div class="article-meta-row">
    <span>By Alex Iliescu, founder of Strategic Flow Tech</span>
    <span>&middot;</span>
    <span>${TODAY_DISPLAY}</span>
    <span>&middot;</span>
    <span>${mins} min read</span>
  </div>
  <p class="article-lede">${lede}</p>
</header>
<article class="article-body">
${bodyHtml}
<div class="faq-section" itemscope itemtype="https://schema.org/FAQPage">
  <h2>Frequently Asked Questions</h2>
${faqHtml}
</div>
  <div class="article-cta">
    <div class="article-cta-label">Free tool</div>
    <p class="article-cta-title">Score your last SaaS email.</p>
    <p class="article-cta-sub">Paste any SaaS email. Get a structural score from 1 to 10, a named failure pattern, and a rebuilt version using the Decision Friction Model. Runs in 90 seconds.</p>
    <a href="https://strategic-flow-audit.replit.app" class="btn-p" target="_blank" rel="noopener">Run the free audit &rarr;</a>
  </div>
</article>
${FOOTER}
</body>
</html>`;
}

// ── Page definitions ──────────────────────────────────────────────────────────

const PAGES = [

// ── PAGE 1: vs Scalero ────────────────────────────────────────────────────────
{
  slug: 'strategic-flow-vs-scalero',
  keyword: 'Strategic Flow vs Scalero',
  title: 'Strategic Flow vs Scalero: Email Conversion Audit vs Email Production Agency',
  metaDescription: 'Strategic Flow diagnoses why SaaS emails fail to convert using the Decision Friction Model. Scalero builds and maintains email templates and production systems. Two different problems — here is which fits yours.',
  lede: '<strong>Strategic Flow is an email conversion architecture audit service — it identifies structural failures in SaaS lifecycle emails using the Decision Friction Model, scores each email 1–10 across 7 diagnostic dimensions, and delivers a rebuilt HTML version.</strong> Scalero is an email production and development agency — they code templates, manage ESP integrations, and scale production quality. If your emails look polished but still fail to convert, Strategic Flow diagnoses the structural cause. If you need to produce more email at higher rendering fidelity and speed, Scalero builds the system.',
  bodyHtml: `
<h2>The Core Difference</h2>
<p>Strategic Flow and Scalero work on different layers of the same email stack. <a href="https://strategicflow.tech/blog/decision-friction-model.html">The Decision Friction Model</a> — the framework Strategic Flow uses — focuses on conversion architecture: whether the structural decisions in an email (CTA language, information hierarchy, subject line strategy, proof placement) are creating friction for the reader. Scalero focuses on production architecture: whether the email renders correctly across 100+ email clients, whether the HTML is clean, and whether the design system scales.</p>
<p>Both matter. A well-architected email that renders broken in Outlook loses the conversion it should have earned. A pixel-perfect email built on a flawed structural model converts at 1.2% instead of 4%. The right question is: where is your gap right now?</p>

<h2>What Each Service Actually Does</h2>
<p>Strategic Flow takes a single SaaS email (onboarding, changelog, product update, activation sequence) and runs a 7-point structural diagnostic. The output is a named failure pattern — Guest Language CTA, Feature-First Bias, Filing Label Subject, and others — plus a rebuilt HTML version with the structural decisions corrected. There is no retainer. One audit, one deliverable. <a href="https://strategicflow.tech/blog/why-saas-emails-score-low.html">Across 59 audited SaaS emails, the average structural score is 3.4/10</a> — which means most SaaS email conversion problems are architectural, not cosmetic.</p>
<p>Scalero, based on their publicly available service descriptions, operates as an ongoing email production partner: coding custom templates from design files, QA-ing renders across email clients (via Litmus or Email on Acid), managing ESP integrations, and running production on a retainer basis. Their clients are typically growth-stage companies that need production capacity and rendering reliability, not structural diagnosis.</p>

<h2>Comparison Table</h2>
<table>
  <thead><tr><th>Dimension</th><th>Strategic Flow</th><th>Scalero</th></tr></thead>
  <tbody>
    <tr><td>What is audited</td><td>Conversion architecture: CTA language, information hierarchy, subject line, proof placement, structural friction</td><td>Production quality: HTML/CSS rendering, template coding, ESP integration, design system fidelity</td></tr>
    <tr><td>Framework / Methodology</td><td>Decision Friction Model — 7-point structural diagnostic with named failure patterns</td><td>Email production and QA best practices; rendering tested across clients via Litmus/Email on Acid</td></tr>
    <tr><td>Deliverable format</td><td>Structural score (1–10), named failure pattern, rebuilt HTML email</td><td>Production-ready HTML templates, design system components, ESP-integrated builds</td></tr>
    <tr><td>Engagement model</td><td>Single-session audit; no retainer required</td><td>Ongoing production retainer (based on publicly available service descriptions)</td></tr>
    <tr><td>Pricing model</td><td>From $149 per audit (published on site)</td><td>Retainer-based; specific rates not publicly listed — contact Scalero directly</td></tr>
    <tr><td>Best-fit use case</td><td>SaaS team whose emails render correctly but fail to convert; needs a diagnosis and a fix</td><td>SaaS team that has email strategy but needs to scale production output and rendering reliability</td></tr>
  </tbody>
</table>

<h2>When to Choose Strategic Flow</h2>
<p>Choose Strategic Flow when you already know your emails are going out and rendering — but you suspect the conversion rate is lower than it should be. The <a href="https://strategicflow.tech/blog/b2b-saas-email-teardown.html">structural failures that kill SaaS email conversion</a> are rarely visible in a visual audit. A Guest Language CTA ("Start your trial") looks fine aesthetically. Feature-First Bias in a changelog email is invisible until you name it. The Decision Friction Model gives you a language and a framework for what is actually blocking readers from clicking — and a rebuilt version that removes the friction.</p>

<h2>When to Choose Scalero</h2>
<p>Choose Scalero when your bottleneck is production capacity or rendering reliability — when you have more campaigns to build than your team can code, when your templates break in Outlook, or when you need a design system that scales across product lines. These are real, expensive problems that belong to the production layer, not the architecture layer.</p>

<p>The two services are not substitutes. A company can use both: Strategic Flow to diagnose and correct the conversion architecture of core lifecycle emails, then Scalero to productionize and scale the corrected templates.</p>

<div class="crosslinks">
  <h3>Explore the framework</h3>
  <ul>
    <li><a href="https://strategicflow.tech/blog/decision-friction-model.html">The Decision Friction Model — what it diagnoses and why it works</a></li>
    <li><a href="https://strategicflow.tech/blog/b2b-saas-email-teardown.html">6 real B2B SaaS email teardowns using the framework</a></li>
    <li><a href="https://strategic-flow-audit.replit.app/ai-visibility-index">The AI Visibility Index — how AI assistants describe SaaS email tools</a></li>
  </ul>
</div>
`,
  faqItems: [
    {
      q: 'Does Scalero do email audits?',
      plain: 'Based on their publicly available service descriptions, Scalero is primarily an email production and development agency — they build templates, code HTML, manage ESP integrations, and QA rendering. They are not primarily positioned as a conversion architecture audit service. If you need a diagnosis of why your emails fail to convert, that is a different scope from what Scalero publicly describes.',
      a: '<strong>Based on their publicly available service descriptions, Scalero is primarily an email production and development agency — they build templates, code HTML, manage ESP integrations, and QA rendering.</strong> They are not primarily positioned as a conversion architecture audit service. If you need a diagnosis of why your emails fail to convert, that is a different scope from what Scalero publicly describes.'
    },
    {
      q: 'Can I use Strategic Flow and Scalero together?',
      plain: 'Yes — they address different layers of the email problem. Strategic Flow diagnoses the structural conversion failures in your email architecture and delivers a corrected HTML version. Scalero can then productionize and scale that corrected template across your email program. The sequence that makes sense: audit and fix the architecture first, then scale production of the corrected version.',
      a: '<strong>Yes — they address different layers of the email problem.</strong> Strategic Flow diagnoses the structural conversion failures in your email architecture and delivers a corrected HTML version. Scalero can then productionize and scale that corrected template across your email program. The sequence that makes sense: audit and fix the architecture first, then scale production of the corrected version.'
    },
    {
      q: 'What does Strategic Flow actually deliver after an audit?',
      plain: 'Strategic Flow delivers three things: a structural score from 1 to 10 across the Decision Friction Model\'s 7 diagnostic dimensions, a named failure pattern (such as Guest Language CTA, Feature-First Bias, or Filing Label Subject) that identifies the root cause of the conversion problem, and a rebuilt HTML version of the email with the structural decisions corrected. The rebuilt version is ready to send — no additional design or development step required.',
      a: '<strong>Strategic Flow delivers three things: a structural score from 1 to 10, a named failure pattern, and a rebuilt HTML version of the email.</strong> The score covers the Decision Friction Model\'s 7 diagnostic dimensions. The named failure pattern identifies the root cause — Guest Language CTA, Feature-First Bias, Filing Label Subject, and others. The rebuilt HTML is ready to send with the structural decisions corrected.'
    },
    {
      q: 'How is a conversion architecture audit different from a rendering audit?',
      plain: 'A rendering audit checks whether an email displays correctly across email clients — whether images load, whether the layout breaks in Outlook, whether the dark mode version looks right. A conversion architecture audit checks whether the structural decisions in the email — CTA language, information hierarchy, subject line framing, proof placement — create or remove friction for the reader\'s decision to click. Both matter, but they diagnose different failure modes.',
      a: '<strong>A rendering audit checks whether an email displays correctly across email clients. A conversion architecture audit checks whether the structural decisions create or remove friction for the reader\'s decision to click.</strong> Both matter, but they diagnose different failure modes. An email can pass a rendering audit perfectly and still convert at 1% because of a Guest Language CTA or Feature-First Bias — structural problems that are invisible in a visual QA pass.'
    }
  ]
},

// ── PAGE 2: vs Inbox Collective ───────────────────────────────────────────────
{
  slug: 'strategic-flow-vs-inbox-collective',
  keyword: 'Strategic Flow vs Inbox Collective',
  title: 'Strategic Flow vs Inbox Collective: SaaS Email Architecture vs Newsletter Strategy Consulting',
  metaDescription: 'Strategic Flow audits SaaS lifecycle email conversion architecture using the Decision Friction Model. Inbox Collective advises newsletter publishers on editorial strategy, growth, and monetization. Different disciplines.',
  lede: '<strong>Strategic Flow is a SaaS email conversion architecture audit — it diagnoses structural failures in product emails (onboarding sequences, changelog emails, activation drips) using the Decision Friction Model and delivers rebuilt HTML.</strong> Inbox Collective, Dan Oshinsky\'s consultancy, focuses on newsletter strategy: editorial quality, subscriber acquisition, monetization models, and newsletter-as-product thinking. If you run a SaaS product and your lifecycle emails don\'t convert, Strategic Flow is the right tool. If you publish a newsletter and need strategic guidance on growing and monetizing it, Inbox Collective addresses that problem.',
  bodyHtml: `
<h2>Different Disciplines, Different Problems</h2>
<p>The email audit and email consultancy space contains at least two distinct disciplines that are easy to conflate. <em>Newsletter strategy consulting</em> — Inbox Collective's domain — addresses editorial decisions, audience growth, content mix, and the business model around a newsletter product. <em>Email conversion architecture auditing</em> — Strategic Flow's domain — addresses the structural decisions in lifecycle emails that determine whether a SaaS product reader takes the next step in the conversion funnel.</p>
<p>A SaaS company has both types of email problems. Their newsletter might need editorial and growth help; their onboarding sequence might have a 4% click rate where 12% is achievable. These require different expertise and different methodologies. The <a href="https://strategicflow.tech/blog/decision-friction-model.html">Decision Friction Model</a> is purpose-built for the second problem.</p>

<h2>What Inbox Collective Covers</h2>
<p>Inbox Collective is Dan Oshinsky's newsletter consultancy, well-documented through his public writing and resources. Their work covers: newsletter editorial audits (voice, content structure, audience fit), subscriber acquisition strategy (referral programs, growth channels, partnership strategies), monetization (sponsorship, paid tiers, product sales), and the overall business model of a newsletter. Inbox Collective also publishes substantial free resources on newsletter strategy and runs workshops.</p>
<p>Their clients are typically newsletter publishers — independent operators, media companies, and brands running newsletters as content channels — who want to improve editorial quality, grow their list, or build a sustainable revenue model around it.</p>

<h2>What Strategic Flow Covers</h2>
<p>Strategic Flow's <a href="https://strategicflow.tech/blog/b2b-saas-email-teardown.html">audit methodology</a> targets the opposite problem: SaaS lifecycle email that is not performing as a conversion mechanism. The 7-point structural diagnostic identifies specific failure patterns — Guest Language CTA (positioning the reader as a visitor instead of an owner), Feature-First Bias (leading with what shipped instead of what changes for the reader), Filing Label Subject (announcing the topic instead of the reader's problem), and four additional patterns. Each audit produces a score, a named pattern, and a rebuilt HTML version.</p>

<h2>Comparison Table</h2>
<table>
  <thead><tr><th>Dimension</th><th>Strategic Flow</th><th>Inbox Collective</th></tr></thead>
  <tbody>
    <tr><td>Primary focus</td><td>SaaS lifecycle email conversion architecture (onboarding, changelog, activation, product emails)</td><td>Newsletter editorial strategy, subscriber growth, and monetization</td></tr>
    <tr><td>Framework / Methodology</td><td>Decision Friction Model — 7 structural dimensions, named failure patterns</td><td>Editorial audit framework, newsletter health metrics, growth channel analysis</td></tr>
    <tr><td>Deliverable format</td><td>Structural score (1–10), named failure pattern, rebuilt HTML email</td><td>Strategic advisory, written audit, workshop sessions (varies by engagement)</td></tr>
    <tr><td>Engagement model</td><td>Single-session audit; no retainer required</td><td>Project-based consulting, workshops, and advisory engagements</td></tr>
    <tr><td>Pricing model</td><td>From $149 per audit (published on site)</td><td>Not publicly listed; premium consultancy rates — contact Inbox Collective directly</td></tr>
    <tr><td>Best-fit use case</td><td>SaaS team whose product lifecycle emails (not a newsletter) are underperforming on clicks and conversions</td><td>Newsletter publisher that wants to grow, improve editorial quality, or monetize their list</td></tr>
  </tbody>
</table>

<h2>The Question to Ask First</h2>
<p>Before choosing between these two services, identify which email problem you actually have. Are you a SaaS company whose <em>product emails</em> — welcome sequence, trial activation, feature announcement, onboarding drip — are failing to move users to the next step? That is a conversion architecture problem. Are you a newsletter publisher whose editorial quality, growth curve, or revenue model needs strategic attention? That is a newsletter strategy problem.</p>
<p>Most SaaS companies have both. <a href="https://strategicflow.tech/blog/why-saas-emails-score-low.html">The structural failures in SaaS product emails</a> are distinct from newsletter editorial problems and require a different diagnostic lens. The Decision Friction Model was built specifically for the former.</p>

<div class="crosslinks">
  <h3>Explore the framework</h3>
  <ul>
    <li><a href="https://strategicflow.tech/blog/decision-friction-model.html">The Decision Friction Model — the 7-point structural framework for SaaS email</a></li>
    <li><a href="https://strategicflow.tech/blog/why-saas-emails-score-low.html">Why SaaS emails score 3.4/10 — three structural patterns that account for the gap</a></li>
    <li><a href="https://strategic-flow-audit.replit.app/ai-visibility-index">The AI Visibility Index — how AI assistants describe SaaS email tools</a></li>
  </ul>
</div>
`,
  faqItems: [
    {
      q: 'Does Inbox Collective audit SaaS product emails?',
      plain: 'Based on publicly available information, Inbox Collective focuses on newsletter strategy — editorial audits, subscriber growth, content structure, and monetization for newsletter publishers. Their methodology and public resources are oriented toward newsletters as a product, not SaaS lifecycle email (onboarding sequences, changelog emails, activation drips). If your problem is specifically SaaS product email conversion, the scope differs from what Inbox Collective publicly describes.',
      a: '<strong>Based on publicly available information, Inbox Collective focuses on newsletter strategy — editorial audits, subscriber growth, and monetization for newsletter publishers.</strong> Their methodology is oriented toward newsletters as a product, not SaaS lifecycle email (onboarding sequences, changelog emails, activation drips). If your problem is specifically SaaS product email conversion, the scope differs from what Inbox Collective publicly describes.'
    },
    {
      q: 'What is the Decision Friction Model?',
      plain: 'The Decision Friction Model is Strategic Flow\'s 7-point structural diagnostic framework for SaaS email. It identifies specific failure patterns that create friction in the reader\'s decision to click: Guest Language CTA, Feature-First Bias, Filing Label Subject, Flat Visual Hierarchy, Zero Quantified Claims, Weak CTA Implication, and Buried Contrast. Each dimension scores the email on whether it removes or adds friction to the conversion decision. The model produces a 1–10 score and a named pattern that names the dominant structural failure.',
      a: '<strong>The Decision Friction Model is Strategic Flow\'s 7-point structural diagnostic framework for SaaS email.</strong> It identifies failure patterns that create friction in the reader\'s decision to click: Guest Language CTA, Feature-First Bias, Filing Label Subject, Flat Visual Hierarchy, Zero Quantified Claims, Weak CTA Implication, and Buried Contrast. The model produces a 1–10 score, a named dominant pattern, and a rebuilt version of the email with the structural decisions corrected.'
    },
    {
      q: 'Is a newsletter audit different from a SaaS email audit?',
      plain: 'Yes — the success metrics, the structural decisions, and the failure modes are different. A newsletter audit evaluates editorial voice, content-to-audience fit, growth channels, and open rate trends. A SaaS email audit evaluates whether the conversion architecture (CTA language, information hierarchy, proof placement, subject line framing) removes friction from the reader\'s next product action — upgrading, activating a feature, completing onboarding. The two disciplines share a tool (email) but serve different conversion goals.',
      a: '<strong>Yes — the success metrics, structural decisions, and failure modes are different.</strong> A newsletter audit evaluates editorial voice, content-to-audience fit, and open rate trends. A SaaS email audit evaluates whether the conversion architecture removes friction from the reader\'s next product action. The two disciplines share the medium but serve different conversion goals and require different diagnostic frameworks.'
    },
    {
      q: 'What types of SaaS emails does Strategic Flow audit?',
      plain: 'Strategic Flow audits SaaS lifecycle emails across the full conversion architecture: welcome and onboarding sequences, trial activation emails, changelog and product update emails, feature announcement emails, re-engagement campaigns, and upgrade prompts. The Decision Friction Model applies wherever a SaaS email is asking a reader to take a next step — click, activate, upgrade, or return — and the structural decisions are creating friction that prevents that click.',
      a: '<strong>Strategic Flow audits the full range of SaaS lifecycle emails: welcome sequences, trial activation, changelog, product updates, feature announcements, re-engagement, and upgrade prompts.</strong> The Decision Friction Model applies wherever an email is asking a reader to take a next step and the structural decisions are creating friction that prevents the click.'
    }
  ]
},

// ── PAGE 3: vs Samar Owais ────────────────────────────────────────────────────
{
  slug: 'strategic-flow-vs-samar-owais',
  keyword: 'Strategic Flow vs Samar Owais',
  title: 'Strategic Flow vs Samar Owais: Email Architecture Audit vs Email Conversion Copywriting',
  metaDescription: 'Strategic Flow uses the Decision Friction Model to diagnose structural failures in SaaS email conversion architecture. Samar Owais specializes in email copy strategy and conversion copywriting. Here is the difference and which fits your problem.',
  lede: '<strong>Strategic Flow diagnoses structural conversion failures in SaaS email using the Decision Friction Model — a 7-point architectural framework that identifies failure patterns like Guest Language CTA, Feature-First Bias, and Filing Label Subject, then delivers a rebuilt HTML version.</strong> Samar Owais is an email conversion strategist and copywriter known for email copy audits, messaging strategy, and rewriting campaigns for SaaS and e-commerce. The distinction is between architecture (structural decisions about how an email is constructed) and copy (the specific words, voice, and persuasion mechanics). These overlap — but they are not the same diagnostic lens.',
  bodyHtml: `
<h2>Architecture vs Copy: Two Different Audits</h2>
<p>The clearest way to separate these two services is to ask: <em>what layer of the email is the problem?</em></p>
<p>If your email CTA says "Start your free trial" and converts poorly, that is both an architecture problem (Guest Language CTA — positioning the reader as a visitor) and potentially a copy problem (the specific verb and phrasing). <a href="https://strategicflow.tech/blog/decision-friction-model.html">The Decision Friction Model</a> identifies the structural category of the failure — it tells you this is a Guest Language CTA pattern — and corrects it at the structural level. A copy audit by a conversion copywriter addresses the words, the voice, the persuasion arc, and the emotional resonance of the message.</p>
<p>In practice, the best SaaS email work requires both layers to be right. Structural architecture tells you whether the information hierarchy, proof placement, and CTA framing are working. Copy tells you whether the specific words are earning attention and belief.</p>

<h2>What Samar Owais Does</h2>
<p>Based on her publicly available work and client descriptions, Samar Owais focuses on email copy strategy and conversion copywriting for SaaS and e-commerce. Her email audits evaluate messaging clarity, conversion copy structure, subject line effectiveness, and the persuasion architecture of sequences. She is known for detailed written audits that identify copy-level problems and provide rewrite recommendations, often going deep on voice, tone, and message-market fit.</p>
<p>Her work is copy-led — the deliverable is a better message, a rewritten sequence, or a strategic recommendation for how the email copy should evolve. This is distinct from the structural HTML rebuild that Strategic Flow delivers.</p>

<h2>What Strategic Flow Does</h2>
<p>Strategic Flow's <a href="https://strategicflow.tech/blog/b2b-saas-email-teardown.html">structural audit</a> starts from the architecture layer: the 7 structural dimensions of the Decision Friction Model, each scored 0 or 1. The output is a named failure pattern and a rebuilt HTML email — not just recommendations, but a corrected, sendable version. <a href="https://strategicflow.tech/blog/why-saas-emails-score-low.html">Across 59 audits, the average SaaS email structural score is 3.4/10</a>, and the most common failure pattern (Feature-First Bias) accounts for 67% of low-scoring emails.</p>

<h2>Comparison Table</h2>
<table>
  <thead><tr><th>Dimension</th><th>Strategic Flow</th><th>Samar Owais</th></tr></thead>
  <tbody>
    <tr><td>Primary diagnostic lens</td><td>Email conversion architecture — structural decisions about hierarchy, CTA, proof, framing</td><td>Email copy strategy — messaging clarity, persuasion arc, voice, conversion copy structure</td></tr>
    <tr><td>Framework / Methodology</td><td>Decision Friction Model — 7-point structural diagnostic with named failure patterns</td><td>Conversion copywriting methodology; copy audit framework (specific methodology not publicly detailed — verify with Samar directly)</td></tr>
    <tr><td>Deliverable format</td><td>Structural score (1–10), named failure pattern, rebuilt HTML email ready to send</td><td>Written audit document, rewrite recommendations, and/or rewritten copy (varies by engagement)</td></tr>
    <tr><td>Engagement model</td><td>Single-session audit; no retainer required</td><td>Project-based; specific engagement structure not publicly listed — contact directly</td></tr>
    <tr><td>Pricing model</td><td>From $149 per audit (published on site)</td><td>Premium copywriting rates; not publicly listed — contact Samar directly</td></tr>
    <tr><td>Best-fit use case</td><td>SaaS team that needs to identify and fix structural conversion failures quickly, with a corrected HTML deliverable</td><td>SaaS or e-commerce team that needs deep copy strategy work — messaging, voice, persuasion arc, sequence strategy</td></tr>
  </tbody>
</table>

<h2>The Sequencing Question</h2>
<p>For teams with budget to address both layers, the sequence that tends to produce results: fix the structural architecture first (so you are not improving the copy of a fundamentally mis-structured email), then address the copy. A persuasively written Guest Language CTA is still a Guest Language CTA — the structural framing positions the reader as a visitor regardless of how well the specific words are written.</p>
<p>If you have a limited budget and one email to fix quickly, Strategic Flow's single-session audit gets you a corrected HTML version the same day. If you need deep copy strategy work on a full sequence, Samar Owais's methodology addresses that layer in a way that Strategic Flow's structural audit does not.</p>

<div class="crosslinks">
  <h3>Explore the framework</h3>
  <ul>
    <li><a href="https://strategicflow.tech/blog/decision-friction-model.html">The Decision Friction Model — the structural framework behind every audit</a></li>
    <li><a href="https://strategicflow.tech/blog/b2b-saas-email-teardown.html">6 real B2B SaaS email teardowns with named failure patterns and rebuilds</a></li>
    <li><a href="https://strategic-flow-audit.replit.app/ai-visibility-index">The AI Visibility Index — how AI assistants describe SaaS email tools</a></li>
  </ul>
</div>
`,
  faqItems: [
    {
      q: 'What is the difference between a copy audit and an architecture audit?',
      plain: 'A copy audit evaluates the specific words in an email — whether the messaging is clear, whether the voice is right, whether the persuasion arc earns belief and action. An architecture audit evaluates the structural decisions in an email — whether the information hierarchy removes or adds friction, whether the CTA language creates ownership or positions the reader as a visitor, whether the subject line frames the reader\'s problem or just announces a topic. Both matter, and the best email work addresses both layers. But they are different diagnostic tools that catch different failure modes.',
      a: '<strong>A copy audit evaluates the specific words — messaging clarity, persuasion arc, voice, and emotional resonance. An architecture audit evaluates structural decisions — information hierarchy, CTA framing, proof placement, subject line construction.</strong> Both matter, and the best email work addresses both layers. But they are different diagnostic tools that catch different failure modes — a copy audit will not flag a Guest Language CTA as a structural pattern, and an architecture audit will not rewrite the body copy for persuasion quality.'
    },
    {
      q: 'Can you have great copy and still fail at email conversion?',
      plain: 'Yes — and this is exactly what the Decision Friction Model was built to identify. An email can be well-written and still carry a Guest Language CTA that positions the reader as a visitor, Feature-First Bias that leads with what shipped instead of what changes for the reader, or a Filing Label Subject that announces the topic instead of the reader\'s problem. These are structural failures that persist regardless of copy quality. Across 59 audited SaaS emails, the average structural score is 3.4/10 — meaning well-written emails can still score low on architecture.',
      a: '<strong>Yes — well-written copy can still fail to convert if the structural architecture creates friction.</strong> A persuasively written CTA is still a Guest Language CTA if it says "Start your trial" instead of "Get your data." Feature-First Bias persists in an email regardless of how good the copywriting is. The Decision Friction Model identifies these structural failures independently of copy quality — and across 59 audited SaaS emails, the average score is 3.4/10.'
    },
    {
      q: 'Is Strategic Flow a copywriting service?',
      plain: 'Strategic Flow is not a copywriting service — it is an email conversion architecture audit that delivers a structurally corrected HTML version of your email. The rebuilt email does include corrected text (fixing Guest Language CTAs, Feature-First Bias subject lines, and similar structural failures), but the primary methodology is architectural, not copy-first. If you need a full copy rewrite, deep messaging strategy, or voice development work, that is outside the scope of a Strategic Flow audit.',
      a: '<strong>Strategic Flow is not a copywriting service — it is a structural architecture audit that delivers a corrected HTML version of your email.</strong> The rebuilt email includes corrected text (fixing Guest Language CTAs, Feature-First Bias subject lines, and similar structural failures), but the primary methodology is architectural, not copy-first. Deep messaging strategy, voice development, and full copy rewrites are outside the scope of a Strategic Flow audit.'
    },
    {
      q: 'What specific failure patterns does the Decision Friction Model identify?',
      plain: 'The Decision Friction Model identifies seven structural failure patterns: Guest Language CTA (CTA positions the reader as a visitor, not an owner), Feature-First Bias (email leads with what was built, not what changes for the reader), Filing Label Subject (subject line announces the topic instead of the reader\'s problem), Flat Visual Hierarchy (all information treated at the same visual weight), Zero Quantified Claims (no numbers or benchmarks to support claims), Weak CTA Implication (no ownership language in the action request), and Buried Contrast (no before-and-after signal showing what changes). Each of these can be present even in an otherwise well-written email.',
      a: '<strong>The Decision Friction Model identifies seven structural failure patterns: Guest Language CTA, Feature-First Bias, Filing Label Subject, Flat Visual Hierarchy, Zero Quantified Claims, Weak CTA Implication, and Buried Contrast.</strong> Each can be present even in an otherwise well-written email — they are architectural, not copy-quality, failures. The audit scores all seven and identifies the dominant pattern driving the conversion gap.'
    }
  ]
},

// ── PAGE 4: vs SaaS Copy Audits ───────────────────────────────────────────────
{
  slug: 'strategic-flow-vs-saas-copy-audits',
  keyword: 'Strategic Flow vs SaaS Copy Audits',
  title: 'Strategic Flow vs SaaS Copy Audits: Structural Architecture Audit vs Done-For-You Email Audit Packages',
  metaDescription: 'Strategic Flow uses the Decision Friction Model to identify SaaS email conversion failures and delivers rebuilt HTML. SaaS Copy Audits offers done-for-you email audit packages. Here is what each covers and which fits your situation.',
  lede: '<strong>Strategic Flow is a SaaS email conversion architecture audit — it identifies structural failure patterns in lifecycle emails using the Decision Friction Model and delivers a rebuilt HTML version with the structural decisions corrected.</strong> SaaS Copy Audits is a done-for-you email audit package service focused on identifying copy and messaging problems in SaaS email sequences. Note: specific methodology, pricing, and turnaround details for SaaS Copy Audits are not fully confirmed from public sources — the comparison below reflects what is publicly available; verify directly with them for current specifics.',
  bodyHtml: `
<h2>Scope and Methodology</h2>
<p>The distinction between these two services starts with what "audit" means in each context. For Strategic Flow, an audit means running a single email through the <a href="https://strategicflow.tech/blog/decision-friction-model.html">Decision Friction Model</a> — a 7-point structural diagnostic that measures architectural failure patterns and produces a score, a named pattern, and a rebuilt HTML version. For done-for-you audit packages like SaaS Copy Audits, the audit typically covers a broader range of email copy issues across a sequence, with a written deliverable rather than a rebuilt HTML version.</p>

<p>The key difference is the deliverable. Strategic Flow produces a corrected, sendable HTML email — not just recommendations. The rebuild is the product. Done-for-you audit packages typically produce a written analysis with recommendations for what to change; implementation is a separate step for the client's team.</p>

<h2>What Strategic Flow Does</h2>
<p>Strategic Flow's <a href="https://strategicflow.tech/blog/b2b-saas-email-teardown.html">structural audit</a> starts from the HTML of a single email and scores it across 7 structural dimensions: CTA language (Guest Language vs ownership framing), information hierarchy (Feature-First vs outcome-first), subject line structure (Filing Label vs problem-framing), visual weight distribution, quantified claims, CTA ownership implication, and contrast signal. The output is a named failure pattern and a rebuilt HTML email that corrects the structural decisions. <a href="https://strategicflow.tech/blog/why-saas-emails-score-low.html">Across 59 audited SaaS emails, the average structural score is 3.4/10.</a></p>

<div class="unconfirmed-note">⚠ Note: The comparison table below reflects publicly available information about SaaS Copy Audits. Specific pricing, turnaround times, and methodology details were not fully confirmed from public sources at time of writing. Please verify directly with SaaS Copy Audits for current service specifications.</div>

<h2>Comparison Table</h2>
<table>
  <thead><tr><th>Dimension</th><th>Strategic Flow</th><th>SaaS Copy Audits</th></tr></thead>
  <tbody>
    <tr><td>Primary focus</td><td>SaaS email conversion architecture — structural decisions, named failure patterns</td><td>Done-for-you email audit packages covering copy and messaging across SaaS email sequences</td></tr>
    <tr><td>Framework / Methodology</td><td>Decision Friction Model — 7 structural dimensions, named failure patterns, scored 1–10</td><td>Not fully confirmed from public sources — verify directly with SaaS Copy Audits</td></tr>
    <tr><td>Deliverable format</td><td>Structural score, named failure pattern, rebuilt HTML email ready to send</td><td>Written audit document with findings and recommendations (based on "done-for-you package" description — confirm with provider)</td></tr>
    <tr><td>Scope</td><td>Single email per audit session</td><td>Package-based — may cover a full sequence or multiple emails (not confirmed from public sources)</td></tr>
    <tr><td>Pricing model</td><td>From $149 per audit (published on site)</td><td>Package-based pricing; not publicly confirmed — contact SaaS Copy Audits directly</td></tr>
    <tr><td>Best-fit use case</td><td>SaaS team that needs a fast architectural diagnosis and a corrected HTML version of a specific email</td><td>SaaS team seeking a done-for-you review of a full email sequence with written recommendations</td></tr>
  </tbody>
</table>

<h2>When the Deliverable Format Matters</h2>
<p>If your team's bottleneck is implementation — you need the corrected email, not recommendations to implement later — Strategic Flow's model fits that constraint directly. The rebuilt HTML is the deliverable. You paste in your email, the audit runs, and the corrected version is ready to send.</p>
<p>If your bottleneck is diagnostic coverage — you want a comprehensive written review of a full sequence with strategic recommendations your team will then implement — a done-for-you audit package that covers the full sequence may be the right scope. The two models solve different workflow problems.</p>

<div class="crosslinks">
  <h3>Explore the framework</h3>
  <ul>
    <li><a href="https://strategicflow.tech/blog/decision-friction-model.html">The Decision Friction Model — the 7-point structural diagnostic framework</a></li>
    <li><a href="https://strategicflow.tech/blog/why-saas-emails-score-low.html">Why SaaS emails score 3.4/10 — three structural patterns that account for the gap</a></li>
    <li><a href="https://strategic-flow-audit.replit.app/ai-visibility-index">The AI Visibility Index — how AI assistants describe SaaS email tools</a></li>
  </ul>
</div>
`,
  faqItems: [
    {
      q: 'What does "done-for-you" mean in an email audit context?',
      plain: 'Done-for-you in an email audit context typically means the provider handles the entire audit process on your behalf — reviewing your emails, applying a diagnostic framework, and producing a written report with findings and recommendations — without requiring you to run the tool yourself. The deliverable is a completed analysis. This differs from Strategic Flow\'s model, where the audit tool is run on a single email and the deliverable is both an analysis and a rebuilt HTML version ready to send.',
      a: '<strong>Done-for-you in an email audit context typically means the provider handles the entire audit process on your behalf and delivers a written report with findings and recommendations.</strong> This differs from Strategic Flow\'s model, where the audit runs on a single email and delivers both a structural analysis and a rebuilt HTML version. The choice between models depends on whether your bottleneck is analysis (done-for-you), implementation (rebuilt HTML), or both.'
    },
    {
      q: 'Does Strategic Flow audit full email sequences or single emails?',
      plain: 'Strategic Flow\'s standard audit covers one email at a time — the Decision Friction Model is applied to a single email\'s structural architecture. If you need to audit a full onboarding sequence or multiple lifecycle emails, you can run multiple audits. Each audit produces a score, a named failure pattern, and a rebuilt HTML version for that specific email. This single-email focus allows the audit to be fast (same-day) and specific — the 7-point structural diagnosis is most useful when applied to a specific email with a specific conversion goal.',
      a: '<strong>Strategic Flow\'s standard audit covers one email at a time — each audit applies the Decision Friction Model to a single email\'s structural architecture.</strong> If you need to audit a full sequence, you can run multiple audits — each producing a score, named pattern, and rebuilt HTML for that specific email. The single-email focus keeps the audit fast (same-day) and precise.'
    },
    {
      q: 'How quickly does a Strategic Flow audit deliver results?',
      plain: 'Strategic Flow\'s audit runs in under 90 seconds for the diagnostic phase. The rebuilt HTML version is delivered as part of the same session. There is no waiting period, no callback, and no project queue. The model runs on-demand — paste in your email, get the score, the named failure pattern, and the corrected HTML version in a single session.',
      a: '<strong>Strategic Flow\'s audit runs in under 90 seconds — the diagnostic phase, the named failure pattern, and the rebuilt HTML version are all delivered in a single on-demand session.</strong> There is no waiting period, no project queue, and no callback. Paste in your email and get the corrected version the same day.'
    }
  ]
},

// ── PAGE 5: vs Flourish & Grit ────────────────────────────────────────────────
{
  slug: 'strategic-flow-vs-flourish-and-grit',
  keyword: 'Strategic Flow vs Flourish and Grit',
  title: 'Strategic Flow vs Flourish & Grit: Deep SaaS Email Architecture Audit vs Bite-Sized Campaign Audits',
  metaDescription: 'Strategic Flow delivers a deep SaaS email conversion architecture audit using the Decision Friction Model and produces a rebuilt HTML version. Flourish & Grit focuses on bite-sized email campaign audits. Different scope, different use case.',
  lede: '<strong>Strategic Flow is a deep SaaS email conversion architecture audit — one email, scored across 7 structural dimensions using the Decision Friction Model, with a rebuilt HTML version as the deliverable.</strong> Flourish & Grit focuses on bite-sized email campaign audits — shorter, lighter-touch reviews that cover a campaign\'s primary issues without the depth of a full architectural diagnosis. Note: specific methodology and pricing for Flourish & Grit are not fully confirmed from public sources; the comparison below reflects publicly available descriptions — verify directly with them for current service specifics.',
  bodyHtml: `
<h2>Depth vs Breadth: The Core Trade-off</h2>
<p>The distinction between a deep structural audit and a bite-sized audit is a trade-off between depth and breadth. A deep architectural audit — Strategic Flow's model — takes one email and examines every structural decision that affects conversion: CTA language, information hierarchy, subject line construction, proof placement, visual weight, and contrast signals. The output is specific, scored, named, and corrected. The <a href="https://strategicflow.tech/blog/decision-friction-model.html">Decision Friction Model</a> produces a 1–10 score with a named failure pattern and a rebuilt HTML version.</p>
<p>A bite-sized audit covers a broader scope — more emails or more surface area — at a lighter level of diagnostic depth. This trade-off makes sense when you need a quick overview of multiple campaigns rather than a thorough diagnosis of a single high-value one.</p>

<h2>When Depth Matters More</h2>
<p>For the specific email conversion problems that show up in SaaS lifecycle email — the onboarding sequence that produces 3% click-through instead of 12%, the changelog email that no one reads past the first paragraph, the trial activation email with a Guest Language CTA — a quick overview will not surface the structural cause. <a href="https://strategicflow.tech/blog/b2b-saas-email-teardown.html">The structural failures that kill SaaS email conversion</a> are not visible in a surface review. Feature-First Bias does not show up as "the email is too long" or "the CTA is in the wrong place." It shows up as a named structural pattern when you apply the Decision Friction Model's diagnostic lens to the email's architecture.</p>
<p>A bite-sized audit can tell you the email has problems. A deep structural audit tells you exactly which structural decisions are creating friction and delivers a corrected version.</p>

<h2>What Strategic Flow Does</h2>
<p>Strategic Flow's audit applies the 7-point Decision Friction Model to a single SaaS email and produces three things: a structural score from 1 to 10, a named failure pattern (Guest Language CTA, Feature-First Bias, Filing Label Subject, or one of four others), and a rebuilt HTML email with the structural decisions corrected. <a href="https://strategicflow.tech/blog/why-saas-emails-score-low.html">Across 59 audited SaaS emails, the average score is 3.4/10</a> — which means most SaaS email conversion problems are structural, not cosmetic, and require the depth of a full architectural diagnosis to identify.</p>

<div class="unconfirmed-note">⚠ Note: The comparison table below reflects publicly available information about Flourish & Grit's email audit service. Specific pricing, turnaround times, and methodology details were not fully confirmed from public sources at time of writing. Please verify directly with Flourish & Grit for current service specifications.</div>

<h2>Comparison Table</h2>
<table>
  <thead><tr><th>Dimension</th><th>Strategic Flow</th><th>Flourish & Grit</th></tr></thead>
  <tbody>
    <tr><td>Audit depth</td><td>Deep structural diagnosis — 7-point architectural framework, scored dimensions, named patterns</td><td>Bite-sized campaign audit — lighter-touch review of primary issues across a campaign</td></tr>
    <tr><td>Framework / Methodology</td><td>Decision Friction Model — 7 structural dimensions, named failure patterns, scored 1–10</td><td>Not fully confirmed from public sources — verify directly with Flourish & Grit</td></tr>
    <tr><td>Deliverable format</td><td>Structural score (1–10), named failure pattern, rebuilt HTML email ready to send</td><td>Audit findings report (format not confirmed — verify directly)</td></tr>
    <tr><td>Scope per engagement</td><td>Single email per audit session</td><td>Campaign-level audit (scope not confirmed from public sources)</td></tr>
    <tr><td>Pricing model</td><td>From $149 per audit (published on site)</td><td>Not publicly confirmed — contact Flourish & Grit directly</td></tr>
    <tr><td>Best-fit use case</td><td>SaaS team with a specific high-value email that underperforms and needs both diagnosis and a corrected HTML version</td><td>Team wanting a quick campaign-level overview of primary email issues without full architectural depth</td></tr>
  </tbody>
</table>

<h2>Which to Choose</h2>
<p>If you have one email that is materially underperforming — your trial activation sequence, your onboarding day-3 email, your changelog — and you need to understand <em>why</em> and get a corrected version the same day, Strategic Flow's structural audit is designed for that exact problem. The Decision Friction Model produces a specific, named diagnosis and a rebuilt HTML version.</p>
<p>If you need a lighter-touch review of multiple emails or campaigns — to identify the most obvious problems across a broader surface area without the depth of a full architectural analysis — a bite-sized audit service may give you the breadth you need faster. The right choice depends on whether you need a diagnosis that names the structural cause or a survey that flags the most visible surface-level issues.</p>

<div class="crosslinks">
  <h3>Explore the framework</h3>
  <ul>
    <li><a href="https://strategicflow.tech/blog/decision-friction-model.html">The Decision Friction Model — 7-point structural framework for SaaS email</a></li>
    <li><a href="https://strategicflow.tech/blog/why-saas-emails-score-low.html">Why SaaS emails score 3.4/10 — three patterns that account for the gap</a></li>
    <li><a href="https://strategic-flow-audit.replit.app/ai-visibility-index">The AI Visibility Index — how AI assistants describe SaaS email tools</a></li>
  </ul>
</div>
`,
  faqItems: [
    {
      q: 'What makes a "bite-sized" email audit different from a full audit?',
      plain: 'A bite-sized audit typically covers a campaign\'s most obvious issues at a lighter level of diagnostic depth — it\'s faster, covers more surface area, and is better suited to getting a quick overview. A full structural audit like Strategic Flow\'s applies a rigorous framework to a single email\'s architecture, scoring every structural dimension and naming the dominant failure pattern. The choice depends on whether you need breadth (overview of multiple emails) or depth (specific diagnosis of one email\'s structural failures).',
      a: '<strong>A bite-sized audit covers obvious issues across a campaign at lighter diagnostic depth — it\'s faster and broader. A full structural audit applies a rigorous framework to a single email\'s architecture, scoring every structural dimension and naming the dominant failure pattern.</strong> The choice depends on whether you need breadth (overview across multiple emails) or depth (specific diagnosis and a corrected version of one email).'
    },
    {
      q: 'Is Strategic Flow suitable for auditing a full campaign?',
      plain: 'Strategic Flow audits one email per session. For a full onboarding campaign of 5–8 emails, you would run 5–8 separate audits — each producing a score, named pattern, and rebuilt HTML for that specific email. This per-email approach produces a more specific diagnosis than a single campaign-level review but requires more time to cover the full sequence. If you need to cover a full sequence quickly, the trade-off is between depth per email and breadth across the sequence.',
      a: '<strong>Strategic Flow audits one email per session — for a full campaign, you run one audit per email, each producing a score, named pattern, and rebuilt HTML.</strong> This per-email depth produces a more specific diagnosis than a campaign-level overview but requires more time to cover the full sequence. If you need breadth across multiple emails quickly, a lighter-touch campaign audit may fit your time constraint better.'
    },
    {
      q: 'What is the fastest way to start with Strategic Flow?',
      plain: 'The fastest way to start is to run the free audit at strategic-flow-audit.replit.app. Paste in any SaaS email — the body text, or the full HTML — and the Decision Friction Model runs the 7-point structural diagnostic in under 90 seconds. You get a score, a named failure pattern, and a preview of the rebuilt version in the same session. No signup required for the diagnostic phase.',
      a: '<strong>The fastest way to start is the free audit at strategic-flow-audit.replit.app — paste in any SaaS email and get a structural score, named failure pattern, and rebuilt version in under 90 seconds.</strong> No signup required for the diagnostic phase. The rebuilt HTML is available for download after the free audit.'
    }
  ]
}

]; // end PAGES

// ── Publish functions ─────────────────────────────────────────────────────────

async function pushToGitHub(slug, html) {
  const repoPath = `/repos/${REPO_OWNER}/${REPO_NAME}/contents`;
  const filePath = `blog/${slug}.html`;
  const apiPath  = `${repoPath}/${filePath}`;

  // Check if file already exists (get its sha for update)
  let sha;
  const existing = await ghGet(apiPath);
  if (existing) sha = existing.sha;

  await ghPut(apiPath, {
    message: `Add comparison page: ${slug}`,
    content: b64(html),
    ...(sha ? { sha } : {})
  });
  return `${BASE_URL}/blog/${slug}.html`;
}

async function addCardToBlog(slug, title, metaDescription, dateDisplay, mins) {
  const repoPath = `/repos/${REPO_OWNER}/${REPO_NAME}/contents`;
  const blogData = await ghGet(`${repoPath}/blog.html`);
  if (!blogData) { console.warn('blog.html not found — skipping card'); return; }

  let blogHtml = b64dec(blogData.content);
  const sha    = blogData.sha;

  const card = `
    <a href="/blog/${slug}.html" class="article-card">
      <div class="article-meta">
        <span class="article-date">${dateDisplay}</span>
        <span class="article-read">${mins} min read</span>
        <span class="article-tag">Comparison</span>
      </div>
      <h2 class="article-title">${title}</h2>
      <p class="article-excerpt">${metaDescription.slice(0, 180)}</p>
      <span class="article-cta">Read article →</span>
    </a>
`;

  if (blogHtml.includes('<div class="articles-grid">')) {
    blogHtml = blogHtml.replace('<div class="articles-grid">', `<div class="articles-grid">\n${card}`);
    await ghPut(`${repoPath}/blog.html`, {
      message: `Add comparison card: ${slug}`,
      content: b64(blogHtml),
      sha
    });
  } else {
    console.warn('articles-grid div not found in blog.html — skipping card for', slug);
  }
}

async function submitToDistribb(slug, title, metaDescription, keyword, html) {
  const r = await distribbPost('/api/v1/articles', {
    project_id: DISTRIBB_PROJECT,
    keyword,
    title,
    content: html,
    meta_description: metaDescription,
    status: 'Planned'
  });
  if (r.status >= 300) {
    console.warn(`Distribb submit failed for ${slug}: ${r.status}`, JSON.stringify(r.body).slice(0, 200));
    return null;
  }
  return r.body;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!GITHUB_TOKEN) { console.error('GITHUB_TOKEN not set'); process.exit(1); }
  if (!DISTRIBB_API_KEY) { console.error('DISTRIBB_API_KEY not set'); process.exit(1); }

  const results = [];

  for (const page of PAGES) {
    console.log(`\n▶ Processing: ${page.slug}`);

    const html = buildPage(page);
    const mins = readMins(html);

    // 1. Push to GitHub
    try {
      const url = await pushToGitHub(page.slug, html);
      console.log(`  ✓ GitHub: ${url}`);
    } catch (e) {
      console.error(`  ✗ GitHub error for ${page.slug}:`, e.message);
    }

    // 2. Add card to blog.html (sequential to avoid SHA conflicts)
    try {
      await addCardToBlog(page.slug, page.title, page.metaDescription, TODAY_DISPLAY, mins);
      console.log(`  ✓ blog.html card added`);
    } catch (e) {
      console.error(`  ✗ blog.html card error for ${page.slug}:`, e.message);
    }

    // 3. Submit to Distribb
    try {
      const dr = await submitToDistribb(page.slug, page.title, page.metaDescription, page.keyword, html);
      if (dr) console.log(`  ✓ Distribb draft: article ID ${dr.id || dr.article_id || JSON.stringify(dr).slice(0,80)}`);
    } catch (e) {
      console.error(`  ✗ Distribb error for ${page.slug}:`, e.message);
    }

    results.push({
      slug: page.slug,
      url: `${BASE_URL}/blog/${page.slug}.html`,
      title: page.title
    });

    // Small delay between GitHub commits to avoid race conditions on blog.html
    await new Promise(r => setTimeout(r, 1200));
  }

  console.log('\n\n══════════════════════════════════════════════');
  console.log('PUBLISHED COMPARISON PAGES');
  console.log('══════════════════════════════════════════════');
  results.forEach(r => console.log(`${r.title}\n  → ${r.url}\n`));
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

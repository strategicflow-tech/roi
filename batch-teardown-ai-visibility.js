// batch-teardown-ai-visibility.js
const BASE_URL = 'https://strategic-flow-audit.replit.app';
const ADMIN_KEY = process.env.INDEX_ADMIN_KEY;
const DELAY_MS = 5000;

const companies = [
  { name: "HeyGen", domain: "heygen.com", category: "AI video generation platform" },
  { name: "dbt Labs", domain: "getdbt.com", category: "data transformation and analytics engineering tool" },
  { name: "Landbot", domain: "landbot.io", category: "no-code chatbot builder" },
  { name: "Gamma", domain: "gamma.app", category: "AI presentation and document builder" },
  { name: "Optimizely", domain: "optimizely.com", category: "digital experience and A/B testing platform" },
  { name: "Zoho Analytics", domain: "zoho.com", category: "business intelligence and analytics platform" },
  { name: "Ahrefs", domain: "ahrefs.com", category: "SEO and backlink analysis tool" },
  { name: "Seamless.ai", domain: "seamless.ai", category: "B2B sales lead generation platform" },
  { name: "Wrike", domain: "wrike.com", category: "project management and work collaboration platform" },
  { name: "SEOmonitor", domain: "seomonitor.com", category: "SEO forecasting and rank tracking tool" },
  { name: "Userpilot", domain: "userpilot.com", category: "product adoption and onboarding platform" },
  { name: "Cloud Campaign", domain: "cloudcampaign.com", category: "social media marketing automation tool" },
  { name: "TripleDart", domain: "tripledart.com", category: "B2B growth marketing agency" },
  { name: "Lokalise", domain: "lokalise.com", category: "software localization and translation management platform" },
  { name: "Sequel.io", domain: "sequel.io", category: "live shopping and video commerce platform" },
  { name: "SplitMetrics", domain: "splitmetrics.com", category: "app store optimization and mobile growth platform" },
  { name: "Limelight", domain: "limelightplatform.com", category: "subscription and recurring billing platform" },
  { name: "Dot Compliance", domain: "dotcompliance.com", category: "quality management software for life sciences" },
  { name: "EasyLlama", domain: "easyllama.com", category: "online compliance training platform" },
  { name: "Tilled", domain: "tilled.com", category: "embedded payments platform for software companies" },
  { name: "Revolut", domain: "revolut.com", category: "digital banking and financial services app" },
  { name: "Qonto", domain: "qonto.com", category: "business banking platform for SMEs" },
  { name: "Alt21", domain: "alt21.com", category: "foreign exchange and payments platform" },
  { name: "Nilus", domain: "nilus.com", category: "treasury and cash management platform" },
  { name: "QuickSpark", domain: "quickspark.com", category: "sales enablement and outreach platform" },
  { name: "TimePayment", domain: "timepayment.com", category: "equipment financing and leasing platform" },
  { name: "Confluence Technologies", domain: "confluence.com", category: "investment data management platform" },
  { name: "Spreedly", domain: "spreedly.com", category: "payment orchestration platform" },
  { name: "Tuum", domain: "tuum.com", category: "core banking and payments infrastructure platform" },
  { name: "Tresorit", domain: "tresorit.com", category: "encrypted cloud storage and file sharing platform" },
  { name: "Cato Networks", domain: "catonetworks.com", category: "secure access service edge (SASE) platform" },
  { name: "Wiz", domain: "wiz.io", category: "cloud security posture management platform" },
  { name: "ReversingLabs", domain: "reversinglabs.com", category: "software supply chain security platform" },
  { name: "Finite State", domain: "finitestate.io", category: "IoT and firmware security platform" },
  { name: "ElevenLabs", domain: "elevenlabs.io", category: "AI voice generation and text-to-speech platform" },
  { name: "Atlassian", domain: "atlassian.com", category: "team collaboration and software development tools" },
  { name: "Uber", domain: "uber.com", category: "ride-hailing and mobility platform" },
  { name: "Wizz Air", domain: "wizzair.com", category: "low-cost airline" },
  { name: "Booking.com", domain: "booking.com", category: "online travel and accommodation booking platform" },
  { name: "Memrise", domain: "memrise.com", category: "language learning app" },
  { name: "Lodgify", domain: "lodgify.com", category: "vacation rental property management software" },
  { name: "Zoho Workplace", domain: "zoho.com", category: "productivity and collaboration suite" },
  { name: "Medallia", domain: "medallia.com", category: "customer experience management platform" }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const results = { ok: [], failed: [], skipped: [] };

  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];
    process.stdout.write(`[${i + 1}/${companies.length}] ${c.name} ... `);

    try {
      const res = await fetch(`${BASE_URL}/api/ai-visibility-index/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
        body: JSON.stringify(c)
      });
      const data = await res.json();

      if (res.status === 200 || data.job_id) {
        console.log(`OK — job started: ${data.job_id || data.slug}`);
        results.ok.push({ name: c.name, response: data });
      } else if (res.status === 409) {
        console.log('SKIPPED (already exists)');
        results.skipped.push(c.name);
      } else {
        console.log(`FAILED (${res.status}: ${data.error})`);
        results.failed.push({ name: c.name, status: res.status, error: data.error });
      }
    } catch (err) {
      console.log(`FAILED (${err.message})`);
      results.failed.push({ name: c.name, error: err.message });
    }

    if (i < companies.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\nDone. OK: ${results.ok.length} | Skipped: ${results.skipped.length} | Failed: ${results.failed.length}`);
  require('fs').writeFileSync('./teardown-ai-visibility-results.json', JSON.stringify(results, null, 2));
})();

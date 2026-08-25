#!/usr/bin/env node
// One-time playbook launch campaign sender.
// Runs standalone — no HTTP server, no session required.
// Uses same DB + Resend env vars as the main app.

'use strict';

const crypto    = require('crypto');
const { Pool }  = require('pg');
const { Resend } = require('resend');

const pool   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const resend = new Resend(process.env.RESEND_API_KEY);

const BASE_URL = 'https://strategic-flow-audit.replit.app';
const SUBJECT  = "AI already decided if you're worth recommending";

function unsubLink(email) {
  const e   = (email || '').toLowerCase().trim();
  const tok = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'sf-unsub-key')
                    .update(e).digest('hex').slice(0, 32);
  return `${BASE_URL}/unsubscribe?email=${encodeURIComponent(e)}&token=${tok}`;
}
const FROM     = 'Strategic Flow <alex@strategicflow.tech>';
const REPLY_TO = 'alex@strategicflow.tech';

function isOutreachPaused() {
  return String(process.env.OUTREACH_PAUSED || '').toLowerCase() === 'true';
}

// ── Exclusion rules (identical to server.js) ────────────────────────────────
const LARGE_COMPANY_BLOCKLIST = new Set([
  'anthropic','figma','salesforce','elevenlabs','crisp','framer','atlassian',
  'digitalocean','airtable','vercel','supabase','raycast','clerk','cursor',
  'windsurf','linear','netlify','cohere','railway','upstash','huggingface',
  'superhuman','runway','postman',
  'openai','mistral','groq','together ai','together','replicate','stability ai',
  'stability','cohere','perplexity','character ai','character','inflection',
  'google','microsoft','apple','amazon','meta','facebook','twitter','x corp',
  'samsung','oracle','ibm','intel','nvidia','amd','qualcomm','cisco','sap',
  'github','gitlab','bitbucket','heroku','render','fly.io','platform.sh',
  'cloudflare','fastly','akamai','linode','vultr','hetzner','ovh','digitalocean',
  'aws','azure','gcp',
  'stripe','paypal','braintree','square','adyen','klarna','checkout.com','brex',
  'ramp','mercury','wise','revolut','plaid','marqeta','dwolla',
  'slack','zoom','teams','webex','whereby','loom','miro','notion','confluence',
  'jira','trello','asana','monday','clickup','basecamp','linear','height',
  'shortcut','pivotal tracker',
  'shopify','wix','squarespace','webflow','ghost','wordpress','contentful',
  'sanity','strapi','directus',
  'hubspot','mailchimp','sendgrid','twilio','intercom','zendesk','freshdesk',
  'freshworks','marketo','pardot','activecampaign','klaviyo','drip','convertkit',
  'customer.io','loops','beehiiv','substack','mailgun','postmark','sparkpost',
  'resend','brevo','sendinblue',
  'datadog','pagerduty','sentry','logrocket','fullstory','mixpanel','amplitude',
  'segment','heap','hotjar','smartlook','clarity','posthog','grafana','newrelic',
  'dynatrace','appdynamics','honeycomb','elastic','elasticsearch','opensearch',
  'auth0','okta','onelogin','ping identity','duo','jumpcloud','rippling',
  'figma','sketch','invision','invisionapp','zeplin','abstract',
  'typeform','surveymonkey','qualtrics','medallia','delighted',
  'mongodb','redis','cassandra','confluent','snowflake','databricks','dbt labs',
  'fivetran','airbyte','planetscale','neon','turso','cockroachdb','fauna',
  'supabase','firebase','appwrite',
  'algolia','elastic','meilisearch','typesense',
  'retool','appsmith','budibase','tooljet','zapier','make','n8n','activepieces',
  'buildkite','circleci','travis ci','jenkins','hashicorp','terraform','pulumi',
  'ansible','puppet','chef','vault','consul','nomad','sonarqube','snyk',
  'salesloft','outreach','apollo','zoominfo','clearbit','hunter','lusha',
  'gusto','workday','adp','paychex','bamboohr',
  'tiktok','snapchat','pinterest','reddit','linkedin','spotify','canva','adobe',
  'dropbox','box',
  'calendly','cal.com','savvycal','doodle',
  'browserstack','saucelabs','testio','applause',
  'launchdarkly','optimizely','growthbook','statsig',
  'front','help scout','kayako','gladly','kustomer',
  'pipedrive','close','copper','insightly',
  'notion','coda','roam research','obsidian','logseq','grammarly','jasper',
  'copy ai','writer','lemon squeezy','paddle','gumroad','lemonsqueezy',
  'plausible','fathom','umami','pirsch','cal','dub','short.io',
]);

function isBlocked(name, email) {
  const e = (email || '').toLowerCase().trim();
  if (/^(privacy|legal|abuse|press|dpo|eudatarep|gdpr|compliance|security|support|help|noreply|no-reply|donotreply|do-not-reply|billing|notifications?|newsletter|mailer|bounce|postmaster|webmaster|admin)@/i.test(e))
    return { blocked: true, reason: `restricted prefix` };
  if (/-abuse@/i.test(e))
    return { blocked: true, reason: 'restricted prefix (-abuse@)' };
  const n = (name || '').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
  for (const term of LARGE_COMPANY_BLOCKLIST) {
    const t = term.toLowerCase();
    if (n === t || n.startsWith(t+' ') || n.endsWith(' '+t) || n.includes(' '+t+' '))
      return { blocked: true, reason: `large company ("${term}")` };
  }
  return { blocked: false };
}

async function wasEmailedRecently(email) {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM global_email_log WHERE lower(email)=$1 AND sent_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
      [email.toLowerCase().trim()]
    );
    return rows.length > 0;
  } catch { return false; }
}

async function recordSent(email, subject) {
  try {
    await pool.query(
      `INSERT INTO global_email_log (email, email_subject) VALUES ($1,$2)`,
      [email.toLowerCase().trim(), subject.slice(0,255)]
    );
  } catch { /* non-fatal */ }
}

function buildHtml(email) {
  const chapterUrl = `${BASE_URL}/playbook/chapter-1`;
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;color:#1a1a1a;font-size:15px;line-height:1.7;">
  <div style="padding:40px 36px;">
    <p style="margin:0 0 18px;">Hey,</p>
    <p style="margin:0 0 18px;">Claude, GPT, Perplexity, and Gemini already have an opinion about your company. Most founders have never checked what it is.</p>
    <p style="margin:0 0 18px;">We scored 140 real SaaS companies across two things: whether AI models mention and accurately describe them (73 companies), and whether their actual emails and pages convert once someone reads them (67 companies). The average AI Visibility score was 7.7 out of 10. The average Decision Friction score was 3.9. Six companies were mentioned by exactly zero of the four models, across every question we asked.</p>
    <p style="margin:0 0 18px;">That gap between "AI recommends you" and "your funnel converts" is where most SaaS companies lose deals without ever seeing it happen.</p>
    <p style="margin:0 0 18px;">On the conversion side, one pattern alone showed up as the top structural issue in 36% of the 67 companies we scored: subject lines and headers that name the internal category ("Product Update") instead of the outcome for the reader. Add the second most common pattern and you're looking at nearly two-thirds of every conversion failure in the dataset, from two fixable habits.</p>
    <p style="margin:0 0 12px;">We wrote all of it down. The AI Visibility &amp; Conversion Playbook is 21 chapters built entirely from that dataset:</p>
    <p style="margin:0 0 6px;">→ Which five structural patterns kill conversion most often, ranked by real frequency</p>
    <p style="margin:0 0 6px;">→ How AI models actually decide who to cite and who to skip</p>
    <p style="margin:0 0 6px;">→ The full scored index, all 140 companies, so you can see exactly where you'd land</p>
    <p style="margin:0 0 18px;">→ A 30-day roadmap to fix both problems at once</p>
    <p style="margin:0 0 16px;">Chapter 1 is free, no card needed:</p>
    <p style="margin:0 0 24px;"><a href="${chapterUrl}" style="display:inline-block;background:#1fd8c4;color:#0a0b0d;padding:13px 28px;text-decoration:none;font-weight:700;border-radius:4px;font-size:15px;letter-spacing:-.01em;">Read Chapter 1 free →</a></p>
    <p style="margin:0 0 18px;">The full playbook is $9.99. If you'd rather skip straight to having someone run the diagnosis on your own content, the $149 Decision Friction Review delivers a full rebuild within 5 hours.</p>
    <p style="margin:0 0 6px;">Alex</p>
    <p style="margin:0;color:#666;">Strategic Flow</p>
    <p style="margin:32px 0 0;font-size:12px;color:#999;border-top:1px solid #eee;padding-top:16px;">You're receiving this because your product is listed on ToolIndex. <a href="${unsubLink(email)}" style="color:#999;">Unsubscribe</a></p>
  </div>
</div>`;
}

async function main() {
  if (isOutreachPaused()) {
    console.log('[playbook-launch] PAUSED — OUTREACH_PAUSED=true; no contacts loaded or emails sent');
    await pool.end();
    return;
  }
  console.log('[playbook-launch] Building recipient list…');

  const { rows } = await pool.query(`
    SELECT email, name FROM (
      SELECT lower(c.email) AS email, NULL::text AS name
      FROM toolindex_newsletter_contacts c
      WHERE c.status='confirmed' AND c.confirmed_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM email_unsubscribes u WHERE lower(u.email)=lower(c.email))
      UNION
      SELECT lower(dl.contact_email) AS email, dl.name
      FROM directory_listings dl
      WHERE dl.status='active'
        AND dl.contact_email IS NOT NULL
        AND dl.contact_email_status='found'
        AND NOT EXISTS (SELECT 1 FROM email_unsubscribes u WHERE lower(u.email)=lower(dl.contact_email))
    ) combined
    ORDER BY email
  `);

  // Apply synchronous blocklist filter
  const eligible = rows.filter(r => !isBlocked(r.name || '', r.email).blocked);

  console.log(`[playbook-launch] ${rows.length} raw → ${eligible.length} after blocklist filter`);
  console.log(`[playbook-launch] Starting send…\n`);

  let sent = 0, skippedCooldown = 0, skippedError = 0;

  for (let i = 0; i < eligible.length; i++) {
    if (isOutreachPaused()) {
      console.log('[playbook-launch] PAUSED — OUTREACH_PAUSED=true');
      break;
    }
    const { email, name } = eligible[i];

    // 24-hour cooldown check
    const recentlySent = await wasEmailedRecently(email);
    if (recentlySent) {
      skippedCooldown++;
      process.stdout.write(`  [cooldown] ${email}\n`);
      continue;
    }

    const html = buildHtml(email);
    let result;
    try {
      result = await resend.emails.send({
        from:    FROM,
        replyTo: REPLY_TO,
        to:      email,
        subject: SUBJECT,
        html,
      });
    } catch (err) {
      skippedError++;
      console.error(`  [error] ${email} — ${err.message}`);
      continue;
    }

    if (result?.error) {
      skippedError++;
      console.error(`  [resend-error] ${email} — ${JSON.stringify(result.error)}`);
    } else {
      sent++;
      await recordSent(email, SUBJECT);
      if (sent % 10 === 0 || i === eligible.length - 1) {
        process.stdout.write(`  [sent ${sent}/${eligible.length}] latest: ${email}\n`);
      }
    }

    await new Promise(r => setTimeout(r, 120));
  }

  console.log(`\n[playbook-launch] ✓ Done`);
  console.log(`  Sent:             ${sent}`);
  console.log(`  Skipped (24h):    ${skippedCooldown}`);
  console.log(`  Skipped (error):  ${skippedError}`);
  console.log(`  Total eligible:   ${eligible.length}`);

  await pool.end();
}

main().catch(err => {
  console.error('[playbook-launch] FATAL:', err.message);
  pool.end().catch(() => {});
  process.exit(1);
});

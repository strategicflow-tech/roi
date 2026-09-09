'use strict';

// Shared outreach safety policy. Keep this module dependency-free so it can be
// exercised by regression tests without starting the application or connecting
// to the database.

const PERMANENT_OUTREACH_EXCLUSIONS = new Set([
  'hubspotpartner@karsten.anonaddy.com',
  'eoin@tines.io',
  'support@suno.com',
  'support@zohocliq.com',
  'support@recall.ai',
  'support@workos.com',
  'team@elevenlabs.io',
  'media@calendly.com',
  'sales@cloudways.com',
  'investors@equitybee.com',
  'per@scrimba.com',
  'support@mem.ai',
  'hi@cursor.com',
  'support@x.ai',
  'harness-privacy@deepseek.com',
  'hello@adapticagency.com',
  'hello@alythia.eu',
  'hello@blooup.net',
  'hello@boredsf.com',
  'hello@demandforge-agency.com',
  'hello@digitalbalance.com.au',
  'hello@driveflow.agency',
  'hello@gostepwise.co',
  'hello@growthfoundry.com',
  'hello@intelligentmobile.com',
  'hello@jamseo.agency',
  'hello@leadlion.co.uk',
  'hello@marscale.ai',
  'hello@northvii.com',
  'hello@omnygrowth.agency',
  'hello@re-tention.com',
  'hello@recruitmentmarketing.com',
  'hello@sayseo.com',
  'hello@scalehealthcaregold.com',
  'hello@sendastudio.com',
  'hello@seoexpertinnepal.com',
  'hello@squarefootadvisors.com',
  'hello@stillloading.com',
  'hello@teamalora.co',
  'hello@thelobby.agency',
  'hello@visualshawarma.com',
]);

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
  'sketch','invision','invisionapp','zeplin','abstract',
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
  'coda','roam research','obsidian','logseq','grammarly','jasper',
  'copy ai','writer','lemon squeezy','paddle','gumroad','lemonsqueezy',
  'plausible','fathom','umami','pirsch','cal','dub','short.io',
  'databox','jetbrains','deepseek',
  'midjourney','capcut','claude','davinci resolve','davinci',
  'blackmagic design','blackmagicdesign','blackmagic','vecteezy',
]);

const DIRECTORY_BLOCKED_EMAILS = new Set(['jonathan@datafreak.net']);
const DIRECTORY_BLOCKED_DOMAINS = new Set(['datafreak.net']);
const DIRECTORY_BLOCKED_LISTING_NAMES = new Set(['stackscope']);

function isJunkEmail(email) {
  if (!email || typeof email !== 'string') return true;
  const e = email.toLowerCase().trim();
  if (/\.(png|svg|jpg|jpeg|gif|webp|ico|bmp|tiff?|avif)$/i.test(e)) return true;
  if (/^(you|name|user|someone|your|test|example)@/i.test(e)) return true;
  if (/^(privacy|legal|abuse|press|dpo|eudatarep|gdpr|compliance|security|noreply|no-reply|donotreply|mailer-daemon|bounce|postmaster|unsubscribe)@/i.test(e)) return true;
  if (/-abuse@/i.test(e)) return true;
  return false;
}

function isBlockedDirectoryEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) return false;
  if (DIRECTORY_BLOCKED_EMAILS.has(normalized)) return true;
  return DIRECTORY_BLOCKED_DOMAINS.has(normalized.slice(normalized.lastIndexOf('@') + 1));
}

function isBlockedDirectoryListingName(name) {
  return DIRECTORY_BLOCKED_LISTING_NAMES.has(String(name || '').trim().toLowerCase());
}

function isBlockedOutreachTarget(listingName, email) {
  const e = (email || '').toLowerCase().trim();
  if (isBlockedDirectoryListingName(listingName)) {
    return { blocked: true, reason: 'permanent listing restriction (StackScope)' };
  }
  if (isBlockedDirectoryEmail(e)) {
    return { blocked: true, reason: 'permanent do-not-contact restriction (datafreak.net)' };
  }
  if (PERMANENT_OUTREACH_EXCLUSIONS.has(e)) {
    return { blocked: true, reason: 'permanent do-not-contact restriction' };
  }
  if (/^(privacy|legal|abuse|press|dpo|eudatarep|gdpr|compliance|security|service|noreply|no-reply|donotreply|do-not-reply|billing|notifications?|newsletter|mailer|bounce|postmaster|webmaster)@/i.test(e)) {
    return { blocked: true, reason: `restricted email prefix (${e.split('@')[0]}@)` };
  }
  if (/-abuse@/i.test(e)) {
    return { blocked: true, reason: 'restricted email prefix (-abuse@)' };
  }
  const name = (listingName || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const term of LARGE_COMPANY_BLOCKLIST) {
    const normalizedTerm = term.toLowerCase();
    if (
      name === normalizedTerm ||
      name.startsWith(normalizedTerm + ' ') ||
      name.endsWith(' ' + normalizedTerm) ||
      name.includes(' ' + normalizedTerm + ' ')
    ) {
      return { blocked: true, reason: `large/established company ("${term}")` };
    }
  }
  return { blocked: false };
}

function toolindexFoundersSkipReason(listingName, email) {
  const blocked = isBlockedOutreachTarget(listingName, email);
  if (blocked.blocked) return blocked.reason;
  if (isJunkEmail(email)) return 'junk_email';
  return null;
}

module.exports = {
  LARGE_COMPANY_BLOCKLIST,
  PERMANENT_OUTREACH_EXCLUSIONS,
  isBlockedDirectoryEmail,
  isBlockedDirectoryListingName,
  isBlockedOutreachTarget,
  isJunkEmail,
  toolindexFoundersSkipReason,
};
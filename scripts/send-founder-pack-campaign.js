#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { Resend } = require('resend');
const approval = require('./founder-pack-campaign-approval');

const BASE_URL = 'https://strategic-flow-audit.replit.app';
const CAMPAIGN_ID = approval.campaignId;
const FROM = 'Strategic Flow <noreply@strategicflow.tech>';
const REPLY_TO = 'strategicflow@proton.me';
const SUBJECT_A = 'Make more of your ToolIndex listing';
const SUBJECT_B = 'Take control of your ToolIndex listing';

function fail(message) {
  console.error(`[founder-pack-campaign] ${message}`);
  process.exitCode = 1;
}

function requireApproval() {
  if (!approval.oneTime || !approval.ownerApproved || !approval.allowUnconfirmedDirectoryContacts) {
    throw new Error('one-time owner approval is not active');
  }
  if (process.env.FOUNDER_PACK_CAMPAIGN_ID !== CAMPAIGN_ID) {
    throw new Error(`set FOUNDER_PACK_CAMPAIGN_ID=${CAMPAIGN_ID} to execute this campaign`);
  }
  if (process.env.FOUNDER_PACK_CAMPAIGN_EXECUTE !== 'true') {
    throw new Error('set FOUNDER_PACK_CAMPAIGN_EXECUTE=true to execute this campaign');
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unsubscribeUrl(email) {
  const normalized = String(email || '').toLowerCase().trim();
  const token = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'sf-unsub-key')
    .update(normalized)
    .digest('hex')
    .slice(0, 32);
  return `${BASE_URL}/unsubscribe?email=${encodeURIComponent(normalized)}&token=${token}`;
}

function firstNameOrNull(founderName) {
  const value = String(founderName || '').trim();
  if (!value || value.length > 80 || /[0-9.@_/]/.test(value)) return null;
  const words = value.split(/\s+/);
  if (words.length > 3 || !words.every(word => /^[A-Za-zÀ-ÖØ-öø-ÿ'’-]+$/.test(word))) return null;
  return words[0];
}

function buildMessage(recipient) {
  const firstName = firstNameOrNull(recipient.founder_name);
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const listingName = recipient.listing_name || 'your listing';
  const listingHtml = escapeHtml(listingName);
  const unsubscribe = unsubscribeUrl(recipient.email);
  const isClaimed = recipient.group === 'A';

  if (isClaimed) {
    const text = `${greeting}

You’ve already claimed ${listingName} on ToolIndex, so you control its listing.

The Founder Pack adds more visibility and new owner tools for a one-time payment of $49.

It includes:

• 30 days of Premium visibility
• Unlimited relaunches — standard claimed listings can relaunch once every 30 days, while Founder Pack owners can relaunch without that waiting restriction
• Priority logo placement in the ToolIndex brand carousel
• Weekly Listing Health Checks comparing your live site with your verified listing snapshot
• Editable Relaunch Kit drafts — you manually edit, save, and copy the draft after a relaunch. It is never posted automatically to Product Hunt, social media, a CMS, or any other external service
• Verified Listing History in your owner panel

Get the Founder Pack:

${BASE_URL}/directory#packages

The Founder Pack is a one-time $49 payment. There is currently no deadline or quantity limit for the offer.

Best,

Alex Iliescu
Strategic Flow
ToolIndex
Tenerife, Spain

You’re receiving this because you confirmed ToolIndex updates.

Unsubscribe from all ToolIndex emails:
${unsubscribe}`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;color:#1f2937;line-height:1.6;">
<p>${escapeHtml(greeting)}</p>
<p>You’ve already claimed <strong>${listingHtml}</strong> on ToolIndex, so you control its listing.</p>
<p>The Founder Pack adds more visibility and new owner tools for a one-time payment of $49.</p>
<p>It includes:</p>
<ul>
<li>30 days of Premium visibility</li>
<li>Unlimited relaunches — standard claimed listings can relaunch once every 30 days, while Founder Pack owners can relaunch without that waiting restriction</li>
<li>Priority logo placement in the ToolIndex brand carousel</li>
<li>Weekly Listing Health Checks comparing your live site with your verified listing snapshot</li>
<li>Editable Relaunch Kit drafts — you manually edit, save, and copy the draft after a relaunch. It is never posted automatically to Product Hunt, social media, a CMS, or any other external service</li>
<li>Verified Listing History in your owner panel</li>
</ul>
<p><a href="${BASE_URL}/directory#packages">Get the Founder Pack</a></p>
<p>The Founder Pack is a one-time $49 payment. There is currently no deadline or quantity limit for the offer.</p>
<p>Best,<br>Alex Iliescu<br>Strategic Flow<br>ToolIndex<br>Tenerife, Spain</p>
<p style="font-size:12px;color:#777">You’re receiving this because you confirmed ToolIndex updates.<br><a href="${escapeHtml(unsubscribe)}">Unsubscribe from all ToolIndex emails</a></p>
</div>`;
    return { subject: SUBJECT_A, text, html };
  }

  const text = `${greeting}

${listingName} is currently listed on ToolIndex, but it has not been claimed by its owner yet.

Claiming the listing gives you owner control. You’ll be able to manage and edit the listing, and become eligible for future ToolIndex upgrades.

Find your listing and claim it here:

${BASE_URL}/directory

Once you’ve claimed it, the Founder Pack adds more visibility and owner tools for a one-time payment of $49.

It includes:

• 30 days of Premium visibility
• Unlimited relaunches — standard claimed listings can relaunch once every 30 days, while Founder Pack owners can relaunch without that waiting restriction
• Priority logo placement in the ToolIndex brand carousel
• Weekly Listing Health Checks comparing your live site with your verified listing snapshot
• Editable Relaunch Kit drafts — you manually edit, save, and copy the draft. It is never posted automatically to Product Hunt, social media, a CMS, or any other external service
• Verified Listing History in your owner panel

After claiming your listing, view the Founder Pack:

${BASE_URL}/directory#packages

The Founder Pack is a one-time $49 payment. There is currently no deadline or quantity limit for the offer.

Best,

Alex Iliescu
Strategic Flow
ToolIndex
Tenerife, Spain

You’re receiving this because you confirmed ToolIndex updates.

Unsubscribe from all ToolIndex emails:
${unsubscribe}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;color:#1f2937;line-height:1.6;">
<p>${escapeHtml(greeting)}</p>
<p><strong>${listingHtml}</strong> is currently listed on ToolIndex, but it has not been claimed by its owner yet.</p>
<p>Claiming the listing gives you owner control. You’ll be able to manage and edit the listing, and become eligible for future ToolIndex upgrades.</p>
<p><a href="${BASE_URL}/directory">Find your listing and claim it</a></p>
<p>Once you’ve claimed it, the Founder Pack adds more visibility and owner tools for a one-time payment of $49.</p>
<p>It includes:</p>
<ul>
<li>30 days of Premium visibility</li>
<li>Unlimited relaunches — standard claimed listings can relaunch once every 30 days, while Founder Pack owners can relaunch without that waiting restriction</li>
<li>Priority logo placement in the ToolIndex brand carousel</li>
<li>Weekly Listing Health Checks comparing your live site with your verified listing snapshot</li>
<li>Editable Relaunch Kit drafts — you manually edit, save, and copy the draft. It is never posted automatically to Product Hunt, social media, a CMS, or any other external service</li>
<li>Verified Listing History in your owner panel</li>
</ul>
<p><a href="${BASE_URL}/directory#packages">View the Founder Pack</a></p>
<p>The Founder Pack is a one-time $49 payment. There is currently no deadline or quantity limit for the offer.</p>
<p>Best,<br>Alex Iliescu<br>Strategic Flow<br>ToolIndex<br>Tenerife, Spain</p>
<p style="font-size:12px;color:#777">You’re receiving this because you confirmed ToolIndex updates.<br><a href="${escapeHtml(unsubscribe)}">Unsubscribe from all ToolIndex emails</a></p>
</div>`;
  return { subject: SUBJECT_B, text, html };
}

function validateRecipients(recipients) {
  if (!Array.isArray(recipients) || recipients.length !== approval.approvedRecipientCount) {
    throw new Error(`expected ${approval.approvedRecipientCount} recipients, got ${Array.isArray(recipients) ? recipients.length : 'invalid input'}`);
  }
  const emails = new Set();
  const counts = { A: 0, B: 0 };
  for (const recipient of recipients) {
    if (!recipient || !['A', 'B'].includes(recipient.group)) throw new Error('invalid group in recipient input');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(recipient.email || ''))) throw new Error('invalid recipient email in input');
    const email = recipient.email.toLowerCase().trim();
    if (emails.has(email)) throw new Error(`duplicate recipient email: ${email}`);
    emails.add(email);
    counts[recipient.group]++;
  }
  if (counts.A !== approval.approvedGroupCounts.A || counts.B !== approval.approvedGroupCounts.B) {
    throw new Error(`expected group split ${approval.approvedGroupCounts.A}/${approval.approvedGroupCounts.B}, got ${counts.A}/${counts.B}`);
  }
  return { emails, counts };
}

async function main() {
  requireApproval();
  if (String(process.env.LIFECYCLE_OUTREACH_PAUSED || '').toLowerCase() === 'true') {
    throw new Error('LIFECYCLE_OUTREACH_PAUSED=true');
  }
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('usage: node scripts/send-founder-pack-campaign.js /path/to/recipients.json');
  const recipients = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const validation = validateRecipients(recipients);
  const resend = new Resend(process.env.RESEND_API_KEY);
  const sent = { A: 0, B: 0 };
  const failures = [];

  for (const recipient of recipients) {
    const message = buildMessage(recipient);
    try {
      const result = await resend.emails.send({
        from: FROM,
        replyTo: REPLY_TO,
        to: recipient.email,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
      if (result && result.error) {
        failures.push({ group: recipient.group, listing: recipient.listing_name, error: result.error });
      } else {
        sent[recipient.group]++;
      }
    } catch (error) {
      failures.push({ group: recipient.group, listing: recipient.listing_name, error: { message: error.message } });
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }

  const report = {
    campaignId: CAMPAIGN_ID,
    attempted: recipients.length,
    unique: validation.emails.size,
    sent,
    failed: failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 2;
}

main().catch(error => {
  fail(error.message);
});
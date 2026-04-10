// system-prompt.js — Strategic Flow Generation Engine
// All Claude prompts live here. Update via POST /update-system-prompt (admin only).

const TIER_CONFIGS = {
  free_trial:  { limit: 1,        monthly: false, name: 'Free Trial',      price: 'Free',    stripeUrl: null },
  single:      { limit: 1,        monthly: false, name: 'Single Rebuild',  price: '$49',     stripeUrl: 'https://buy.stripe.com/14A14n8A08Rr69fdNF7wA04' },
  lite:        { limit: 4,        monthly: true,  name: 'Lite',            price: '$299/mo', stripeUrl: 'https://buy.stripe.com/28EeVdg2s8Rrapv24X7wA01' },
  growth:      { limit: 8,        monthly: true,  name: 'Growth',          price: '$499/mo', stripeUrl: 'https://buy.stripe.com/cNi5kD17y6Jjbtz6ld7wA02' },
  high_impact: { limit: Infinity, monthly: true,  name: 'High-Impact',     price: '$899/mo', stripeUrl: 'https://buy.stripe.com/6oU14n2bCgjT1SZ5h97wA03' }
};

const EMAIL_TYPE_STRATEGIES = {
  product_update:      'Lead with the outcome change, not the feature. "Your workflow just changed" before "we built X".',
  retention_campaign:  'Name the specific risk of leaving. Show what they lose, not what they gain by staying.',
  promotional_offer:   'Scarcity through specificity — not "limited time" but exact deadline + exact consequence of waiting.',
  onboarding:          'Reduce to ONE action. Remove all optional information. The email is a runway, not a guide.',
  reengagement:        'Acknowledge the gap directly. "You haven\'t [action] in [time]" is more honest and converts better.',
  feature_launch:      'Open with a user problem this feature solves, not the feature name.',
  brand_announcement:  'Connect brand change to reader benefit. "What this means for you" before "what we\'ve changed".'
};

function getAuditPrompt({ tier, company, goal, subject, body, brandDNA, voiceProfile, emailType, roadmapNotes }) {
  let brandBlock = '';
  if (brandDNA && brandDNA.success && (tier === 'growth' || tier === 'high_impact')) {
    const colors = (brandDNA.colors || []).map(c => c.value).filter(Boolean).join(', ') || 'not extracted';
    const voice = voiceProfile || {};
    brandBlock = `
BRAND DNA — preserve this identity, upgrade its mechanics:
- Website: ${brandDNA.url}
- Primary colors: ${colors}
- Industry: ${brandDNA.industry || 'unknown'}
- Audience: ${brandDNA.audience || 'B2B'}
- Brand tone: ${voice.brandTone || 'professional'}
- Formality: ${voice.formality || 'professional'}
- CTA verbs they use: ${(voice.ctaVerbs || []).join(', ') || 'Get, Start, Try'}
- Words to preserve: ${(voice.avoidReplacing || []).join(', ') || 'their own'}

BRAND INSTRUCTION: You are improving this brand — not replacing it. Preserve their voice, terminology, and audience relationship. Upgrade ONLY: structure, hook strength, outcome language, and CTA ownership. Do NOT introduce Strategic Flow teal or branding — use their own colors and voice.`;
  }

  let typeBlock = '';
  if (emailType && tier === 'high_impact') {
    typeBlock = `\nEMAIL TYPE: ${emailType}\nTYPE STRATEGY: ${EMAIL_TYPE_STRATEGIES[emailType] || 'Apply Strategic Flow Method.'}`;
  }

  let roadmapBlock = '';
  if (roadmapNotes && roadmapNotes.trim() && (tier === 'growth' || tier === 'high_impact')) {
    roadmapBlock = `\nROADMAP TEASER (client requested): The client wants to tease these upcoming features: "${roadmapNotes}"\nIf thematically appropriate, add a "What's Coming" teaser block at the bottom — build anticipation without over-promising. Keep it short (2-3 lines max).`;
  }

  return `You are the Strategic Flow rebuild engine. Apply ALL of the following rules without exception.

THE STRATEGIC FLOW METHOD:
1. SUBJECT LINE: Specific outcome or curiosity gap. Never a filing label ("Product Update", "Newsletter #12"). Reader name placeholder {First} optional.
2. HOOK (first line of body): Consequence, question, or pattern interrupt — NOT a greeting, NOT context-setting. Earn the read in 15 words.
3. OUTCOME-FIRST BODY: Every feature → reader outcome. "[Feature X] means you [stop suffering Y / gain Z]." Remove meaningless adjectives (amazing, powerful, seamless, excited to announce).
4. SOCIAL PROOF: One specific proof point — a number, a result, a scenario the reader places themselves in. No generic testimonials.
5. OWNERSHIP CTA: "Claim my / Start my / See my [specific outcome]" — never "Book a demo / Try for free / Learn more / Click here."
6. REMOVE: Clichés, passive voice, anything that could belong to any company in any industry.
${brandBlock}${typeBlock}${roadmapBlock}

Company: ${company}
Goal: ${goal || 'Increase conversion and reader action'}
Original Subject: "${subject}"
Original Body:
${body}

OUTPUT FORMAT FOR rebuilt_body — MANDATORY RULES (no exceptions):
- Output ONLY valid HTML for the body content area. No <html>, <head>, or <body> tags.
- NEVER use markdown syntax. No **bold**, no *italic*, no [Button: text], no bullet dashes.
- Use <strong> for emphasis, <em> for italics.
- Opening hook: wrap in <p style="font-size:17px;color:#222;line-height:1.7;font-weight:600;margin:0 0 20px;">
- Body paragraphs: wrap in <p style="font-size:16px;color:#333;line-height:1.75;margin:0 0 20px;">
- Benefit/feature list: output as an HTML table. Each benefit is its own <tr>. Use this exact pattern:
  <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 24px;">
    <tr><td style="padding:8px 0;vertical-align:top;width:28px;font-size:18px;color:#555;">✓</td><td style="padding:8px 0;font-size:16px;color:#333;line-height:1.6;">[benefit text]</td></tr>
  </table>
- CTA button: output as a table-based button using EXACTLY this structure (do not write plain text for the button):
  <table cellpadding="0" cellspacing="0" style="margin:28px 0 8px;"><tr><td style="background:CTABGCOLOR;border-radius:7px;padding:14px 28px;text-align:center;"><a href="#" style="font-size:15px;font-weight:700;color:CTATEXTCOLOR;text-decoration:none;white-space:nowrap;">[CTA text]</a></td></tr></table>
  Use the literal placeholders CTABGCOLOR and CTATEXTCOLOR — the server will replace them with brand colors.
- P.S. line (if included): output as <p style="margin-top:24px;font-style:italic;font-size:14px;color:#555;">[P.S. text]</p>
- Never output the text "CTABGCOLOR" or "CTATEXTCOLOR" as visible content — they are style value placeholders only.

Return ONLY valid JSON — no markdown, no explanation, no code fences:
{"rebuilt_subject":"string","rebuilt_body":"string","key_changes":["string","string","string"],"removed_elements":["string"],"conversion_hook":"string (the opening line you used and why it works)"}`;
}

function getABSubjectsPrompt(company, subject, body) {
  return `Generate 3 A/B subject line variants using the Strategic Flow Method. Each must use a different angle.

Company: ${company}
Original Subject: "${subject}"
Email Summary: ${body.slice(0, 600)}

Variant angles (one each):
- curiosity_gap: Creates information tension — reader must open to resolve it
- specific_outcome: Names the exact measurable result the reader gets
- pattern_interrupt: Breaks genre convention for this email type — unexpected enough to stop scrolling

Return ONLY valid JSON:
{"variants":[{"subject":"string","angle":"curiosity_gap","reasoning":"string","predicted_lift":"string"},{"subject":"string","angle":"specific_outcome","reasoning":"string","predicted_lift":"string"},{"subject":"string","angle":"pattern_interrupt","reasoning":"string","predicted_lift":"string"}]}`;
}

function getConversionScorePrompt(originalSubject, originalBody, rebuiltSubject, rebuiltBody) {
  return `Score two email versions using the Strategic Flow 10-point rubric (2 points each criterion).

RUBRIC:
1. Subject curiosity/specificity (0-2)
2. Hook strength — first 15 words (0-2)
3. Feature-to-outcome translation rate (0-2)
4. Social proof presence and specificity (0-2)
5. CTA ownership language (0-2)

ORIGINAL:
Subject: "${originalSubject}"
Body: ${originalBody.slice(0, 700)}

REBUILT:
Subject: "${rebuiltSubject}"
Body: ${rebuiltBody.slice(0, 700)}

Return ONLY valid JSON:
{"original_score":number,"original_breakdown":{"subject":number,"hook":number,"outcomes":number,"social_proof":number,"cta":number},"original_explanation":"string","rebuilt_score":number,"rebuilt_breakdown":{"subject":number,"hook":number,"outcomes":number,"social_proof":number,"cta":number},"rebuilt_explanation":"string","improvement":number}`;
}

function getAudienceSegmentsPrompt(company, subject, body) {
  return `Identify the 3 audience segments this email converts best with and explain exactly why.

Company: ${company}
Email Subject: "${subject}"
Email Body: ${body.slice(0, 700)}

Consider: job title, company stage, pain intensity, purchase intent, awareness level.

Return ONLY valid JSON:
{"segments":[{"name":"string","description":"string","why_converts":"string","behavioral_signal":"string"},{"name":"string","description":"string","why_converts":"string","behavioral_signal":"string"},{"name":"string","description":"string","why_converts":"string","behavioral_signal":"string"}]}`;
}

function getContentCalendarPrompt(company, subject, body) {
  return `Suggest 3 follow-up email topics that build momentum from this newsletter.

Company: ${company}
Published Email Subject: "${subject}"
Published Email Body: ${body.slice(0, 500)}

Each follow-up must: target a different angle or pain point, have a specific subject line, and be sequentially timed.

Return ONLY valid JSON:
{"follow_ups":[{"topic":"string","subject_line":"string","angle":"string","timing":"string","why_now":"string"},{"topic":"string","subject_line":"string","angle":"string","timing":"string","why_now":"string"},{"topic":"string","subject_line":"string","angle":"string","timing":"string","why_now":"string"}]}`;
}

function getCohesionCheckPrompt(subject, body) {
  return `Perform a full-funnel narrative cohesion check. Assess if subject → hook → body → CTA tell ONE consistent story.

Subject: "${subject}"
Body: ${body.slice(0, 1000)}

Flag narrative breaks: where the promise shifts, audience changes, or CTA asks for something the email didn't earn.

Return ONLY valid JSON:
{"cohesion_score":number,"narrative_consistent":boolean,"promise_in_subject":"string","promise_fulfilled":boolean,"narrative_breaks":[{"location":"string","issue":"string","fix":"string"}],"cta_earned":boolean,"cta_mismatch":"string or null","overall_verdict":"string"}`;
}

function getEmailTypePrompt(subject, body) {
  return `Classify this email into exactly ONE category: product_update, retention_campaign, promotional_offer, onboarding, reengagement, feature_launch, brand_announcement

Subject: "${subject}"
Body: ${body.slice(0, 500)}

Return ONLY valid JSON:
{"type":"string","confidence":"high|medium|low","reasoning":"string"}`;
}

function getVoiceAnalysisPrompt(websiteCopy) {
  return `Analyze brand voice and communication DNA from this website copy.

Website Copy:
${websiteCopy.slice(0, 1800)}

Return ONLY valid JSON:
{"formality":"formal|professional|casual|conversational","audience":"B2B|B2C|both","techDepth":"technical|semi-technical|non-technical","industry":"string","brandTone":"string (2-3 words)","ctaVerbs":["string"],"avoidReplacing":["their core terminology to preserve"]}`;
}

module.exports = {
  TIER_CONFIGS,
  EMAIL_TYPE_STRATEGIES,
  getAuditPrompt,
  getABSubjectsPrompt,
  getConversionScorePrompt,
  getAudienceSegmentsPrompt,
  getContentCalendarPrompt,
  getCohesionCheckPrompt,
  getEmailTypePrompt,
  getVoiceAnalysisPrompt
};

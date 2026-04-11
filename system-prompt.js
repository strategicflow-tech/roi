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

function getAuditPrompt({ tier, company, goal, subject, body, brandDNA, voiceProfile, emailType, roadmapNotes, priorExamples }) {
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

  let examplesBlock = '';
  if (priorExamples && priorExamples.length > 0) {
    const lines = priorExamples.map((ex, i) => {
      const changes = Array.isArray(ex.what_changed) && ex.what_changed.length > 0
        ? ex.what_changed.slice(0, 2).join(' | ')
        : '';
      return `  ${i + 1}. Before: "${ex.original_subject}" → After: "${ex.rebuilt_subject}"${changes ? `\n     Key moves: ${changes}` : ''}`;
    }).join('\n');
    examplesBlock = `\nPRIOR SUCCESSFUL REBUILDS IN THIS INDUSTRY (benchmark only — do not copy these, they are for calibration):\n${lines}\nAim for the same quality bar or higher. Apply these same strategic moves to THIS email.\n`;
  }

  return `You are rebuilding a newsletter for ${company}. You are a mirror, not a template — reflect the client back to themselves, improved.

━━━ STEP 1 — READ BEFORE WRITING ━━━
Before writing a single word, carefully read the original subject and body below.
Extract and hold in mind:
- The EXACT message being communicated (what is ${company} actually announcing or offering?)
- The EXACT features, benefits, or outcomes mentioned (list them in your head)
- The TONE of the original (casual? technical? formal? conversational?)
- The AUDIENCE being addressed (who is ${company}'s reader, specifically?)
- The INTENT of the CTA (sign up? watch something? book a call? download? read more?)

━━━ STEP 2 — CLIENT FIDELITY RULES (these override all template instincts) ━━━
1. AUTHENTICITY: The rebuilt email must sound like it was written by ${company}'s own team — not by a marketing agency. Use their vocabulary, their references, their world.
2. NO INVENTED CONTENT: Do not add benefits, features, or claims that are not present in the original. If the original mentions 3 things → rebuild around those 3 things.
3. SUBJECT LINE: Must reference something SPECIFIC from the original — a named feature, a real number, a concrete result, a specific outcome the reader gets. FORBIDDEN patterns: "Your last X emails cost you Y", "Why your emails are being ignored", "The 7-line fix" — these are generic and belong to no company in particular.
4. HOOK: Must address ${company}'s actual audience's specific pain — not a generic SaaS pain. If the audience is language learners, the hook is about learning frustration. If enterprise ops teams, about workflow friction. Name their world.
5. FEATURE BOXES: Count the distinct value propositions in the original. Build EXACTLY that many boxes (min 2, max 6). Each box title must restate one of those actual propositions in outcome language. NEVER invent a box like "Human voice at AI speed" or "Revenue-ready in 48 hours" if the original content doesn't support it.
6. CTA: Match the original's intent exactly. If the email links to a video → "Watch [specific thing]". If it's a signup → "Start my [specific outcome]". If it's a booking → "Book my [specific session]". Do not default to generic ownership language if it doesn't match what the email is asking the reader to do.
7. TONE PRESERVATION: If the original is casual and friendly → stay casual and friendly. If it's technical and direct → stay technical and direct. If it's formal → stay formal. Do NOT normalize everything to "professional B2B SaaS".
${brandBlock}${typeBlock}${roadmapBlock}${examplesBlock}
━━━ STEP 3 — APPLY STRATEGIC FLOW IMPROVEMENTS ━━━
Now apply these upgrades to the content you extracted in Step 1:
- Lead every paragraph with the OUTCOME, not the feature. "[Feature] means you [gain X / stop Y]."
- Remove: clichés (excited to announce, game-changer, seamless, powerful, innovative), passive voice, any sentence that could belong to any company.
- Replace generic social proof ("thousands of customers") with ONE specific proof point if present in the original.
- Ensure the CTA earns what the email promises — the reader should feel the next step is the obvious conclusion.

━━━ STEP 4 — HTML OUTPUT FORMAT (technical rules, follow exactly) ━━━
Company: ${company}
Goal: ${goal || 'Increase conversion and reader action'}
Original Subject: "${subject}"
Original Body:
${body}

OUTPUT FORMAT FOR rebuilt_body — MANDATORY:
- Output ONLY valid HTML for the body content area. No <html>, <head>, or <body> tags. Table-based layout only (Gmail + Outlook compatible).
- NEVER use markdown syntax. No **bold**, no *italic*, no bullet dashes. Use <strong> for emphasis, <em> for italics.

SECTION STRUCTURE (use in this order):
1. Opening hook — <p style="font-size:17px;color:#222222;line-height:1.7;font-weight:600;margin:0 0 20px;">
2. Body paragraph(s) — <p style="font-size:16px;color:#333333;line-height:1.75;margin:0 0 20px;">
3. Section divider (before AND after the benefit cards):
   <table cellpadding="0" cellspacing="0" style="width:100%;margin:20px 0;"><tr><td style="height:1px;background:#e0e0e0;font-size:0;line-height:0;">&nbsp;</td></tr></table>
4. Benefit cards — one SEPARATE TABLE per benefit (not rows inside one table):
   <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 12px;"><tr><td style="background:#f5f5f5;border-radius:6px;padding:16px;"><table cellpadding="0" cellspacing="0" style="width:100%;"><tr><td style="width:40px;vertical-align:top;font-size:24px;line-height:1.2;padding-top:2px;">[emoji]</td><td style="vertical-align:top;padding-left:8px;"><strong style="font-size:15px;color:#1a1a1a;display:block;margin-bottom:4px;">[Benefit headline — 4 to 7 words, outcome language, from THIS email's content]</strong><span style="font-size:14px;color:#555555;line-height:1.6;">[One sentence: the specific reader outcome this benefit produces]</span></td></tr></table></td></tr></table>
   Emoji guide: 🚀 speed/launch · 🔒 security · 📊 analytics · 💬 communication · ⚡ performance · 🎯 targeting · 🌍 scale · 💡 insight · 🧠 intelligence · 🔄 workflow · 💰 revenue · 🎓 learning. Never use ✓ ★ or a generic bullet emoji.
5. Quote/testimonial (only if present in the original):
   <table cellpadding="0" cellspacing="0" style="width:100%;margin:20px 0;"><tr><td style="border-left:3px solid CTABGCOLOR;background:#f5f5f5;padding:16px;border-radius:0 6px 6px 0;"><p style="font-style:italic;font-size:15px;color:#333333;line-height:1.7;margin:0;">"[quote]"</p><p style="font-size:13px;color:#777777;margin:8px 0 0;">— [Attribution]</p></td></tr></table>
6. CTA button (EXACTLY this — no plain text buttons, no <button> tags):
   <table cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 8px;"><tr><td align="center" bgcolor="CTABGCOLOR" style="background:CTABGCOLOR;border-radius:4px;"><a href="#" target="_blank" style="display:inline-block;background:CTABGCOLOR;color:CTATEXTCOLOR;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;text-decoration:none;padding:14px 32px;border-radius:4px;-webkit-text-size-adjust:none;mso-padding-alt:0;">[CTA text matching the email's intent — see Rule 6 above]</a></td></tr></table>
   CTABGCOLOR and CTATEXTCOLOR are server-replaced placeholders — use them literally in both bgcolor attribute and background style value.
7. P.S. line (optional): <p style="margin-top:24px;font-style:italic;font-size:14px;color:#555555;">[P.S. text]</p>

PLACEHOLDER RULES: CTABGCOLOR and CTATEXTCOLOR must ONLY appear inside CSS values or bgcolor attributes — never as visible text.

Return ONLY valid JSON — no markdown, no explanation, no code fences:
{"rebuilt_subject":"string","rebuilt_body":"string","key_changes":["→ [what changed] — [why it converts better]","→ [what changed] — [why it converts better]","→ [what changed] — [why it converts better]"],"removed_elements":["string"],"conversion_hook":"string (the opening line you used and why it works for this specific audience)"}`;
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

function getEmailScorePrompt(subject, body) {
  return `Score this email on 5 criteria. Each criterion is worth 0, 1, or 2 points (10 points total).

SCORING RUBRIC:
1. subject_score — Curiosity + urgency + specificity
   0 = Generic filing label ("Newsletter", "Product Update", "Check this out")
   1 = Relevant but vague ("Our new feature is live", "Big news this week")
   2 = Specific outcome or strong curiosity gap ("Your approval rate just changed", "Why 40% of demos fail before hello")

2. hook_score — Pain point or specific outcome in the first 1-2 lines
   0 = Greeting, company name intro, or context-setting ("Hi, we're excited to share...")
   1 = Mildly engaging but soft ("Running a business is hard. We get it.")
   2 = Consequence, pattern interrupt, or specific scenario that earns the read immediately

3. structure_score — Logical flow, scannable, no wall of text
   0 = Dense unbroken paragraphs, no hierarchy, hard to skim
   1 = Some breaks but still awkward flow or inconsistent pacing
   2 = Clear flow, natural reading path, easy to scan key points

4. cta_score — Ownership language, single focused action
   0 = Passive or vague ("Book a demo", "Learn more", "Click here", "Check it out")
   1 = Somewhat active but generic ("Get started", "Try it now", "Sign up")
   2 = Ownership language with specific outcome ("Claim my free audit", "Start my 14-day trial", "See my dashboard")

5. voice_score — Consistent tone throughout, no corporate filler
   0 = Mixed tone, heavy clichés ("excited to announce", "game-changer", "seamless", "powerful solution")
   1 = Mostly consistent but some filler words or awkward phrasing
   2 = Clear, distinct voice throughout; every sentence sounds intentional

Subject: "${subject}"
Body:
${body.slice(0, 800)}

Return ONLY valid JSON (no markdown, no code fences):
{"subject_score":0,"hook_score":0,"structure_score":0,"cta_score":0,"voice_score":0,"subject_note":"one sentence on why","hook_note":"one sentence on why","structure_note":"one sentence on why","cta_note":"one sentence on why","voice_note":"one sentence on why"}`;
}

function getMicroImprovementsPrompt({ company, goal, subject, body, brandDNA, voiceProfile, score, priorExamples }) {
  let brandBlock = '';
  if (brandDNA && brandDNA.success) {
    const voice = voiceProfile || {};
    brandBlock = `\nBRAND VOICE: ${voice.brandTone || 'professional'} · Formality: ${voice.formality || 'professional'} · CTA verbs they use: ${(voice.ctaVerbs || []).join(', ') || 'their own'} · Words to preserve: ${(voice.avoidReplacing || []).join(', ') || 'their own'}\n`;
  }

  let examplesBlock = '';
  if (priorExamples && priorExamples.length > 0) {
    const lines = priorExamples.map((ex, i) => {
      const changes = Array.isArray(ex.what_changed) && ex.what_changed.length > 0
        ? ex.what_changed.slice(0, 2).join(' | ') : '';
      return `  ${i + 1}. Before: "${ex.original_subject}" → After: "${ex.rebuilt_subject}"${changes ? `\n     Key moves: ${changes}` : ''}`;
    }).join('\n');
    examplesBlock = `\nPRIOR SUCCESSFUL REFINEMENTS IN THIS INDUSTRY:\n${lines}\n`;
  }

  const fixes = [];
  if (score) {
    if (score.subject_score < 2) fixes.push('→ SUBJECT: Add a specific outcome or curiosity gap while keeping the same topic — do not change the subject drastically');
    if (score.hook_score   < 2) fixes.push('→ HOOK: Rewrite the first 1-2 lines to open with a consequence, question, or scenario — remove any greeting or preamble');
    if (score.cta_score    < 2) fixes.push('→ CTA: Replace passive verb (Book/Learn/Click/Try) with ownership language (Claim my / Start my / See my [specific outcome])');
    if (score.voice_score  < 2) fixes.push('→ VOICE: Remove clichés ("excited to announce", "game-changer", "seamless", "powerful") — replace with plain outcome language');
  }
  fixes.push('→ MARKDOWN: Convert any **bold** or *italic* markdown to <strong> and <em> HTML tags');

  return `You are the Strategic Flow refinement engine. This email scored well overall — preserve its structure and content. Apply ONLY the targeted fixes listed below. Do NOT rebuild from scratch.

WHAT TO PRESERVE (do not change these):
- Overall content sequence and number of sections
- Core message and product information
- Any statistics, quotes, or social proof already present
- The brand's existing terminology
${brandBlock}
TARGETED FIXES TO APPLY (ONLY these):
${fixes.join('\n')}
${examplesBlock}
Company: ${company}
Goal: ${goal || 'Sharpen conversion without disrupting brand'}
Original Subject: "${subject}"
Original Body:
${body}

OUTPUT FORMAT — identical to full rebuild (the email still renders through the same HTML template):
- Output ONLY valid HTML for the body content area. No <html>, <head>, or <body> tags. Table-based layout only.
- NEVER use markdown syntax. Use <strong> for emphasis, <em> for italics.
- CTA button must use this exact structure: <table cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 8px;"><tr><td align="center" bgcolor="CTABGCOLOR" style="background:CTABGCOLOR;border-radius:4px;"><a href="#" target="_blank" style="display:inline-block;background:CTABGCOLOR;color:CTATEXTCOLOR;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;text-decoration:none;padding:14px 32px;border-radius:4px;">[CTA text]</a></td></tr></table>
- In key_changes: list ONLY the specific micro-fixes made, not a full rebuild explanation.

Return ONLY valid JSON:
{"rebuilt_subject":"string","rebuilt_body":"string","key_changes":["→ [specific fix made] — [why it sharpens conversion]"],"removed_elements":[],"conversion_hook":"string (the opening line and why it works now)"}`;
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
  getVoiceAnalysisPrompt,
  getEmailScorePrompt,
  getMicroImprovementsPrompt
};

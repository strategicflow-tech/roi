'use strict';
/**
 * listing-enricher.js
 * Generates AI-powered insights for a directory listing using Claude.
 * Stores the result in directory_listings.ai_insights (JSONB).
 *
 * Usage:
 *   const { enrichListingWithAI } = require('./listing-enricher');
 *   await enrichListingWithAI(listing, pool, claudeJSON);
 *
 * listing = { id, name, url, description, category }
 * claudeJSON = the claudeJSON(prompt, maxTokens) function from server.js
 */

async function crawlHomepage(productUrl, timeoutMs = 10000) {
  try {
    const resp = await fetch(productUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ToolIndex-Enricher/1.0)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return '';
    const html = await resp.text();

    // Strip noise, keep readable text
    const clean = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<svg[\s\S]*?<\/svg>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 4000); // ~1000 tokens max

    return clean;
  } catch { return ''; }
}

async function enrichListingWithAI(listing, pool, claudeJsonFn) {
  const { id, name, url, description, category } = listing;

  console.log(`[enricher] Enriching listing ${id}: ${name}`);

  // Crawl homepage for more context
  const homeText = await crawlHomepage(url);

  const prompt = `Enrich a software directory listing with structured metadata. Return ONLY valid JSON — no markdown, no backticks, no surrounding text.

PRODUCT: ${name}
CATEGORY: ${category || 'SaaS'}
DESCRIPTION: ${(description || '').slice(0, 500)}
PRODUCT URL: ${url}
CRAWLED HOMEPAGE TEXT: ${homeText || '(could not crawl — use description only)'}

Return this exact JSON schema (all fields required):
{
  "summary": "2-3 factual sentences about what this product does and who it serves. Based strictly on description/homepage.",
  "features": ["Key feature 1", "Key feature 2", "Key feature 3", "Key feature 4"],
  "audience": {
    "target": "Primary target user type in 5-8 words",
    "best_for": "One sentence: best use case for this product",
    "not_for": "One sentence: what type of user this won't suit"
  },
  "strength": "Single most notable strength in one sentence",
  "weakness": "Single most likely weakness or limitation in one sentence",
  "competitors": ["Alternative product 1", "Alternative product 2", "Alternative product 3"],
  "facts": {
    "free_trial": null,
    "starting_price": null,
    "pricing_transparency": "medium",
    "platforms": [],
    "languages": [],
    "integrations": [],
    "social_github": null
  }
}

STRICT RULES for the "facts" object — these are observed fields, never guessed:
- free_trial: true/false ONLY if the homepage explicitly mentions "free trial" or "try free". Otherwise null.
- starting_price: e.g. "$9/mo" ONLY if a price appears on the homepage. "Free" if product is explicitly free. Otherwise null.
- pricing_transparency: "high" if price is public on homepage; "medium" if there's a pricing page link; "low" if it's "contact us" only.
- platforms: only from ["Web","iOS","Android","macOS","Windows","Linux","Chrome Extension"] — only if explicitly mentioned.
- languages: only non-empty if the site explicitly offers multiple languages.
- integrations: up to 5 named integrations explicitly shown on the homepage. Empty array [] if none found.
- social_github: full GitHub URL only if found as an actual link on the homepage. Otherwise null.

For AI-inferred fields (summary, features, audience, strength, weakness, competitors): use your best inference from the available data.`;

  try {
    const result = await claudeJsonFn(prompt, 1800);
    if (!result || typeof result !== 'object') {
      console.warn(`[enricher] No valid JSON returned for listing ${id}`);
      return null;
    }

    // Validate required structure
    const insights = {
      summary:     (typeof result.summary === 'string' ? result.summary : '').slice(0, 600),
      features:    Array.isArray(result.features) ? result.features.slice(0, 5).map(f => String(f).slice(0, 120)) : [],
      audience:    {
        target:   (result.audience?.target || '').slice(0, 120),
        best_for: (result.audience?.best_for || '').slice(0, 200),
        not_for:  (result.audience?.not_for || '').slice(0, 200),
      },
      strength:    (typeof result.strength === 'string' ? result.strength : '').slice(0, 300),
      weakness:    (typeof result.weakness === 'string' ? result.weakness : '').slice(0, 300),
      competitors: Array.isArray(result.competitors) ? result.competitors.slice(0, 4).map(c => String(c).slice(0, 60)) : [],
      facts: {
        free_trial:            result.facts?.free_trial ?? null,
        starting_price:        (result.facts?.starting_price || null),
        pricing_transparency:  ['high','medium','low'].includes(result.facts?.pricing_transparency) ? result.facts.pricing_transparency : 'medium',
        platforms:             Array.isArray(result.facts?.platforms) ? result.facts.platforms.slice(0, 6) : [],
        languages:             Array.isArray(result.facts?.languages) ? result.facts.languages.slice(0, 8) : [],
        integrations:          Array.isArray(result.facts?.integrations) ? result.facts.integrations.slice(0, 6) : [],
        social_github:         (result.facts?.social_github || null),
      },
    };

    await pool.query(
      `UPDATE directory_listings
       SET ai_insights = $1, ai_enriched_at = NOW(), ai_enriched_from = $2
       WHERE id = $3`,
      [JSON.stringify(insights), url, id]
    );

    console.log(`[enricher] ✓ Stored insights for listing ${id}: ${name}`);
    return insights;
  } catch (e) {
    console.error(`[enricher] Failed for listing ${id} (${name}): ${e.message}`);
    return null;
  }
}

module.exports = { enrichListingWithAI, crawlHomepage };

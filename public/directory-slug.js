'use strict';

// Keep public listing URLs deterministic and safe in both Node and the browser.
// Profanity is removed as a token rather than replaced with punctuation, so
// slugs never gain leading/trailing hyphens or expose abusive names directly.
const PROFANE_SLUG_WORDS = new Set([
  'ass', 'bastard', 'bitch', 'cock', 'cocks', 'crap', 'cunt',
  'dick', 'dicks', 'fuck', 'fucks', 'fucking', 'motherfucker',
  'piss', 'porn', 'porno', 'sex', 'shit', 'slut', 'whore'
]);

function toListingSlug(name, id) {
  const words = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter(word => word && !PROFANE_SLUG_WORDS.has(word));
  const base = (words.join('-').slice(0, 60).replace(/^-|-$/g, '') || 'listing');
  return `${base}-${String(id).replace(/[^a-z0-9-]/gi, '')}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { toListingSlug };
} else if (typeof window !== 'undefined') {
  window.ToolIndexSlug = { toListingSlug };
}
'use strict';

const FRESH_PRODUCT_HUNT_VOTE_NAMESPACE = 'fresh_ph_24h';
const FRESH_PRODUCT_HUNT_VOTE_INTERVAL_MS = 2 * 60 * 60 * 1000;
const FRESH_PRODUCT_HUNT_VOTE_WINDOW_MS = 24 * 60 * 60 * 1000;
const FRESH_PRODUCT_HUNT_MIN_VOTES = 4;
const FRESH_PRODUCT_HUNT_MAX_VOTES = 12;
const FRESH_PRODUCT_HUNT_INTERVALS = FRESH_PRODUCT_HUNT_VOTE_WINDOW_MS / FRESH_PRODUCT_HUNT_VOTE_INTERVAL_MS;

function stableHash(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

function freshProductHuntVoteTarget(listingId, submittedAt) {
  const input = `${FRESH_PRODUCT_HUNT_VOTE_NAMESPACE}:${listingId}:${new Date(submittedAt).toISOString()}`;
  return FRESH_PRODUCT_HUNT_MIN_VOTES
    + (stableHash(input) % (FRESH_PRODUCT_HUNT_MAX_VOTES - FRESH_PRODUCT_HUNT_MIN_VOTES + 1));
}

function freshProductHuntVotesDue(target, ageMs) {
  if (!Number.isFinite(target) || target < FRESH_PRODUCT_HUNT_MIN_VOTES) return 0;
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0;

  // The first slot is available immediately; subsequent slots unlock every
  // two hours. This reaches the deterministic target by the end of the
  // 22:00–24:00 slot without requiring a special post-window backfill.
  const elapsedSlots = Math.min(
    FRESH_PRODUCT_HUNT_INTERVALS - 1,
    Math.floor(ageMs / FRESH_PRODUCT_HUNT_VOTE_INTERVAL_MS)
  );
  return Math.min(
    target,
    Math.max(1, Math.ceil(target * (elapsedSlots + 1) / FRESH_PRODUCT_HUNT_INTERVALS))
  );
}

function freshProductHuntVoteHash(listingId, voteIndex) {
  return `${FRESH_PRODUCT_HUNT_VOTE_NAMESPACE}_${listingId}_${voteIndex}`;
}

module.exports = {
  FRESH_PRODUCT_HUNT_VOTE_NAMESPACE,
  FRESH_PRODUCT_HUNT_VOTE_INTERVAL_MS,
  FRESH_PRODUCT_HUNT_VOTE_WINDOW_MS,
  FRESH_PRODUCT_HUNT_MIN_VOTES,
  FRESH_PRODUCT_HUNT_MAX_VOTES,
  freshProductHuntVoteTarget,
  freshProductHuntVotesDue,
  freshProductHuntVoteHash,
};
'use strict';

const CLAIMED_LISTING_VOTE_NAMESPACE = 'claimed_24h';
const CLAIMED_LISTING_VOTE_INTERVAL_MS = 2 * 60 * 60 * 1000;
const CLAIMED_LISTING_VOTE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLAIMED_LISTING_MIN_VOTES = 5;
const CLAIMED_LISTING_MAX_VOTES = 15;
const CLAIMED_LISTING_INTERVALS = CLAIMED_LISTING_VOTE_WINDOW_MS / CLAIMED_LISTING_VOTE_INTERVAL_MS;

function stableHash(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

function claimedListingVoteTarget(listingId, claimedAt) {
  const input = `${CLAIMED_LISTING_VOTE_NAMESPACE}:${listingId}:${new Date(claimedAt).toISOString()}`;
  return CLAIMED_LISTING_MIN_VOTES
    + (stableHash(input) % (CLAIMED_LISTING_MAX_VOTES - CLAIMED_LISTING_MIN_VOTES + 1));
}

function claimedListingVotesDue(target, ageMs) {
  if (!Number.isFinite(target) || target < CLAIMED_LISTING_MIN_VOTES) return 0;
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0;

  const elapsedSlots = Math.min(
    CLAIMED_LISTING_INTERVALS - 1,
    Math.floor(ageMs / CLAIMED_LISTING_VOTE_INTERVAL_MS)
  );
  return Math.min(
    target,
    Math.max(1, Math.ceil(target * (elapsedSlots + 1) / CLAIMED_LISTING_INTERVALS))
  );
}

function claimedListingVoteHash(listingId, voteIndex) {
  return `${CLAIMED_LISTING_VOTE_NAMESPACE}_${listingId}_${voteIndex}`;
}

module.exports = {
  CLAIMED_LISTING_VOTE_NAMESPACE,
  CLAIMED_LISTING_VOTE_INTERVAL_MS,
  CLAIMED_LISTING_VOTE_WINDOW_MS,
  CLAIMED_LISTING_MIN_VOTES,
  CLAIMED_LISTING_MAX_VOTES,
  claimedListingVoteTarget,
  claimedListingVotesDue,
  claimedListingVoteHash,
};
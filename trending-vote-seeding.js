'use strict';

const TRENDING_VOTE_NAMESPACE = 'trending_24h';
const TRENDING_VOTE_INTERVAL_MS = 2 * 60 * 60 * 1000;
const TRENDING_VOTE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TRENDING_VOTE_MIN = 6;
const TRENDING_VOTE_MAX = 25;
const TRENDING_VOTE_INTERVALS = TRENDING_VOTE_WINDOW_MS / TRENDING_VOTE_INTERVAL_MS;

// Deliberately distinct targets so a fresh Trending round does not look like
// every listing received the same automated push.
const TRENDING_VOTE_TARGETS = Object.freeze([
  25, 22, 20, 18, 16, 14, 12, 10, 8, 6,
]);

function trendingVoteTarget(position) {
  const index = Number(position) - 1;
  return TRENDING_VOTE_TARGETS[index] || TRENDING_VOTE_MIN;
}

function trendingVotesDue(target, ageMs) {
  if (!Number.isFinite(target) || target < TRENDING_VOTE_MIN || target > TRENDING_VOTE_MAX) return 0;
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0;

  const elapsedSlots = Math.min(
    TRENDING_VOTE_INTERVALS - 1,
    Math.floor(ageMs / TRENDING_VOTE_INTERVAL_MS)
  );
  return Math.min(
    target,
    Math.max(1, Math.ceil(target * (elapsedSlots + 1) / TRENDING_VOTE_INTERVALS))
  );
}

function trendingVoteHash(roundDate, listingId, voteIndex) {
  const dateTag = String(roundDate).replace(/-/g, '');
  return `${TRENDING_VOTE_NAMESPACE}_${dateTag}_${listingId}_${voteIndex}`;
}

module.exports = {
  TRENDING_VOTE_NAMESPACE,
  TRENDING_VOTE_INTERVAL_MS,
  TRENDING_VOTE_WINDOW_MS,
  TRENDING_VOTE_MIN,
  TRENDING_VOTE_MAX,
  TRENDING_VOTE_INTERVALS,
  TRENDING_VOTE_TARGETS,
  trendingVoteTarget,
  trendingVotesDue,
  trendingVoteHash,
};
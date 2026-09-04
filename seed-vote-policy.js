'use strict';

const MAX_SYNTHETIC_SEED_VOTES = 35;

// The temporary Strategic Flow MCP campaign is intentionally not included:
// it is an explicit, separately time-boxed exception.
const SYNTHETIC_SEED_VOTE_PREFIXES = Object.freeze([
  'seed_%',
  'fresh_ph_24h_%',
  'claimed_24h_%',
  'daily_launch_6h_%',
  'timed_seed_%',
  'daily_growth_%',
  'daily_leaderboard_%',
]);

function syntheticSeedVotePredicate(alias = 'dv') {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error('invalid SQL alias');
  }
  return SYNTHETIC_SEED_VOTE_PREFIXES
    .map(prefix => `${alias}.voter_hash LIKE '${prefix}'`)
    .join(' OR ');
}

function remainingSyntheticSeedVotes(existingCount) {
  const count = Number.isFinite(Number(existingCount)) ? Number(existingCount) : 0;
  return Math.max(0, MAX_SYNTHETIC_SEED_VOTES - Math.max(0, count));
}

module.exports = {
  MAX_SYNTHETIC_SEED_VOTES,
  SYNTHETIC_SEED_VOTE_PREFIXES,
  syntheticSeedVotePredicate,
  remainingSyntheticSeedVotes,
};
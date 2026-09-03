'use strict';

const assert = require('node:assert/strict');
const {
  MAX_SYNTHETIC_SEED_VOTES,
  SYNTHETIC_SEED_VOTE_PREFIXES,
  syntheticSeedVotePredicate,
  remainingSyntheticSeedVotes,
} = require('../seed-vote-policy');

assert.equal(MAX_SYNTHETIC_SEED_VOTES, 35);
assert.ok(SYNTHETIC_SEED_VOTE_PREFIXES.includes('daily_launch_6h_%'));
assert.ok(!SYNTHETIC_SEED_VOTE_PREFIXES.some(prefix => prefix.startsWith('temporary_mcp')));
assert.equal(remainingSyntheticSeedVotes(0), 35);
assert.equal(remainingSyntheticSeedVotes(34), 1);
assert.equal(remainingSyntheticSeedVotes(35), 0);
assert.equal(remainingSyntheticSeedVotes(100), 0);
assert.match(syntheticSeedVotePredicate('dv'), /dv\.voter_hash LIKE 'seed_%'/);
assert.throws(() => syntheticSeedVotePredicate('x;DROP'), /invalid SQL alias/);

console.log('seed vote policy tests passed');
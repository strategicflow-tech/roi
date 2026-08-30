'use strict';

const assert = require('node:assert/strict');
const {
  CLAIMED_LISTING_VOTE_INTERVAL_MS,
  CLAIMED_LISTING_VOTE_WINDOW_MS,
  CLAIMED_LISTING_MIN_VOTES,
  CLAIMED_LISTING_MAX_VOTES,
  claimedListingVoteTarget,
  claimedListingVotesDue,
  claimedListingVoteHash,
} = require('../claimed-listing-votes');

const claimedAt = '2026-08-30T15:41:14.316Z';
const targets = new Set();
for (let listingId = 1; listingId <= 100; listingId++) {
  const target = claimedListingVoteTarget(listingId, claimedAt);
  assert.ok(target >= CLAIMED_LISTING_MIN_VOTES && target <= CLAIMED_LISTING_MAX_VOTES);
  assert.equal(target, claimedListingVoteTarget(listingId, claimedAt), 'target must survive restarts');
  targets.add(target);
}
assert.ok(targets.size > 1, 'targets should vary between listings');

for (const target of [CLAIMED_LISTING_MIN_VOTES, 10, CLAIMED_LISTING_MAX_VOTES]) {
  assert.equal(claimedListingVotesDue(target, -1), 0);
  assert.equal(claimedListingVotesDue(target, 0), 1);
  assert.ok(claimedListingVotesDue(target, CLAIMED_LISTING_VOTE_INTERVAL_MS) >= 1);
  assert.equal(claimedListingVotesDue(target, CLAIMED_LISTING_VOTE_WINDOW_MS), target);
  assert.equal(claimedListingVotesDue(target, 22 * 60 * 60 * 1000), target);
  for (let age = 0; age <= CLAIMED_LISTING_VOTE_WINDOW_MS; age += CLAIMED_LISTING_VOTE_INTERVAL_MS) {
    const due = claimedListingVotesDue(target, age);
    assert.ok(due >= 1 && due <= target, 'due votes must remain within the target');
  }
}

assert.equal(
  claimedListingVoteHash(123, 4),
  'claimed_24h_123_4',
  'claimed boosts must use the isolated namespace'
);

console.log('claimed listing vote helper tests passed');
'use strict';

const assert = require('node:assert/strict');
const {
  FRESH_PRODUCT_HUNT_VOTE_INTERVAL_MS,
  FRESH_PRODUCT_HUNT_VOTE_WINDOW_MS,
  FRESH_PRODUCT_HUNT_MIN_VOTES,
  FRESH_PRODUCT_HUNT_MAX_VOTES,
  freshProductHuntVoteTarget,
  freshProductHuntVotesDue,
  freshProductHuntVoteHash,
} = require('../fresh-product-hunt-votes');

const submittedAt = '2026-08-30T15:41:14.316Z';
const targets = new Set();
for (let listingId = 1; listingId <= 100; listingId++) {
  const target = freshProductHuntVoteTarget(listingId, submittedAt);
  assert.ok(target >= FRESH_PRODUCT_HUNT_MIN_VOTES && target <= FRESH_PRODUCT_HUNT_MAX_VOTES);
  assert.equal(target, freshProductHuntVoteTarget(listingId, submittedAt), 'target must survive restarts');
  targets.add(target);
}
assert.ok(targets.size > 1, 'targets should vary between listings');

for (const target of [FRESH_PRODUCT_HUNT_MIN_VOTES, 8, FRESH_PRODUCT_HUNT_MAX_VOTES]) {
  assert.equal(freshProductHuntVotesDue(target, -1), 0);
  assert.equal(freshProductHuntVotesDue(target, 0), 1);
  assert.ok(freshProductHuntVotesDue(target, FRESH_PRODUCT_HUNT_VOTE_INTERVAL_MS) >= 1);
  assert.equal(freshProductHuntVotesDue(target, FRESH_PRODUCT_HUNT_VOTE_WINDOW_MS), target);
  assert.equal(freshProductHuntVotesDue(target, 22 * 60 * 60 * 1000), target);
  for (let age = 0; age <= FRESH_PRODUCT_HUNT_VOTE_WINDOW_MS; age += FRESH_PRODUCT_HUNT_VOTE_INTERVAL_MS) {
    const due = freshProductHuntVotesDue(target, age);
    assert.ok(due >= 1 && due <= target, 'due votes must remain within the target');
  }
}

assert.equal(
  freshProductHuntVoteHash(123, 4),
  'fresh_ph_24h_123_4',
  'vote hashes must use the isolated namespace'
);

console.log('fresh Product Hunt vote helper tests passed');
'use strict';

const assert = require('node:assert/strict');
const {
  TEMPORARY_MCP_VOTE_INTERVAL_MS,
  TEMPORARY_MCP_VOTE_DURATION_MS,
  TEMPORARY_MCP_VOTES_PER_BATCH,
  TEMPORARY_MCP_MAX_BATCHES,
  temporaryMcpCampaignEndsAt,
  temporaryMcpDueBatchCount,
  temporaryMcpVoteHash,
} = require('../temporary-mcp-vote-campaign');

const startedAt = Date.parse('2026-09-03T12:00:00Z');
assert.equal(TEMPORARY_MCP_VOTES_PER_BATCH, 2);
assert.equal(TEMPORARY_MCP_MAX_BATCHES, 24);
assert.equal(temporaryMcpCampaignEndsAt(startedAt), startedAt + TEMPORARY_MCP_VOTE_DURATION_MS);
assert.equal(temporaryMcpDueBatchCount(startedAt, startedAt - 1), 0);
assert.equal(temporaryMcpDueBatchCount(startedAt, startedAt), 1);
assert.equal(temporaryMcpDueBatchCount(startedAt, startedAt + TEMPORARY_MCP_VOTE_INTERVAL_MS), 2);
assert.equal(temporaryMcpDueBatchCount(startedAt, startedAt + 46 * 60 * 60 * 1000), 24);
assert.equal(temporaryMcpDueBatchCount(startedAt, startedAt + TEMPORARY_MCP_VOTE_DURATION_MS), 24);
assert.equal(temporaryMcpVoteHash('temporary_mcp_seed', 3, 1), 'temporary_mcp_seed_3_1');

console.log('temporary MCP vote campaign tests passed');
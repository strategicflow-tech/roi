'use strict';

const TEMPORARY_MCP_VOTE_INTERVAL_MS = 2 * 60 * 60 * 1000;
const TEMPORARY_MCP_VOTE_DURATION_MS = 48 * 60 * 60 * 1000;
const TEMPORARY_MCP_VOTES_PER_BATCH = 2;
const TEMPORARY_MCP_MAX_BATCHES = TEMPORARY_MCP_VOTE_DURATION_MS / TEMPORARY_MCP_VOTE_INTERVAL_MS;

function temporaryMcpCampaignEndsAt(startedAt) {
  return startedAt + TEMPORARY_MCP_VOTE_DURATION_MS;
}

function temporaryMcpDueBatchCount(startedAt, now) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now) || now < startedAt) return 0;
  return Math.min(
    TEMPORARY_MCP_MAX_BATCHES,
    Math.floor((now - startedAt) / TEMPORARY_MCP_VOTE_INTERVAL_MS) + 1
  );
}

function temporaryMcpVoteHash(prefix, batchIndex, offset) {
  return `${prefix}_${batchIndex}_${offset}`;
}

module.exports = {
  TEMPORARY_MCP_VOTE_INTERVAL_MS,
  TEMPORARY_MCP_VOTE_DURATION_MS,
  TEMPORARY_MCP_VOTES_PER_BATCH,
  TEMPORARY_MCP_MAX_BATCHES,
  temporaryMcpCampaignEndsAt,
  temporaryMcpDueBatchCount,
  temporaryMcpVoteHash,
};
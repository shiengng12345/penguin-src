import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeSearchRequest,
  normalizeSearchResponse,
  validateSearchResponse,
  validateSearchRequest,
} from "../packages/knowledge-contracts/dist/index.js";

test("SearchRequest rejects empty query and unknown properties", () => {
  assert.throws(
    () => validateSearchRequest({ query: "" }),
    (error) => error.code === "INVALID_SEARCH_REQUEST",
  );
  assert.throws(
    () => validateSearchRequest({ query: "cpf", typo: true }),
    (error) => error.code === "INVALID_SEARCH_REQUEST",
  );
});

test("SearchRequest normalization supplies bounded defaults without changing query meaning", () => {
  assert.deepEqual(
    normalizeSearchRequest({ query: "playerAdditionalDetailRepository.findAllByCpf" }),
    {
      query: "playerAdditionalDetailRepository.findAllByCpf",
      mode: "auto",
      scope: {},
      options: {
        caseSensitive: true,
        wholeWord: false,
        includeGenerated: false,
        includeVendor: false,
        includeExcludedMetadata: false,
        semantic: "off",
        compact: false,
        explain: false,
      },
      page: {
        limit: 50,
      },
    },
  );
});

test("SearchRequest rejects unsafe revision combinations and out-of-range limits", () => {
  for (const limit of [0, 201, 1.5]) {
    assert.throws(() => validateSearchRequest({ query: "cpf", page: { limit } }));
  }
  assert.throws(() => validateSearchRequest({
    query: "cpf",
    scope: { revisions: [{ commitSha: "abc", workingTree: true }] },
  }));
  assert.deepEqual(
    normalizeSearchRequest({ query: "cpf", scope: { revisions: [{ branch: "main", commitSha: "abc" }] } }).scope,
    { revisions: [{ branch: "main", commitSha: "abc" }] },
  );
});

test("SearchResponse validates locator/evidence shape and normalizes nondeterministic timings", () => {
  const locator = {
    repoId: "repo-1",
    repoName: "fixture",
    revisionId: "commit-1",
    revisionKind: "commit",
    filePath: "src/call-site.ts",
    startLine: 8,
    endLine: 8,
  };
  const response = {
    schemaVersion: "2",
    hits: [{
      hitId: "hit-1",
      kind: "source_match",
      lane: "source",
      title: "invokeCpfLookup",
      locator,
      score: 1,
      rankReasons: ["exact"],
      evidence: [{ source: "source", locator, status: "verified" }],
    }],
    diagnostics: {
      queryStatus: "MATCH",
      requestId: "request-1",
      contractVersion: "2",
      capabilityHash: "hash",
      requestedScope: {},
      resolvedScope: [],
      scopeApplied: true,
      resolvedScopes: [],
      searchedLanes: ["source"],
      skippedLanes: [],
      coverage: { discovered: 1, admitted: 1, excluded: 0, failed: 0, stale: 0 },
      exclusions: [],
      warnings: [],
      nextActions: [],
      suggestions: [],
      timingsMs: { source: 12 },
      candidateCount: 1,
      truncated: false,
    },
    page: { limit: 50, totalIsExact: true, total: 1 },
  };
  assert.equal(validateSearchResponse(response).hits.length, 1);
  const normalized = normalizeSearchResponse(response);
  assert.deepEqual(normalized.diagnostics.timingsMs, {});
  assert.equal(normalized.hits[0].locator.filePath, "src/call-site.ts");
  assert.equal("snippet" in normalized.hits[0], false, "compact hits retain locator/evidence without requiring a snippet");
  assert.throws(() => validateSearchResponse({ ...response, schemaVersion: "1" }));
});

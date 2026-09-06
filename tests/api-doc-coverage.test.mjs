import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateDocumentCoverage, coverageHeadings, deriveCoverage } from "../packages/api-doc-generator/dist/index.js";
test("coverage headings never overclaim incomplete evidence", () => {
  const base = { endpointKey: "x", schemaGaps: [], requestAnalysis: { classes: [], analyzedConstraintIds: [], unresolvedConstraintIds: [], generationStrategy: "equivalence_boundary_pairwise" }, responseAnalysis: { classes: [], discoveredProducerIds: ["p"], resolvedProducerIds: ["p"], unresolvedProducerIds: [], dynamicProducerIds: [] }, revisionTrust: "exact_commit", evidenceValidation: { valid: true, missingEvidenceIds: [], missingRevisionIds: [], gaps: [] }, testCoveredClassIds: [], runtimeObservedClassIds: [], runtimeEvidenceState: "not_requested" };
  const exhaustive = deriveCoverage(base);
  assert.equal(exhaustive.level, "exhaustive");
  assert.equal(coverageHeadings(exhaustive).response, "All Possible Responses");
  const partial = deriveCoverage({ ...base, schemaGaps: [{ gapId: "g", code: "no_static_edge", message: "DI", evidenceIds: [] }] });
  assert.equal(partial.level, "partial");
  assert.equal(coverageHeadings(partial).response, "Known Response Matrix");
});

test("an empty document is evidence-empty, never exhaustive", () => {
  const empty = aggregateDocumentCoverage([]);
  assert.notEqual(empty.level, "exhaustive");
  assert.equal(empty.level, "partial");
  assert.ok(empty.blockers.some((gap) => gap.code === "document_evidence_empty"));
  assert.equal(coverageHeadings(empty).request, "Known Request Scenarios");
  assert.equal(coverageHeadings(empty).response, "Known Response Matrix");
});

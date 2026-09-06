import assert from "node:assert/strict";
import test from "node:test";
import { duplicateValues, validKnowledgeErrorEnvelope } from "../scripts/knowledge-process-utils.mjs";

test("duplicate listed capability IDs are detected before Map projection", () => {
  const listed = [
    { name: "knowledge_flow", "x-penguin-capability-id": "knowledge.flow" },
    { name: "knowledge_flow_alias", "x-penguin-capability-id": "knowledge.flow" },
    { name: "knowledge_context", "x-penguin-capability-id": "knowledge.context" },
  ];

  assert.deepEqual(
    duplicateValues(listed, (tool) => tool["x-penguin-capability-id"]),
    ["knowledge.flow"],
  );
});

test("error gate rejects empty or invalid envelopes and accepts classified errors", () => {
  assert.equal(validKnowledgeErrorEnvelope(null), false);
  assert.equal(validKnowledgeErrorEnvelope({ code: "", message: "bad", retryable: false }), false);
  assert.equal(validKnowledgeErrorEnvelope({ code: "CAPABILITY_MISMATCH", message: "", retryable: false }), false);
  assert.equal(validKnowledgeErrorEnvelope({ code: "not-classified", message: "bad", retryable: false }), false);
  assert.equal(validKnowledgeErrorEnvelope({ code: "CAPABILITY_MISMATCH", message: "unsupported contract", retryable: false }, "CAPABILITY_MISMATCH"), true);
  assert.equal(validKnowledgeErrorEnvelope({ code: "CAPABILITY_MISMATCH", message: "wrong", retryable: false }, "INTERNAL"), false);
});

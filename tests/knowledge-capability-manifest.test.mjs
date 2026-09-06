import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPABILITIES,
  capabilityHash,
  requiredCapabilitiesForSurface,
} from "../packages/knowledge-contracts/dist/index.js";

test("canonical capability manifest is complete, unique, and CLI/MCP required", () => {
  const ids = CAPABILITIES.map((capability) => capability.id);
  assert.equal(ids.length, 101);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("knowledge.search"));
  assert.ok(ids.includes("knowledge.graph.query"));
  assert.ok(ids.includes("knowledge.source.sync"));
  for (const capability of CAPABILITIES) {
    assert.match(capability.id, /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/, `${capability.id} must remain a dot-separated capability ID`);
    assert.ok(capability.version > 0);
    assert.ok(capability.requiredOn.includes("cli"));
    assert.ok(capability.requiredOn.includes("mcp"));
    assert.ok(capability.inputSchemaId.length > 0);
    assert.ok(capability.outputSchemaId.length > 0);
    assert.equal(
      capability.confirmation,
      capability.mutating ? "required" : "not_required",
    );
  }
});

test("capability hash is stable and surface sets are derived from the same manifest", () => {
  const first = capabilityHash(CAPABILITIES);
  const second = capabilityHash([...CAPABILITIES]);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);
  assert.deepEqual(
    requiredCapabilitiesForSurface("cli"),
    requiredCapabilitiesForSurface("mcp"),
  );
  assert.equal(CAPABILITIES.find((capability) => capability.id === "knowledge.index_status")?.mutating, false);
  assert.equal(CAPABILITIES.find((capability) => capability.id === "knowledge.note.list")?.mutating, false);
  assert.equal(CAPABILITIES.find((capability) => capability.id === "knowledge.note.write")?.confirmation, "required");
  assert.equal(CAPABILITIES.find((capability) => capability.id === "knowledge.search")?.supportsCursor, true);
  assert.equal(CAPABILITIES.find((capability) => capability.id === "knowledge.context")?.supportsCursor, true);
  assert.equal(CAPABILITIES.find((capability) => capability.id === "knowledge.endpoints")?.supportsCursor, true);
  assert.equal(CAPABILITIES.find((capability) => capability.id === "knowledge.affected")?.supportsCursor, false);
  assert.equal(CAPABILITIES.find((capability) => capability.id === "knowledge.flow")?.supportsCursor, false);
  assert.equal(CAPABILITIES.find((capability) => capability.id === "knowledge.service_graph")?.supportsCursor, false);
});

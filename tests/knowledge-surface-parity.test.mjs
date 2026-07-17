import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  CAPABILITIES,
  capabilityHash,
  listRequiredSurfaceCapabilities,
  listCliRegistrations,
  listMcpRegistrations,
  listWikiRegistrations,
  CAPABILITY_ALIASES,
  canonicalCapabilityId,
  CLI_IMPLEMENTED_CAPABILITIES,
  MCP_IMPLEMENTED_CAPABILITIES,
  hasCapabilityOutputValidator,
} from "../packages/knowledge-contracts/dist/index.js";

test("surface parity contract exposes every canonical capability", () => {
  for (const surface of ["cli", "mcp"]) {
    const ids = listRequiredSurfaceCapabilities(CAPABILITIES, surface);
    assert.equal(ids.length, CAPABILITIES.length);
    assert.deepEqual(ids, CAPABILITIES.map((capability) => capability.id));
  }
});

test("CLI/MCP/Wiki registration contracts expose required IDs and explicit status", () => {
  const expected = new Map([
    ["cli", listCliRegistrations()],
    ["mcp", listMcpRegistrations()],
    ["wiki", listWikiRegistrations()],
  ]);
  for (const [surface, registrations] of expected) {
    assert.deepEqual(
      registrations.map((registration) => registration.capabilityId),
      listRequiredSurfaceCapabilities(CAPABILITIES, surface),
    );
    const implemented = surface === "cli" ? CLI_IMPLEMENTED_CAPABILITIES : surface === "mcp" ? MCP_IMPLEMENTED_CAPABILITIES : new Set();
    assert.deepEqual(
      registrations.filter((registration) => registration.status === "implemented").map((registration) => registration.capabilityId),
      registrations.map((registration) => registration.capabilityId).filter((id) => implemented.has(id)),
    );
  }
});

test("CLI capability endpoint publishes the same canonical manifest hash", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("packages/knowledge-cli/dist/bin.js"), "capabilities", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.capabilities.length, 97);
  assert.equal(payload.capabilityHash, capabilityHash(CAPABILITIES));
  assert.deepEqual(
    payload.registrations.map((registration) => registration.capabilityId),
    listRequiredSurfaceCapabilities(CAPABILITIES, "cli"),
  );
});

test("registration stubs fail with an explicit typed runtime error", async () => {
  for (const registration of [...listCliRegistrations(), ...listMcpRegistrations(), ...listWikiRegistrations()]) {
    await assert.rejects(() => registration.invoke({}, { surface: "cli" }), (error) => error?.code === (registration.status === "implemented" ? "SURFACE_RUNTIME_UNAVAILABLE" : "CAPABILITY_NOT_IMPLEMENTED"));
  }
});

test("MCP convenience aliases explicitly point at canonical capabilities", () => {
  const source = readFileSync("packages/mcp/src/knowledge-tool-defs.ts", "utf8");
  for (const [alias, capability] of Object.entries({ get_node: "knowledge.get_node", explore_graph: "knowledge.graph.query", index_status: "knowledge.index_status", get_architecture: "knowledge.architecture" })) {
    assert.ok(source.includes(`name: "${alias}"`), `${alias} tool missing`);
    assert.equal(CAPABILITY_ALIASES[alias], capability, `${alias} must resolve through shared registry`);
  }
});

test("canonical alias registry has no private capability IDs and adapters carry schema validators", () => {
  for (const [alias, capability] of Object.entries(CAPABILITY_ALIASES)) {
    assert.notEqual(alias, capability);
    assert.ok(CAPABILITIES.some((item) => item.id === capability), `${alias} points to unknown capability`);
    assert.equal(canonicalCapabilityId(alias), capability);
  }
  for (const registration of [...listCliRegistrations(), ...listMcpRegistrations(), ...listWikiRegistrations()]) {
    assert.match(registration.inputSchemaId, /\.input\.v2$/);
    assert.match(registration.outputSchemaId, /\.output\.v2$/);
    assert.equal(typeof registration.validateOutput, "function");
    assert.equal(hasCapabilityOutputValidator(registration.capabilityId), true, `${registration.capabilityId} has no output validator`);
  }
});

test("all registered output validators reject non-JSON adapter output", () => {
  for (const registration of [...listCliRegistrations(), ...listMcpRegistrations(), ...listWikiRegistrations()]) {
    if (registration.capabilityId === "knowledge.search") continue;
    assert.throws(() => registration.validateOutput({ invalid: () => "not JSON" }), /JSON-compatible/);
  }
});

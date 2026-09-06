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
  canonicalInputSchema,
} from "../packages/knowledge-contracts/dist/index.js";
import { KNOWLEDGE_TOOL_DEFS } from "../packages/mcp/dist/knowledge-tool-defs.js";

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
  for (const registration of listMcpRegistrations()) {
    assert.match(registration.advertisedTool, /^knowledge_[a-z0-9_]+$/);
    assert.equal(registration.invocationMode, "direct");
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
  assert.equal(payload.capabilities.length, CAPABILITIES.length);
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
    assert.throws(() => registration.validateOutput({ invalid: () => "not JSON" }), /JSON-compatible|semantic/i);
  }
});

test("semantic registrations reject JSON-compatible but contract-invalid output", () => {
  for (const registration of [...listCliRegistrations(), ...listMcpRegistrations(), ...listWikiRegistrations()]) {
    if (registration.capabilityId === "knowledge.semantic_status" || registration.capabilityId === "knowledge.semantic_control") {
      assert.throws(() => registration.validateOutput({ garbage: true }), /semantic/i);
    }
  }
});

test("every MCP tool input schema equals the canonical contract schema", () => {
  const registrations = new Map(listMcpRegistrations().map((registration) => [registration.capabilityId, registration]));
  for (const tool of KNOWLEDGE_TOOL_DEFS) {
    const capabilityId = tool["x-penguin-capability-id"];
    // Legacy aliases are callable compatibility spellings; the generated
    // canonical tool owns the full-manifest ID. tools/list projects the alias
    // with that ID for existing Claude/Codex prompts.
    if (!capabilityId && CAPABILITY_ALIASES[tool.name]) continue;
    assert.ok(capabilityId, `${tool.name} has no canonical capability id`);
    assert.deepEqual(tool.inputSchema, canonicalInputSchema(capabilityId), `${tool.name} input schema drift`);
    assert.deepEqual(registrations.get(capabilityId)?.inputSchema, canonicalInputSchema(capabilityId), `${capabilityId} registration schema drift`);
  }
});

test("every MCP registration has exactly one canonical wire name", () => {
  const registrations = listMcpRegistrations();
  const wireNames = new Map();
  for (const registration of registrations) {
    assert.ok(registration.advertisedTool, `${registration.capabilityId} has no advertisedTool`);
    assert.ok(!wireNames.has(registration.advertisedTool), `duplicate wire name: ${registration.advertisedTool}`);
    wireNames.set(registration.advertisedTool, registration.capabilityId);
  }
});

test("every advertised MCP name is callable", () => {
  const registrations = listMcpRegistrations();
  const advertised = new Set(registrations.map((r) => r.advertisedTool));
  const callable = new Set(KNOWLEDGE_TOOL_DEFS.map((t) => t.name));
  for (const name of advertised) {
    assert.ok(callable.has(name), `advertised ${name} is not in KNOWLEDGE_TOOL_DEFS`);
  }
});

test("MCP aliases resolve to the same capability as canonical names", () => {
  const registrations = new Map(listMcpRegistrations().map((r) => [r.capabilityId, r]));
  for (const [alias, canonicalId] of Object.entries(CAPABILITY_ALIASES)) {
    const aliasedTool = KNOWLEDGE_TOOL_DEFS.find((t) => t.name === alias);
    const canonicalTool = KNOWLEDGE_TOOL_DEFS.find((t) => t["x-penguin-capability-id"] === canonicalId);
    if (!aliasedTool || !canonicalTool) continue;
    const aliasCapabilityId = aliasedTool["x-penguin-capability-id"] ?? canonicalId;
    assert.equal(aliasCapabilityId, canonicalId, `alias ${alias} does not resolve to ${canonicalId}`);
  }
});

test("no listed tool has an empty schema unless its capability explicitly accepts no arguments", () => {
  for (const tool of KNOWLEDGE_TOOL_DEFS) {
    const schema = tool.inputSchema;
    if (!schema || (schema.type === "object" && (!schema.properties || Object.keys(schema.properties).length === 0) && !schema.required?.length)) {
      const capabilityId = tool["x-penguin-capability-id"];
      if (capabilityId) {
        const canonical = canonicalInputSchema(capabilityId);
        assert.ok(canonical.type === "object" && (!canonical.properties || Object.keys(canonical.properties).length === 0),
          `${tool.name} has empty schema but canonical schema for ${capabilityId} expects arguments`);
      }
    }
  }
});

// tests/knowledge-indexer-identifiers.test.mjs
// Real gap reported from actual MCP usage: object-literal keys, interface/type
// members, and class fields are never symbol nodes, so a real field name like
// "suspensionPeriod" was completely unsearchable via knowledge_search — the
// reporting session's longest-stuck point, resolved only by `find`, not by
// penguin at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractIdentifiersFromSource } from "../packages/knowledge-indexer/dist/identifiers.js";

test("extractIdentifiers: interface members are captured as fields", async () => {
  const entries = await extractIdentifiersFromSource(
    "ts",
    `interface Foo {
      suspensionPeriod: string;
      effectiveTime?: number;
    }`,
  );
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("suspensionPeriod"));
  assert.ok(names.includes("effectiveTime"));
  assert.ok(entries.every((e) => e.kind === "field"));
});

test("extractIdentifiers: type-alias object members are captured the same as interface members", async () => {
  const entries = await extractIdentifiersFromSource(
    "ts",
    `type Bar = { municipioOrigemAposta: string };`,
  );
  assert.ok(entries.some((e) => e.name === "municipioOrigemAposta" && e.kind === "field"));
});

test("extractIdentifiers: class fields are captured, including ones with an accessibility modifier", async () => {
  const entries = await extractIdentifiersFromSource(
    "ts",
    `class Baz {
      someField: string;
      private otherField = 1;
    }`,
  );
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("someField"));
  assert.ok(names.includes("otherField"), "accessibility_modifier before the name must not break extraction");
  assert.ok(entries.filter((e) => names.includes(e.name)).every((e) => e.kind === "class_field"));
});

test("extractIdentifiers: object-literal keys are captured, both bare-identifier and quoted-string form", async () => {
  const entries = await extractIdentifiersFromSource(
    "ts",
    `const obj = { suspensionPeriod: 30, "quoted-key": 1 };`,
  );
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("suspensionPeriod"));
  assert.ok(names.includes("quoted-key"), "a quoted string key must be captured unquoted");
  assert.ok(entries.filter((e) => e.kind === "object_key").length === 2);
});

test("extractIdentifiers: a computed property key has no static name and is skipped, not crashed on", async () => {
  const entries = await extractIdentifiersFromSource(
    "ts",
    `const obj = { [computedKey]: 2, realKey: 3 };`,
  );
  const names = entries.map((e) => e.name);
  assert.ok(!names.includes("computedKey"));
  assert.ok(names.includes("realKey"));
});

test("extractIdentifiers: startLine points at the actual declaration line, not line 1", async () => {
  const entries = await extractIdentifiersFromSource(
    "ts",
    `interface Foo {\n  a: string;\n  suspensionPeriod: string;\n}`,
  );
  const hit = entries.find((e) => e.name === "suspensionPeriod");
  assert.equal(hit.startLine, 3);
});

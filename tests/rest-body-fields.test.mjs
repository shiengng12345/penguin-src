import assert from "node:assert/strict";
import { readFile as readFileP, writeFile as writeFileP, unlink as unlinkP } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function load() {
  const source = await readFileP(new URL("../src/lib/rest-body-fields.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  // strip the type-only import (erased at runtime anyway)
  const stripped = outputText.replace(/import[^;]*rest-types[^;]*;?/g, "");
  const tmp = new URL(`./.tmp-restbf-${process.pid}.mjs`, import.meta.url);
  await writeFileP(tmp, stripped);
  try {
    return await import(tmp.href);
  } finally {
    await unlinkP(tmp);
  }
}
const { fieldsToJson, coerceFieldValue, newBodyField, jsonToFields } = await load();

const row = (key, type, value, enabled = true) => ({ id: key, key, type, value, enabled });

test("coerceFieldValue handles every JSON type", () => {
  assert.equal(coerceFieldValue("string", "hi"), "hi");
  assert.equal(coerceFieldValue("number", "2"), 2);
  assert.equal(coerceFieldValue("number", "3.14"), 3.14);
  assert.equal(coerceFieldValue("boolean", "true"), true);
  assert.equal(coerceFieldValue("boolean", "false"), false);
  assert.equal(coerceFieldValue("null", "whatever"), null);
  assert.deepEqual(coerceFieldValue("object", '{"a":1}'), { a: 1 });
  assert.deepEqual(coerceFieldValue("array", "[1,2,3]"), [1, 2, 3]);
});

test("builds the exact face-verification body from typed rows", () => {
  const fields = [
    row("faceVerificationKey", "string", "faceidx_53082c92"),
    row("status", "number", "2"),
  ];
  assert.deepEqual(JSON.parse(fieldsToJson(fields)), {
    faceVerificationKey: "faceidx_53082c92",
    status: 2, // number, not "2"
  });
});

test("skips disabled rows and blank keys; last duplicate key wins", () => {
  const fields = [
    row("a", "string", "1"),
    row("b", "string", "keep-me", false), // disabled
    row("", "string", "no-key"), // blank key
    row("a", "number", "99"), // duplicate → wins
  ];
  assert.deepEqual(JSON.parse(fieldsToJson(fields)), { a: 99 });
});

test("invalid number / object value falls back to raw string (never throws)", () => {
  assert.equal(coerceFieldValue("number", "abc"), "abc");
  assert.equal(coerceFieldValue("object", "{not json"), "{not json");
  const out = fieldsToJson([row("x", "object", "{bad")]);
  assert.deepEqual(JSON.parse(out), { x: "{bad" });
});

test("empty field set → empty object", () => {
  assert.equal(fieldsToJson([]), "{}");
});

test("jsonToFields parses a flat object into typed rows (reverse of fieldsToJson)", () => {
  const rows = jsonToFields('{"a":"hi","b":2,"c":true,"d":null,"e":{"x":1},"f":[1,2]}');
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(byKey.a.type, "string"); assert.equal(byKey.a.value, "hi");
  assert.equal(byKey.b.type, "number"); assert.equal(byKey.b.value, "2");
  assert.equal(byKey.c.type, "boolean"); assert.equal(byKey.c.value, "true");
  assert.equal(byKey.d.type, "null");
  assert.equal(byKey.e.type, "object"); assert.deepEqual(JSON.parse(byKey.e.value), { x: 1 });
  assert.equal(byKey.f.type, "array"); assert.deepEqual(JSON.parse(byKey.f.value), [1, 2]);
});

test("fields ↔ JSON round-trips (both directions stay in sync, order preserved)", () => {
  const json = '{"faceVerificationKey":"faceidx_53","status":2,"active":true,"meta":{"k":"v"}}';
  const back = fieldsToJson(jsonToFields(json));
  assert.deepEqual(JSON.parse(back), JSON.parse(json));
  assert.deepEqual(Object.keys(JSON.parse(back)), Object.keys(JSON.parse(json)), "key order preserved");
});

test("jsonToFields returns [] for non-object / invalid JSON (caller adds a blank row)", () => {
  assert.deepEqual(jsonToFields("[1,2,3]"), []);
  assert.deepEqual(jsonToFields("not json"), []);
  assert.deepEqual(jsonToFields('"a string"'), []);
});

test("newBodyField makes a blank enabled string row with a unique id", () => {
  const a = newBodyField();
  const b = newBodyField();
  assert.equal(a.type, "string");
  assert.equal(a.enabled, true);
  assert.equal(a.key, "");
  assert.notEqual(a.id, b.id);
});

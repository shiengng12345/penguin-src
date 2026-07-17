import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFieldAccesses } from "../packages/knowledge-indexer/dist/index.js";

test("field access extraction distinguishes exact, writes, destructuring, and computed candidates", () => {
  const accesses = extractFieldAccesses(`function read(request) {\n  const cpf = request.cpf;\n  request.audit = true;\n  const { status } = request;\n  request[dynamicKey] = cpf;\n  return { cpf, ...request };\n}`);
  assert.ok(accesses.some((item) => item.field === "cpf" && item.kind === "reads_field" && item.method === "EXTRACTED"));
  assert.ok(accesses.some((item) => item.field === "audit" && item.kind === "writes_field"));
  assert.ok(accesses.some((item) => item.field === "status" && item.kind === "reads_field"));
  assert.ok(accesses.some((item) => item.field === "<computed>" && item.method === "INFERRED"));
  assert.ok(accesses.some((item) => item.field === "<spread>" && item.kind === "passes_field"));
});

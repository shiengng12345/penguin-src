import assert from "node:assert/strict";
import { test } from "node:test";
import { ParsePool } from "../packages/knowledge-indexer/dist/parse-pool.js";

// The pool parallelises ONLY tree-sitter parsing; SQLite stays single-writer
// on the main thread. It is an accelerator, so every failure mode must fall
// back to an in-process parse rather than break the index.

test("pool sizing refuses to pay worker startup for a handful of files", () => {
  // Each worker instantiates its own grammars; below the threshold that costs
  // more than the parsing it saves.
  assert.equal(ParsePool.resolveSize(undefined, 5), 0);
  assert.equal(ParsePool.resolveSize({ minFiles: 4 }, 5) > 0, true);
  // Explicit size wins and is clamped.
  assert.equal(ParsePool.resolveSize({ size: 3 }, 1000), 3);
  assert.equal(ParsePool.resolveSize({ size: 99 }, 1000), 8);
  assert.equal(ParsePool.resolveSize({ size: 0 }, 1000), 0, "0 disables the pool");
});

test("a real parse through a worker matches an in-process parse", async () => {
  const { extractSymbols } = await import("../packages/knowledge-indexer/dist/extract.js");
  const source = [
    "export function alpha(a: number): number { return beta(a); }",
    "export function beta(b: number): number { return b * 2; }",
    "export class Gamma { run() { return alpha(1); } }",
  ].join("\n");
  const pool = new ParsePool(2);
  try {
    assert.equal(pool.size, 2);
    const viaWorker = await pool.parse({ lang: "ts", source, relPath: "src/a.ts" });
    const inProcess = await extractSymbols({ lang: "ts", source, relPath: "src/a.ts" });
    assert.deepEqual(viaWorker, inProcess, "worker output must equal in-process output");
    assert.ok(viaWorker.symbols.length >= 3, "found the declarations");
    assert.equal(viaWorker.parseError, null);
  } finally {
    await pool.close();
  }
});

test("concurrent parses stay correctly matched to their requests", async () => {
  const pool = new ParsePool(3);
  try {
    const tasks = Array.from({ length: 12 }, (_, i) => ({
      lang: "ts",
      source: `export function fn${i}() { return ${i}; }`,
      relPath: `src/f${i}.ts`,
    }));
    const results = await Promise.all(tasks.map((t) => pool.parse(t)));
    // Each result must correspond to ITS request — an id/response mix-up in the
    // pool would surface here as a symbol from the wrong file.
    results.forEach((result, i) => {
      assert.ok(
        result.symbols.some((symbol) => symbol.name === `fn${i}`),
        `result ${i} carries fn${i}, got ${result.symbols.map((s) => s.name).join(",")}`,
      );
    });
  } finally {
    await pool.close();
  }
});

test("a closed or empty pool still parses, in-process", async () => {
  // A bare `const` export yields no symbol by design, so assert on a function.
  const empty = new ParsePool(0);
  assert.equal(empty.size, 0);
  const result = await empty.parse({ lang: "ts", source: "export function x() { return 1; }", relPath: "x.ts" });
  assert.deepEqual(result.symbols.map((s) => s.name), ["x"], "falls back instead of failing");
  await empty.close();

  const closed = new ParsePool(1);
  await closed.close();
  const after = await closed.parse({ lang: "ts", source: "export function y() { return 2; }", relPath: "y.ts" });
  assert.deepEqual(after.symbols.map((s) => s.name), ["y"], "still answers after close");
});

test("a parse error is returned as data, not thrown", async () => {
  const pool = new ParsePool(1);
  try {
    const result = await pool.parse({ lang: "ts", source: "function ((((", relPath: "broken.ts" });
    // tree-sitter is error-tolerant, so this may parse partially; what matters
    // is that the call resolves with an ExtractedFile shape either way.
    assert.equal(typeof result, "object");
    assert.ok(Array.isArray(result.symbols));
    assert.ok("parseError" in result);
  } finally {
    await pool.close();
  }
});

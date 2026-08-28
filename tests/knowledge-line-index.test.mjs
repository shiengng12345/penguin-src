import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { buildLineIndex, locateOffset } from "../packages/knowledge-core/dist/index.js";

// buildLineIndex used to recompute Buffer.byteLength(content.slice(0, offset))
// twice PER LINE, making it quadratic in file size: 235ms for a 134KB source,
// an order of magnitude more than tree-sitter spends parsing the same file.
// These tests pin the byte/char offsets the accumulating version must produce,
// independently of that implementation — a regression to any other arithmetic
// (e.g. treating "\n" as a non-byte, or dropping the trailing empty segment)
// breaks them.

function referenceLines(content) {
  const lines = [];
  let startChar = 0;
  const segments = content.split("\n");
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const endChar = startChar + segment.length;
    lines.push({
      line: i + 1,
      startByte: Buffer.byteLength(content.slice(0, startChar), "utf8"),
      endByte: Buffer.byteLength(content.slice(0, endChar), "utf8"),
      startChar,
      endChar,
    });
    startChar = endChar + (i < segments.length - 1 ? 1 : 0);
  }
  return lines;
}

const CASES = {
  empty: "",
  noNewline: "const a = 1;",
  trailingNewline: "a\nb\n",
  crlf: "a\r\nb\r\n",
  blankLines: "a\n\n\nb",
  onlyNewlines: "\n\n\n",
  cjk: "const 名字 = '企鹅';\nconst x = 2;\n复杂",
  emoji: "// 🐧 penguin\nconst e = '👨‍👩‍👧‍👦';\nend",
  mixedWidth: "a我b\n🐧c\nz",
};

test("line index offsets match the byte-exact reference on edge cases", () => {
  for (const [name, source] of Object.entries(CASES)) {
    assert.deepEqual(
      buildLineIndex(Buffer.from(source), source).lines,
      referenceLines(source),
      `offsets diverge for ${name}`,
    );
  }
});

test("line index offsets match the reference across real source files", () => {
  const dir = new URL("../packages/knowledge-core/src/", import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts")).slice(0, 20);
  assert.ok(files.length >= 10, "needs real files to be meaningful");
  for (const name of files) {
    const source = readFileSync(new URL(name, dir), "utf8");
    assert.deepEqual(
      buildLineIndex(Buffer.from(source), source).lines,
      referenceLines(source),
      `offsets diverge for ${name}`,
    );
  }
});

test("multi-byte characters advance byte offsets past char offsets", () => {
  // One CJK char is 3 UTF-8 bytes, one emoji is 4 — byte and char offsets must
  // not be conflated anywhere in the accumulation.
  const { lines } = buildLineIndex(Buffer.from("我\nab\n🐧"), "我\nab\n🐧");
  assert.deepEqual(lines[0], { line: 1, startByte: 0, endByte: 3, startChar: 0, endChar: 1 });
  assert.deepEqual(lines[1], { line: 2, startByte: 4, endByte: 6, startChar: 2, endChar: 4 });
  assert.equal(lines[2].startByte, 7, "newline is one byte");
  assert.equal(lines[2].startChar, 5);
});

test("locateOffset still finds the right line after the rewrite", () => {
  const source = "alpha\nbeta\ngamma";
  const index = buildLineIndex(Buffer.from(source), source);
  assert.equal(locateOffset(index, 0).line, 1);
  assert.equal(locateOffset(index, 6).line, 2);
  assert.equal(locateOffset(index, 11).line, 3);
  assert.equal(locateOffset(index, 999).line, 3, "past EOF clamps to the last line");
});

test("building a large file's line index stays linear", () => {
  // 3000 lines: the quadratic version took ~235ms, the linear one ~2ms. A
  // generous ceiling still fails loudly if the quadratic form comes back.
  const source = Array.from({ length: 3000 }, (_, i) => `const line${i} = ${i};`).join("\n");
  const started = performance.now();
  buildLineIndex(Buffer.from(source), source);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 60, `line index took ${elapsed.toFixed(0)}ms — quadratic behaviour is back`);
});

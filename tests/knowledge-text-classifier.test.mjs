import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyTextBuffer,
  decodeTextBuffer,
} from "../packages/knowledge-indexer/dist/text-classifier.js";
import { DEFAULT_COVERAGE_POLICY } from "../packages/knowledge-indexer/dist/coverage-policy.js";

test("text classifier supports UTF-8, UTF-8 BOM, UTF-16LE, and UTF-16BE", () => {
  const cases = [
    [Buffer.from("needle"), "utf8"],
    [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("needle")]), "utf8"],
    [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("needle", "utf16le")]), "utf16le"],
    [Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("needle", "utf16le").swap16()]), "utf16be"],
  ];
  for (const [bytes, encoding] of cases) {
    const result = classifyTextBuffer(bytes, "fixture.txt", DEFAULT_COVERAGE_POLICY);
    assert.equal(result.status, "admitted");
    assert.equal(result.encoding, encoding);
    assert.equal(result.text, "needle");
    assert.equal(decodeTextBuffer(bytes).text, "needle");
  }
});

test("text classifier distinguishes NUL binary, invalid encoding, and hard size", () => {
  assert.equal(classifyTextBuffer(Buffer.from([0, 1, 2]), "binary.bin", DEFAULT_COVERAGE_POLICY).reasonCode, "binary");
  assert.equal(classifyTextBuffer(Buffer.from([0xc3, 0x28]), "invalid.txt", DEFAULT_COVERAGE_POLICY).reasonCode, "unsupported_encoding");
  const policy = { ...DEFAULT_COVERAGE_POLICY, hardFileSizeBytes: 3 };
  assert.equal(classifyTextBuffer(Buffer.from("four"), "large.txt", policy).reasonCode, "hard_size_limit");
});

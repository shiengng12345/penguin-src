import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLineIndex, locateOffset } from "../packages/knowledge-core/dist/index.js";

test("line index maps UTF-8 byte offsets and CRLF lines deterministically", () => {
  const source = "第一行\r\nsecond\n第三行";
  const index = buildLineIndex(Buffer.from(source, "utf8"), source);
  assert.equal(index.lines.length, 3);
  assert.equal(index.lines[0].line, 1);
  assert.equal(index.lines[1].line, 2);
  assert.equal(index.lines[2].line, 3);
  assert.equal(locateOffset(index, Buffer.byteLength("第一行\r\n", "utf8") + 1).line, 2);
});

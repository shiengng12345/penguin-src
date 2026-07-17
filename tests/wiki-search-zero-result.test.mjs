import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Wiki zero-result state renders diagnostics instead of a bare empty list", () => {
  const source = readFileSync(new URL("../src/components/wiki/WikiSearchPage.tsx", import.meta.url), "utf8");
  assert.match(source, /没有结果/);
  assert.match(source, /warnings\.map/);
  assert.match(source, /excluded/);
  assert.match(source, /failed/);
  assert.match(source, /window\.confirm/);
  assert.match(source, /knowledgeReindex/);
  assert.match(source, /内容因 secret policy 被隐藏/);
});

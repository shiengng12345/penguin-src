import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../src/components/wiki/WikiSearchPage.tsx", import.meta.url), "utf8");

test("Wiki search is backed by canonical search/context APIs", () => {
  assert.match(source, /knowledgeSearchV2/);
  assert.match(source, /knowledgeContext/);
  assert.match(source, /setTimeout\(\(\) =>/);
  assert.match(source, /150/);
  assert.doesNotMatch(source, /nodes\.filter\(/);
});

test("Wiki search exposes revision, coverage, evidence and cursor signals", () => {
  assert.match(source, /searchedLanes/);
  assert.match(source, /coverage\.admitted/);
  assert.match(source, /evidence\[0\]\?\.status/);
  assert.match(source, /nextCursor/);
  assert.match(source, /revisionId/);
});

test("Wiki search exposes canonical scope filters and saved-query actions", () => {
  assert.match(source, /knowledgeSavedQueryList/);
  assert.match(source, /knowledgeSavedQueryWrite/);
  assert.match(source, /knowledgeSavedQueryRun/);
  assert.match(source, /筛选仓库/);
  assert.match(source, /筛选路径/);
  assert.match(source, /knowledgeEvidenceList/);
  assert.match(source, /pinnedSavedQueries/);
  assert.match(source, /置顶/);
  assert.match(source, /预览行数/);
  assert.match(source, /metaKey/);
  assert.match(source, /backlinks/);
  assert.match(source, /送到搜索/);
  assert.match(source, /送到 context/);
  assert.match(source, /导出 Canvas/);
});

test("Wiki search windows large result sets instead of rendering every hit", () => {
  assert.match(source, /virtualWindow/);
  assert.match(source, /visibleHits\.slice\(virtualWindow\.start, virtualWindow\.end\)/);
  assert.match(source, /overscan/);
});

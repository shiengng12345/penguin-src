import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");

test("Wiki human surface defaults to graph without the retired Focus navigation", () => {
  assert.match(page, /useState<CenterTab>\("graph"\)/);
  assert.match(page, /type CenterTab = "graph" \| "storage"/);
  assert.doesNotMatch(page, />Focus<\/TabBtn>/);
  assert.doesNotMatch(page, /icon=\{<Search/);
  assert.doesNotMatch(page, /<WikiSearchPage/);
  assert.match(page, />Graph<\/TabBtn>/);
  assert.match(page, /WikiContextPane/);
  assert.match(page, /Relations/);
  assert.doesNotMatch(page, /SLS Evidence/);
});

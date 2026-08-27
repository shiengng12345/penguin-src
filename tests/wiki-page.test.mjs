import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");

test("Wiki human surface defaults to graph with a focus search and relation pane", () => {
  assert.match(page, /useState<CenterTab>\("graph"\)/);
  assert.match(page, />Focus<\/TabBtn>/);
  assert.match(page, />Graph<\/TabBtn>/);
  assert.match(page, /WikiContextPane/);
  assert.match(page, /Relations/);
  assert.doesNotMatch(page, /SLS Evidence/);
});

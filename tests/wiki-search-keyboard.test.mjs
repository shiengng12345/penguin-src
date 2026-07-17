import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Wiki search keeps Cmd/Ctrl-K and keyboard hit activation", () => {
  const source = readFileSync(new URL("../src/components/wiki/WikiSearchPage.tsx", import.meta.url), "utf8");
  assert.match(source, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(source, /event\.key\.toLowerCase\(\) === "k"/);
  assert.match(source, /role="button"/);
  assert.match(source, /event\.key === "Enter"/);
});

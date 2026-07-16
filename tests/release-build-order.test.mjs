import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("release build compiles api-doc-generator before its consumers", () => {
  const build = packageJson.scripts.build;
  const generator = build.indexOf("@penguin/api-doc-generator build");
  const knowledgeCli = build.indexOf("@penguin/knowledge-cli build");
  assert.notEqual(generator, -1);
  assert.notEqual(knowledgeCli, -1);
  assert.ok(generator < knowledgeCli);
});

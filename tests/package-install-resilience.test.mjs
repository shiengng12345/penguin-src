import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/lib/package-manager.ts", import.meta.url), "utf8");

test("package installs use an app-owned npm cache instead of ~/.npm", () => {
  assert.match(source, /--cache/);
  assert.match(source, /\.npm-cache/);
});

test("package installs deduplicate concurrent requests for the same protocol and spec", () => {
  assert.match(source, /installLocks/);
  assert.match(source, /protocol.*packageSpec|packageSpec.*protocol/);
});

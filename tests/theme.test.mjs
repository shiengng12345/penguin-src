import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function loadThemeModule() {
  const source = await readFile(new URL("../src/lib/theme.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

test("includes the mascot themes and drops the removed color themes", async () => {
  const { THEMES, isAppTheme } = await loadThemeModule();

  for (const id of ["dark", "light", "penguin", "duck", "cat", "black-cat", "hamster", "rabbit"]) {
    assert.equal(isAppTheme(id), true, `${id} should be a valid theme`);
    assert.ok(THEMES.some((t) => t.id === id), `${id} should be in THEMES`);
  }
  // Nord / Emerald / Rose / Violet / Antarctic Snow were removed.
  for (const id of ["nord", "emerald", "rose", "violet", "antarctic-snow"]) {
    assert.equal(isAppTheme(id), false, `${id} should be removed`);
    assert.ok(!THEMES.some((t) => t.id === id), `${id} should be gone from THEMES`);
  }
});

test("treats the pale mascot themes as light visual themes", async () => {
  const { isLightAppTheme } = await loadThemeModule();

  assert.equal(isLightAppTheme("light"), true);
  assert.equal(isLightAppTheme("penguin"), true);
  assert.equal(isLightAppTheme("duck"), true);
  assert.equal(isLightAppTheme("rabbit"), true);
  assert.equal(isLightAppTheme("dark"), false);
  assert.equal(isLightAppTheme("antarctic-snow"), false); // removed
});

test("rejects unknown theme names", async () => {
  const { isAppTheme } = await loadThemeModule();

  assert.equal(isAppTheme("snow"), false);
  assert.equal(isAppTheme("antarctic"), false);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function loadReleaseWelcomePolicy() {
  const source = await readFile(new URL("../src/lib/app-update.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

test("release welcome appears for a fresh install and once for every new version", async () => {
  const policy = await loadReleaseWelcomePolicy();
  const shouldShowReleaseWelcome = policy.shouldShowReleaseWelcome;

  assert.equal(
    typeof shouldShowReleaseWelcome,
    "function",
    "the release welcome policy must exist before the first-launch dialog can be wired",
  );
  assert.equal(
    shouldShowReleaseWelcome({ currentVersion: "1.15.0", lastSeenVersion: null }),
    true,
    "a fresh install has no acknowledged version",
  );
  assert.equal(
    shouldShowReleaseWelcome({ currentVersion: "1.15.0", lastSeenVersion: "1.14.0" }),
    true,
    "installing a newer manual release must show the dialog",
  );
  assert.equal(
    shouldShowReleaseWelcome({ currentVersion: "1.15.0", lastSeenVersion: "1.15.0" }),
    false,
    "acknowledging the current release suppresses repeat launch dialogs",
  );
  assert.equal(
    shouldShowReleaseWelcome({ currentVersion: "", lastSeenVersion: null }),
    false,
    "an unavailable version must not trap the user in an unacknowledgeable dialog",
  );
});

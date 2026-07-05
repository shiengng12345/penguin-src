import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// Regression guard: upgrading the app must NOT wipe installed packages.
// main.tsx used to call clear_all_packages whenever the persisted
// cache-version differed from the running version — i.e. on the first
// launch after every release — deleting ~/.penguin/*/node_modules for all
// three protocols. Installed @snsoft packages are user data (reinstalling
// needs network + registry auth), not an app-version-derived cache.
// Bootstrap code has no runtime harness here, so per repo convention the
// contract is asserted at the source level.

test("app bootstrap never clears installed packages on version change", async () => {
  const src = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(
    src,
    /clear_all_packages/,
    "main.tsx must not wipe installed packages when the app version bumps",
  );
});

test("the manual Clear All Packages action in Settings is preserved", async () => {
  const src = await readFile(
    new URL("../src/components/settings/SettingsDialog.tsx", import.meta.url),
    "utf8",
  );
  assert.match(src, /clear_all_packages/, "the explicit user-initiated clear must stay");
});

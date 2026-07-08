import assert from "node:assert/strict";
import { readFile as readFileP, writeFile as writeFileP, unlink as unlinkP } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function loadModule() {
  const source = await readFileP(new URL("../src/lib/registry-auto-refresh.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  const tmpUrl = new URL(`./.tmp-regauto-${process.pid}.mjs`, import.meta.url);
  await writeFileP(tmpUrl, outputText);
  try {
    return await import(tmpUrl.href);
  } finally {
    await unlinkP(tmpUrl);
  }
}
const {
  canBackgroundRefreshRegistry,
  nextRegistryPollDelay,
  REGISTRY_AUTO_REFRESH_OPEN_MS,
  REGISTRY_AUTO_REFRESH_BACKGROUND_MS,
  REGISTRY_AUTO_REFRESH_MAX_BACKOFF_MS,
} = await loadModule();

test("allows refresh only when enabled AND devMode AND valid token", () => {
  assert.equal(
    canBackgroundRefreshRegistry({ enabled: true, devModeEnabled: true, hasValidToken: true }),
    true,
  );
});

test("strict: any single condition false → no refresh", () => {
  const base = { enabled: true, devModeEnabled: true, hasValidToken: true };
  assert.equal(canBackgroundRefreshRegistry({ ...base, enabled: false }), false);
  assert.equal(canBackgroundRefreshRegistry({ ...base, devModeEnabled: false }), false, "dev mode off must stop it");
  assert.equal(canBackgroundRefreshRegistry({ ...base, hasValidToken: false }), false, "expired/absent token must stop it");
});

test("a persisted enabled flag alone is not sufficient (non-admin)", () => {
  // The load-bearing case: a normal user (or an admin whose token expired) with
  // a leftover enabled=true must NOT get background polling.
  assert.equal(
    canBackgroundRefreshRegistry({ enabled: true, devModeEnabled: false, hasValidToken: false }),
    false,
  );
});

test("cadence: 5s while open, 30s in background", () => {
  assert.equal(REGISTRY_AUTO_REFRESH_OPEN_MS, 5_000);
  assert.equal(REGISTRY_AUTO_REFRESH_BACKGROUND_MS, 30_000);
});

test("backoff: base when healthy, doubles per failure, capped", () => {
  // healthy → base cadence
  assert.equal(nextRegistryPollDelay(5_000, 0), 5_000);
  // consecutive failures double
  assert.equal(nextRegistryPollDelay(5_000, 1), 10_000);
  assert.equal(nextRegistryPollDelay(5_000, 2), 20_000);
  assert.equal(nextRegistryPollDelay(5_000, 3), 40_000);
  // capped at the max
  assert.equal(nextRegistryPollDelay(5_000, 10), REGISTRY_AUTO_REFRESH_MAX_BACKOFF_MS);
  // background base backs off too
  assert.equal(nextRegistryPollDelay(30_000, 1), REGISTRY_AUTO_REFRESH_MAX_BACKOFF_MS);
});

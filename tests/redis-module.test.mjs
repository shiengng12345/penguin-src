// Redis module source-assertion tests.
//
// These guard the Redis Insight-style key browser contract: enriched scan
// rows, server-side type filtering, tree/list modes, namespace counters, and
// a compact stats strip in the page header.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function loadSource(relPath) {
  return readFile(new URL(relPath, import.meta.url), "utf8");
}

function assertNearby(source, anchor, pattern, message) {
  const start = source.indexOf(anchor);
  assert.notEqual(start, -1, `Missing source anchor: ${anchor}`);
  assert.match(source.slice(start, start + 600), pattern, message);
}

test("Redis backend registers enriched scan and dbsize commands", async () => {
  const commands = await loadSource("../src-tauri/src/redis/commands.rs");
  assert.match(commands, /pub async fn redis_scan_enriched\(/);
  assert.match(commands, /type_filter:\s*Option<String>/);
  assert.match(commands, /CustomCommand::new_static\("SCAN"/);
  assert.match(commands, /"TYPE"\.to_string\(\)/);
  assert.match(commands, /memory_usage/);
  assert.match(commands, /pub async fn redis_dbsize\(/);

  const lib = await loadSource("../src-tauri/src/lib.rs");
  assert.match(lib, /redis::commands::redis_scan_enriched/);
  assert.match(lib, /redis::commands::redis_dbsize/);
});

test("RedisKeyBrowser uses enriched rows with TTL, size, type filter, and tree/list modes", async () => {
  const src = await loadSource("../src/components/redis/RedisKeyBrowser.tsx");
  assert.match(src, /EnrichedKey/);
  assert.match(src, /EnrichedScanPage/);
  assert.match(src, /invoke<EnrichedScanPage>\("redis_scan_enriched"/);
  assert.match(src, /typeFilter/);
  assert.match(src, /REDIS_TYPE_FILTERS/);
  assert.match(src, /formatTtl/);
  assert.match(src, /formatBytes/);
  assert.match(src, /viewMode/);
  assert.match(src, /"tree"\s*\|\s*"list"/);
  assert.match(src, /namespacePercent/);
  assert.match(src, /folderCount/);
  assert.match(src, /TTL/);
  assert.match(src, /Size/);
  assert.doesNotMatch(src, /invoke<ScanPage>\("redis_scan"/);
});

test("RedisPage renders live header stats strip for memory, keys, ops, and clients", async () => {
  const src = await loadSource("../src/components/redis/RedisPage.tsx");
  assert.match(src, /RedisHeaderStat/);
  assert.match(src, /invoke<RedisStats>\("redis_info"/);
  assert.match(src, /invoke<number>\("redis_dbsize"/);
  assert.match(src, /listen<RedisStats>\("redis-stats-update"/);
  assert.match(src, /used_memory_human/);
  assert.match(src, /dbSize/);
  assert.match(src, /instantaneous_ops_per_sec/);
  assert.match(src, /connected_clients/);
  assert.match(src, /Memory/);
  assert.match(src, /Keys/);
  assert.match(src, /Ops\/sec/);
  assert.match(src, /Clients/);
});

test("Database module routes Redis as its first database type", async () => {
  const app = await loadSource("../src/App.tsx");
  assert.match(app, /import\s+\{\s*DatabasePage\s*\}\s+from\s+"@\/components\/database\/DatabasePage"/);
  assert.match(app, /"database"/);
  assert.match(app, /raw === "redis"[\s\S]{0,120}?return "database"/);
  assert.match(app, /const \[databaseOpen,\s*setDatabaseOpen\]/);
  assert.match(app, /canAccessDatabase\s*=\s*devModeEnabled\s*&&\s*isSuperAdmin/);
  assert.match(app, /if\s*\(databaseOpen\s*&&\s*!canAccessDatabase\)\s*setDatabaseOpen\(false\);/);
  assert.match(app, /else if \(m === "database"\) selectDatabase\(\);/);
  assert.match(app, /databaseOpen\s*\?\s*\(\s*<DatabasePage/);
  assert.match(app, /VALID_MODULES[\s\S]{0,240}"database"/);
  assertNearby(app, "const selectApiClient", /setDatabaseOpen\(false\)/, "Client selector must close Database");
  assertNearby(app, "const selectVaultFromHome", /setDatabaseOpen\(false\)/, "Vault selector must close Database");
  assertNearby(app, "const selectDocsFromHome", /setDatabaseOpen\(false\)/, "Docs selector must close Database");
  assertNearby(app, "const selectRest", /setDatabaseOpen\(false\)/, "REST selector must close Database");
  assertNearby(app, "const handleGoHome", /setDatabaseOpen\(false\)/, "Go-home event must close Database");
  assert.match(app, /isSuperAdmin=\{canAccessDocs\s*\|\|\s*canAccessDatabase\s*\|\|\s*canAccessBrowser\}/);

  const sidebar = await loadSource("../src/components/layout/MainSidebar.tsx");
  assert.match(sidebar, /"browser"\s*\|\s*"database"/);
  assert.match(sidebar, /kind:\s*"database"[\s\S]{0,180}?icon:\s*Database[\s\S]{0,180}?label:\s*"Database"[\s\S]{0,180}?requires:\s*"super-admin"/);

  const databasePage = await loadSource("../src/components/database/DatabasePage.tsx");
  assert.match(databasePage, /type DatabaseType = "redis"/);
  assert.match(databasePage, /const DATABASE_TYPES/);
  assert.match(databasePage, /RedisPage/);
  assert.match(databasePage, /activeType/);
  assert.match(databasePage, /DatabaseTypeButton/);
  assert.match(databasePage, /flex items-center gap-1\.5/);
  assert.match(databasePage, /id:\s*"redis"/);
  assert.match(databasePage, /label:\s*"Redis"/);
  assert.match(databasePage, /aria-pressed=\{active\}/);
  assert.match(databasePage, /<RedisPage onClose=\{onClose\}/);
});

test("Database module does not show the client protocol/environment selector in the global header", async () => {
  const app = await loadSource("../src/App.tsx");
  const header = await loadSource("../src/components/layout/Header.tsx");

  assert.match(
    app,
    /<Header[\s\S]{0,240}?showClientControls=\{activeModule === "client"\}/,
    "App should tell Header when the client request controls are actually relevant",
  );
  assert.match(header, /showClientControls:\s*boolean/);

  const guardedControlsStart = header.indexOf("showClientControls ? (");
  assert.notEqual(guardedControlsStart, -1, "Header should guard client controls behind showClientControls");
  const guardedControls = header.slice(guardedControlsStart, guardedControlsStart + 1000);
  assert.match(guardedControls, /protocolName/);
  assert.match(guardedControls, /<Select[\s\S]{0,240}?value=\{activeEnvId \?\? ""\}/);
  assert.match(guardedControls, /syncEnvironmentConfig/);
});

test("Redis value editors detect JSON and scalar datatypes", async () => {
  const inspector = await loadSource("../src/lib/redis-value-inspector.ts");
  assert.match(inspector, /export type RedisValueKind/);
  for (const kind of ["json-object", "json-array", "boolean", "number", "date", "null", "string"]) {
    assert.match(inspector, new RegExp(`"${kind}"`));
  }
  assert.match(inspector, /export function inferRedisValueKind/);
  assert.match(inspector, /export function formatRedisValueForEditor/);
  assert.match(inspector, /JSON\.parse/);
  assert.match(inspector, /Date\.parse/);

  const hash = await loadSource("../src/components/redis/values/RedisHashValue.tsx");
  assert.match(hash, /JsonEditor/);
  assert.match(hash, /inferRedisValueKind/);
  assert.match(hash, /formatRedisValueForEditor/);
  assert.match(hash, /RedisValueTypeBadge/);
  assert.match(hash, /kind === "json-object" \|\| kind === "json-array"/);
  assert.match(hash, /<JsonEditor/);
  assert.match(hash, /Type/);
  assert.match(hash, /Save/);

  const stringValue = await loadSource("../src/components/redis/values/RedisStringValue.tsx");
  assert.match(stringValue, /JsonEditor/);
  assert.match(stringValue, /inferRedisValueKind/);
  assert.match(stringValue, /formatRedisValueForEditor/);
  assert.match(stringValue, /RedisValueTypeBadge/);
  assert.match(stringValue, /kind === "json-object" \|\| kind === "json-array"/);
});

test("Redis string editor blocks saving truncated previews", async () => {
  const stringValue = await loadSource("../src/components/redis/values/RedisStringValue.tsx");

  assert.match(
    stringValue,
    /if\s*\(data\?\.truncated\)\s*return;/,
    "handleSave must not write a preview-only value back to Redis",
  );
  assert.match(
    stringValue,
    /disabled=\{saving\s*\|\|\s*data\.truncated\}/,
    "Save button must be disabled for truncated values",
  );
  assert.match(
    stringValue,
    /title=\{data\.truncated/,
    "UI should explain why Save is disabled for truncated values",
  );
});

test("Redis backend truncates string previews on UTF-8 boundaries", async () => {
  const valueRs = await loadSource("../src-tauri/src/redis/value.rs");
  const commands = await loadSource("../src-tauri/src/redis/commands.rs");

  assert.match(valueRs, /pub fn truncate_utf8_preview\(/);
  assert.match(valueRs, /is_char_boundary/);
  assert.match(commands, /truncate_utf8_preview\(&preview\)/);
  assert.doesNotMatch(
    commands,
    /s\[\.\.VALUE_PREVIEW_BYTES\]/,
    "Redis string preview must not slice UTF-8 strings at an arbitrary byte",
  );
});

test("Redis manual connection clears the previously active Vault key", async () => {
  const page = await loadSource("../src/components/redis/RedisPage.tsx");

  assert.match(
    page,
    /setActiveVaultKey\(vaultKey \?\? null\)/,
    "manual connections call handleConnected() without a vaultKey, so stale Vault active state must be cleared",
  );
  assert.match(page, /<RedisConnectionPanel onConnected=\{\(\) => handleConnected\(\)\}/);
});

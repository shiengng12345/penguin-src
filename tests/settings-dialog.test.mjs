import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("MCP settings show Codex setup alongside Claude clients", async () => {
  // Tightened: bare /Codex CLI/ etc. would match a stray comment or
  // unrelated import. Lock each client label to its per-client
  // command rendering — Codex CLI ↔ mcpCodexCliCommand, Claude Code
  // ↔ mcpClaudeCliCommand, Claude Desktop / Cursor ↔ mcpJsonSnippet —
  // so a refactor that breaks the Codex block specifically gets
  // caught even if the string still appears elsewhere.
  const source = await readFile(
    new URL("../src/components/settings/SettingsDialog.tsx", import.meta.url),
    "utf8",
  );

  // Three per-client surfaces — each label paired with its command var.
  assert.match(source, /Codex CLI[\s\S]{0,2000}?mcpCodexCliCommand/);
  assert.match(source, /Claude Code[\s\S]{0,2000}?mcpClaudeCliCommand/);
  assert.match(source, /Claude Desktop \/ Cursor[\s\S]{0,2000}?mcpJsonSnippet/);
});

test("MCP primary action uses client-neutral wording", async () => {
  const source = await readFile(
    new URL("../src/components/settings/SettingsDialog.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /Configure MCP Clients/);
  assert.match(source, /Reconfigure MCP Clients/);
  assert.match(source, /MCP Ready/);
  assert.match(source, /Server Check Failed/);
  assert.match(source, /Partial Setup/);
  assert.match(source, /invoke<string>\("mcp_install_to_local_clients"\)/);
  assert.doesNotMatch(source, /Add to Claude Desktop/);
  assert.doesNotMatch(source, /Re-add to Claude Desktop/);
  assert.doesNotMatch(source, /Claude Desktop Configured/);
  assert.doesNotMatch(source, /Restart Claude Desktop/);
  // The one-click flow covers all three local clients, incl. Claude Code CLI.
  assert.match(source, /claude_code_configured: boolean/);
  assert.match(source, /mcpClaudeCodeConfigured/);
});

test("MCP install refreshes status after partial failure", async () => {
  const source = await readFile(
    new URL("../src/components/settings/SettingsDialog.tsx", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("  const handleMcpInstall");
  const end = source.indexOf("  const mcpNodePath", start);
  const handler = source.slice(start, end);

  assert.match(handler, /catch \(err\) \{\n\s+await refreshMcpStatus\(\);\n\s+setMcpInstallMsg/);
});

test("MCP status checks server runtime health, not only client config presence", async () => {
  const settingsSource = await readFile(
    new URL("../src/components/settings/SettingsDialog.tsx", import.meta.url),
    "utf8",
  );
  const backendSource = await readFile(new URL("../src-tauri/src/mcp.rs", import.meta.url), "utf8");
  const libSource = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const statusStart = settingsSource.indexOf("  const mcpClaudeConfigured");
  const statusEnd = settingsSource.indexOf("  const copyMcpSetup", statusStart);
  const statusBlock = settingsSource.slice(statusStart, statusEnd);

  // Health is a separate slow command (node smoke test, up to 1.5s) so
  // mcp_status stays fast and Settings opens instantly; the dialog fires
  // mcp_server_health without awaiting and fills the badge in when it lands.
  assert.match(backendSource, /struct McpServerHealth/);
  assert.match(backendSource, /fn mcp_server_health/);
  assert.match(backendSource, /fn check_mcp_server_runtime/);
  assert.match(backendSource, /"method":"initialize"/);
  assert.match(libSource, /mcp_server_health,/);
  // mcp_status must NOT carry health fields — that would put the 1.5s probe
  // back on the fast path.
  assert.doesNotMatch(backendSource, /server_healthy:\s*bool/);
  assert.match(
    settingsSource,
    /invoke<\{ healthy: boolean; error: string \| null \}>\("mcp_server_health"\)/,
  );
  assert.match(settingsSource, /void refreshMcpHealth\(\)/);
  assert.match(statusBlock, /mcpServerHealthy/);
  assert.match(statusBlock, /mcpReady/);
  assert.match(statusBlock, /MCP Ready/);
  assert.match(statusBlock, /Server Check Failed/);
  assert.match(statusBlock, /Checking Server/);
  assert.doesNotMatch(statusBlock, /mcpBothConfigured\s*\?\s*"Both Configured"/);
});

test("MCP backend exposes only the dual-client install command", async () => {
  const libSource = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const mcpSource = await readFile(new URL("../src-tauri/src/mcp.rs", import.meta.url), "utf8");

  assert.match(mcpSource, /fn mcp_install_to_local_clients/);
  assert.match(libSource, /mcp_install_to_local_clients,/);
  assert.doesNotMatch(mcpSource, /fn mcp_install_to_claude_desktop/);
  assert.doesNotMatch(libSource, /mcp_install_to_claude_desktop,/);
});

test("clear cache refreshes package state without reloading the app", async () => {
  const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const storeSource = await readFile(new URL("../src/lib/store.ts", import.meta.url), "utf8");
  const storeTypesSource = await readFile(
    new URL("../src/lib/store-types.ts", import.meta.url),
    "utf8",
  );
  const settingsSource = await readFile(
    new URL("../src/components/settings/SettingsDialog.tsx", import.meta.url),
    "utf8",
  );
  const clearStart = settingsSource.indexOf("  const handleClearCache");
  const clearEnd = settingsSource.indexOf("  const updateHeader", clearStart);
  const clearHandler = settingsSource.slice(clearStart, clearEnd);

  assert.match(settingsSource, /onPackagesCleared: \(\) => Promise<void>/);
  // AppState interface (with the action signature) lives in store-types.ts;
  // the action body stays in store.ts.
  assert.match(storeTypesSource, /resetPackageTabs: \(\) => void/);
  assert.match(storeSource, /resetPackageTabs: \(\) => \{/);
  assert.match(storeSource, /const fresh = createTab\(\)/);
  assert.match(storeSource, /set\(\{ tabs: \[fresh\], activeTabId: fresh\.id \}\)/);
  assert.match(storeSource, /saveTabs\(\[fresh\], fresh\.id\)/);
  assert.match(storeSource, /selectedPackage: null/);
  assert.match(storeSource, /selectedService: null/);
  assert.match(storeSource, /selectedMethod: null/);
  assert.match(appSource, /const handlePackagesCleared/);
  assert.match(appSource, /resetPackageTabs\(\);\n\s+await refresh\(\);/);
  assert.match(appSource, /onPackagesCleared=\{handlePackagesCleared\}/);
  assert.match(clearHandler, /await invoke<string>\("clear_all_packages"\)/);
  assert.match(clearHandler, /await onPackagesCleared\(\)/);
  assert.doesNotMatch(clearHandler, /window\.location\.reload/);
});

test("manage environments uses an explicit button affordance", async () => {
  const source = await readFile(
    new URL("../src/components/settings/SettingsDialog.tsx", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("Manage Environments / 管理环境");
  const section = source.slice(Math.max(0, start - 900), start + 500);

  assert.match(section, /Settings2/);
  assert.match(section, /ChevronRight/);
  assert.match(section, /variant="outline"/);
  // /justify-between/ regex dropped — that's incidental layout and
  // would flip on a redesign without changing the actual affordance.
  // The other assertions lock the meaningful contract (button +
  // icon + aria-label + visible label).
  assert.match(section, /Open environment manager/);
  assert.match(section, /Manage Environments \/ 管理环境/);
});

test("settings default header tabs cover non-REST protocols only (REST headers managed per-collection)", async () => {
  const source = await readFile(
    new URL("../src/components/settings/SettingsDialog.tsx", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const PROTOCOL_TABS");
  const end = source.indexOf("function envsForProtocol", start);
  const visibleTabs = source.slice(start, end);

  assert.match(visibleTabs, /id: "grpc-web"/);
  assert.match(visibleTabs, /id: "grpc"/);
  assert.match(visibleTabs, /id: "sdk"/);
  assert.doesNotMatch(visibleTabs, /id: "rest"/);
  assert.doesNotMatch(visibleTabs, /label: "REST"/);
});

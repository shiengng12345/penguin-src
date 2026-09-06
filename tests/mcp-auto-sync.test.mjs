import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("app startup automatically refreshes the stable MCP launcher and local clients", async () => {
  const libSource = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const mcpSource = await readFile(new URL("../src-tauri/src/mcp.rs", import.meta.url), "utf8");

  assert.match(libSource, /mcp::sync_stable_mcp_server_on_startup\(app\.handle\(\)\.clone\(\)\)/);
  assert.match(
    mcpSource,
    /move \|_| mcp_install_to_local_clients_blocking\(&client_config_app\)/,
    "startup preflight must perform the same client refresh as the manual action",
  );
  assert.match(mcpSource, /write_atomic\(cfg_path, &pretty\)/);
  assert.match(mcpSource, /write_atomic\(cfg_path, &rendered\)/);
  assert.match(mcpSource, /static MCP_CLIENT_CONFIG_LOCK/);
  assert.match(mcpSource, /MCP_CLIENT_CONFIG_LOCK\s*\.lock\(\)/);
});

test("release upgrade flow consumes the structured automatic MCP refresh result", async () => {
  const source = await readFile(
    new URL("../src/components/onboarding/ReleaseWelcomeDialog.tsx", import.meta.url),
    "utf8",
  );
  const clientSource = await readFile(
    new URL("../src/lib/knowledge-client.ts", import.meta.url),
    "utf8",
  );
  const onboardingSource = await readFile(
    new URL("../src/components/wiki/WikiOnboarding.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /interface McpInstallResult/);
  assert.match(source, /invoke<McpInstallResult>\("mcp_install_to_local_clients"\)/);
  assert.match(source, /changedClients/);
  assert.match(source, /unchangedClients/);
  assert.match(source, /skippedClients/);
  assert.match(clientSource, /export interface McpInstallResult/);
  assert.match(clientSource, /mcpInstallToLocalClients\(\): Promise<McpInstallResult>/);
  assert.match(onboardingSource, /const result = await mcpInstallToLocalClients\(\)/);
  assert.match(onboardingSource, /result\.skippedClients/);
});

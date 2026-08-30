import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/components/settings/mcp-status.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
});
const { deriveMcpStatusView } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

const baseStatus = { configured: true, launcherHealthy: true, initializeHealthy: null, clientRestartRequired: null, runtimeOutdated: null };

test("existing configuration is not reported as a new write or permanent restart", () => {
  const view = deriveMcpStatusView({ status: baseStatus, health: null, writeResult: "not-run", pendingClientReload: false });
  assert.equal(view.configurationLabel, "Configuration present");
  assert.equal(view.writeLabel, "No configuration change in this session");
  assert.equal(view.clientReloadNotice, null);
  assert.equal(view.canCopySetup, true);
});

test("a write result creates an independently clearable client reload reminder", () => {
  const view = deriveMcpStatusView({ status: baseStatus, health: null, writeResult: "written", pendingClientReload: true });
  assert.equal(view.writeLabel, "Configuration written this session");
  assert.match(view.clientReloadNotice, /restart may be required/i);
  assert.equal(view.runtimeOutdated, false);
});

test("local MCP health can surface runtime outdated without claiming an external client reloaded", () => {
  const view = deriveMcpStatusView({
    status: baseStatus,
    health: { initializeHealthy: true, runtimeOutdated: true, clientRestartRequired: true },
    writeResult: "unchanged",
    pendingClientReload: false,
  });
  assert.equal(view.runtimeOutdated, true);
  assert.match(view.statusLabel, /Runtime Outdated/);
  assert.match(view.runtimeNotice, /restart the MCP session/i);
  assert.equal(view.clientReloadNotice, null);
});

test("setup snippets require a healthy launcher", () => {
  const view = deriveMcpStatusView({ status: { ...baseStatus, launcherHealthy: false }, health: null, writeResult: "not-run", pendingClientReload: false });
  assert.equal(view.canCopySetup, false);
  assert.match(view.copyDisabledNotice, /launcher is not ready/i);
});

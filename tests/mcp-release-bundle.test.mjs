import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, cp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CAPABILITIES, capabilityHash } from "../packages/knowledge-contracts/dist/index.js";

async function initializeIsolatedMcpServer(entryPath) {
  const dir = await mkdtemp(join(tmpdir(), "penguin-mcp-release-"));
  const packageDir = join(dir, "packages", "mcp");
  const distDir = join(packageDir, "dist");
  const isolatedEntry = join(distDir, "index.js");
  await mkdir(distDir, { recursive: true });
  await cp(new URL("../packages/mcp/package.json", import.meta.url), join(packageDir, "package.json"));
  await cp(entryPath, isolatedEntry);

  const child = spawn(process.execPath, [isolatedEntry], {
    cwd: dir,
    env: { ...process.env, NODE_PATH: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    return await new Promise((resolve) => {
      // Generous ceiling: under parallel test load, spawning node + loading
      // the ~1MB bundle can take >500ms. Success resolves on child exit, so
      // this only delays the failure path.
      const timer = setTimeout(() => {
        child.kill();
        resolve({ timedOut: true, stdout, stderr });
      }, 5000);

      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ timedOut: false, code, stdout, stderr });
      });

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "release-bundle-test", version: "0.0.0" },
          },
        })}\n`,
      );
      child.stdin.end();
    });
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
}

test("release-bundled MCP server initializes without workspace node_modules", async () => {
  const entry = new URL("../packages/mcp/dist/index.js", import.meta.url);
  const result = await initializeIsolatedMcpServer(entry);

  assert.equal(
    result.timedOut,
    false,
    `MCP server did not answer initialize.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const response = JSON.parse(result.stdout);
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 0);
  assert.equal(response.result.protocolVersion, "2025-11-25");
  assert.deepEqual(response.result.capabilities, { tools: {} });
  assert.deepEqual(response.result.serverInfo, {
    name: "penguin-mcp",
    version: `0.0.1+knowledge-${capabilityHash(CAPABILITIES).slice(0, 12)}`,
  });
  assert.deepEqual(JSON.parse(response.result.instructions), {
    contractVersion: "2",
    schemaVersion: 14,
    capabilityHash: capabilityHash(CAPABILITIES),
  });
});

test("MCP release entry has no static workspace-only imports", async () => {
  const source = await readFile(new URL("../packages/mcp/dist/index.js", import.meta.url), "utf8");
  const staticImportLines = source
    .split("\n")
    .filter((line) => line.startsWith("import "));

  assert.deepEqual(
    staticImportLines.filter((line) =>
      /from\s+["'](?:@modelcontextprotocol\/sdk|@penguin\/core)\b/.test(line) ||
      /from\s+["']\.\/(?:config|penguin-paths|parse-services|runners|app-db)\.js["']/.test(line),
    ),
    [],
  );
});

test("Tauri release resources include the MCP ESM package marker", async () => {
  const tauriConfig = JSON.parse(
    await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );

  // The MCP ESM markers must ship; assert inclusion (not exact equality) so
  // unrelated resources (e.g. the knowledge CLI bundle) don't break this.
  for (const marker of [
    "../.penguin.config.json",
    "../packages/mcp/package.json",
    "../packages/mcp/dist/index.js",
    "../packages/mcp/bundle/**/*",
  ]) {
    assert.ok(
      tauriConfig.bundle.resources.includes(marker),
      `missing release resource: ${marker}`,
    );
  }
});

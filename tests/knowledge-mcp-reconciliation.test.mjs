import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { build } from "esbuild";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runFullCorpus } from "../packages/knowledge-indexer/dist/index.js";

function commitFixture(root) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Penguin Test",
    GIT_AUTHOR_EMAIL: "penguin@example.test",
    GIT_COMMITTER_NAME: "Penguin Test",
    GIT_COMMITTER_EMAIL: "penguin@example.test",
  };
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"], { env });
}

async function loadTools() {
  const directory = mkdtempSync(join(tmpdir(), `penguin-mcp-reconcile-${process.pid}-`));
  const handler = join(directory, "handler.mjs");
  const coreDist = new URL("../packages/knowledge-core/dist/index.js", import.meta.url).pathname;
  await build({
    entryPoints: [new URL("../packages/mcp/src/knowledge-tools.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: handler,
    alias: { "@penguin/knowledge-core": coreDist },
  });
  return import(`file://${handler}`);
}

test("MCP doctor reconciliation uses an independent source oracle and one scope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-mcp-reconcile-fixture-"));
  const projects = join(directory, "Projects");
  const repoRoot = join(projects, "auth");
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(join(repoRoot, "version.controller.ts"), `
    import { GrpcMethod } from "@nestjs/microservices";
    export class VersionController {
      @GrpcMethod("VersionService", "Version")
      version(): string { return "1.0.0"; }
    }
  `);
  commitFixture(repoRoot);
  process.env.PENGUIN_MCP_WORKSPACE_ROOTS = projects;
  const { runKnowledgeTool } = await loadTools();
  const store = KnowledgeStore.open({
    dbPath: join(directory, "knowledge.db"),
    ledgerPath: join(directory, "ledger.jsonl"),
  });
  const previousDb = process.env.PENGUIN_KNOWLEDGE_DB;
  const previousLedger = process.env.PENGUIN_KNOWLEDGE_LEDGER;
  process.env.PENGUIN_KNOWLEDGE_DB = join(directory, "knowledge.db");
  process.env.PENGUIN_KNOWLEDGE_LEDGER = join(directory, "ledger.jsonl");
  try {
    const run = await runFullCorpus({ store, rootPath: projects, modes: ["rebuild"], semantic: { enabled: false } });
    assert.equal(run.failures.length, 0, JSON.stringify(run.failures));
    const result = await runKnowledgeTool("knowledge_doctor", {
      reconcile: { root_path: projects, strict: true },
    }, { store });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.mode, "reconciliation");
    assert.equal(result.repositories.length, 1);
    assert.equal(result.repositories[0].status, "passed", JSON.stringify(result.repositories[0]));
    assert.deepEqual(
      result.repositories[0].sourceOracle.endpointRecords.map((record) => record.key),
      ["gRPC VersionService.Version"],
    );
    assert.deepEqual(result.repositories[0].endpoints.missingFromPersisted, []);
  } finally {
    store.close();
    if (previousDb === undefined) delete process.env.PENGUIN_KNOWLEDGE_DB;
    else process.env.PENGUIN_KNOWLEDGE_DB = previousDb;
    if (previousLedger === undefined) delete process.env.PENGUIN_KNOWLEDGE_LEDGER;
    else process.env.PENGUIN_KNOWLEDGE_LEDGER = previousLedger;
  }
});

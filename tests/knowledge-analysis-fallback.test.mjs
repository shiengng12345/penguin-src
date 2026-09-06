import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

async function loadAnalysis() {
  const root = mkdtempSync(join(tmpdir(), `penguin-analysis-${process.pid}-`));
  const outfile = join(root, "repository-analysis.mjs");
  await build({
    entryPoints: [new URL("../packages/mcp/src/repository-analysis.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    external: ["better-sqlite3"],
    alias: { "@penguin/knowledge-core": new URL("../packages/knowledge-core/dist/index.js", import.meta.url).pathname },
  });
  return import(`file://${outfile}`);
}

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-analysis-fixture-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "auth", rootPath: join(dir, "auth") });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live", headCommit: "head-auth" });
  const controller = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::VersionController`, title: "VersionController", repoId });
  const service = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::VersionService`, title: "VersionService", repoId });
  const versionMethod = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::VersionService.version`, title: "version", repoId });
  const response = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::VersionPb.VersionRes`, title: "VersionRes", repoId });
  store.indexSymbolText({ nodeId: controller, name: "VersionController", signature: "VersionController.version()" });
  store.indexSymbolText({ nodeId: service, name: "VersionService", signature: "VersionService" });
  store.indexSymbolText({ nodeId: versionMethod, name: "version", signature: "VersionService.version()" });
  store.indexSymbolText({ nodeId: response, name: "VersionRes", signature: "VersionPb.VersionRes" });
  for (const [nodeId, filePath, title] of [
    [controller, "libs/tools/src/version/version.controller.ts", "controller"],
    [service, "libs/tools/src/version/version.service.ts", "service"],
    [versionMethod, "libs/tools/src/version/version.service.ts", "version"],
    [response, "libs/tools/src/version/version.pb.ts", "response"],
  ]) {
    store.upsertSymbolVersion({
      nodeId,
      branchId,
      commitSha: "head-auth",
      filePath,
      lang: "ts",
      kind: title === "version" ? "method" : "class",
      signature: title === "version" ? "VersionService.version()" : title,
      startLine: 1,
      endLine: 4,
      contentHash: `hash-${title}`,
      status: "fresh",
    });
  }
  store.replaceFileEdges({
    repoId,
    branchId,
    filePath: "libs/tools/src/version/version.controller.ts",
    edges: [
      { src: controller, dst: versionMethod, edgeType: "calls", origin: "parser", method: "EXTRACTED", provenance: { receiver: "this.versionService", receiverType: "VersionService" } },
      { src: versionMethod, dst: response, edgeType: "calls", origin: "parser", method: "EXTRACTED" },
    ],
  });
  return { store, repoId, branchId, controller, service, versionMethod, response };
}

test("analyze_repository falls back to deterministic scoped flow evidence", async () => {
  const { analyzeRepository } = await loadAnalysis();
  const fixture = seed();
  const result = analyzeRepository(fixture.store, {
    query: "How does VersionService reach the Version endpoint?",
    repo: "auth",
    focus: "calls",
    limit: 10,
  });

  assert.ok(result.trace, "analysis must expose the fallback trace");
  assert.ok(result.trace.attempted.includes("search"));
  assert.ok(result.trace.attempted.includes("explore"));
  assert.equal(result.trace.timeoutStage, null);
  assert.ok(result.trace.resultCount > 0);
  assert.notEqual(result.trace.selected, null);
  assert.ok(result.evidence.some((item) => item?.flow?.steps?.some((step) => step.title === "version")));
  assert.ok(result.verifiedFacts.length > 0);
  assert.ok(!result.gaps.some((gap) => /No indexed symbol or note matched/i.test(gap)));
  fixture.store.close();
});

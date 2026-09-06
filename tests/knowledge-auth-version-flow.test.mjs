import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  KnowledgeStore,
  affectedByFiles,
  buildFlow,
} from "../packages/knowledge-core/dist/index.js";
import {
  extractSymbols,
  indexRepo,
} from "../packages/knowledge-indexer/dist/index.js";
import { resolveRefs } from "../packages/knowledge-indexer/dist/index.js";

test("extracts a receiver property binding and preserves Auth method-call provenance", async () => {
  const source = `import { Controller } from "@nestjs/common";
import { GrpcMethod } from "@nestjs/microservices";
import { VersionService } from "./version.service";
import { OtherService } from "./other.service";

@Controller()
export class VersionController {
  constructor(
    private readonly versionService: VersionService,
    private readonly otherService: OtherService,
  ) {}

  @GrpcMethod("VersionService", "Version")
  version() { return this.versionService.version(); }
  other() { return this.otherService.version(); }
}
`;
  const extracted = await extractSymbols({ lang: "ts", relPath: "src/version.controller.ts", source });
  const bindings = extracted.receiverBindings ?? [];
  assert.ok(bindings.some((binding) =>
    binding.ownerQualifiedName === "VersionController"
      && binding.propertyName === "versionService"
      && binding.typeName === "VersionService",
  ), JSON.stringify(bindings));
  assert.ok(bindings.some((binding) =>
    binding.ownerQualifiedName === "VersionController"
      && binding.propertyName === "otherService"
      && binding.typeName === "OtherService",
  ), JSON.stringify(bindings));

  const ids = new Map(extracted.symbols.map((symbol, index) => [symbol.qualifiedName, `local-${index}`]));
  const targets = new Map([
    ["VersionService.version", "version-service-method"],
    ["OtherService.version", "other-service-method"],
  ]);
  const resolved = resolveRefs({
    refs: extracted.refs,
    fileSymbols: extracted.symbols,
    fileSymbolIds: ids,
    language: "ts",
    currentFile: "src/version.controller.ts",
    importedFiles: new Set(["src/version.service.ts", "src/other.service.ts"]),
    receiverBindings: bindings,
    lookup: {
      byQualifiedName: (name) => targets.get(name) ?? null,
      bareNameCandidates: (name) => name === "version"
        ? [
          { id: "version-service-method", filePath: "src/version.service.ts", qualifiedName: "VersionService.version" },
          { id: "other-service-method", filePath: "src/other.service.ts", qualifiedName: "OtherService.version" },
        ]
        : [],
    },
  });
  const controllerMethod = ids.get("VersionController.version");
  const controllerOther = ids.get("VersionController.other");
  const versionCall = resolved.edges.find((edge) => edge.edgeType === "calls" && edge.src === controllerMethod);
  const otherCall = resolved.edges.find((edge) => edge.edgeType === "calls" && edge.src === controllerOther);
  assert.equal(versionCall?.dst, "version-service-method", JSON.stringify(resolved));
  assert.equal(versionCall?.provenance?.receiver, "this.versionService");
  assert.equal(versionCall?.provenance?.receiverType, "VersionService");
  assert.equal(otherCall?.dst, "other-service-method", JSON.stringify(resolved));
});

function writeAuthFixture(root) {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "version.controller.ts"), `import { Controller } from "@nestjs/common";
import { GrpcMethod } from "@nestjs/microservices";
import { VersionService } from "./version.service";
import { OtherService } from "./other.service";

@Controller()
export class VersionController {
  constructor(
    private readonly versionService: VersionService,
    private readonly otherService: OtherService,
  ) {}

  @GrpcMethod("VersionService", "Version")
  version() { return this.versionService.version(); }
  other() { return this.otherService.version(); }
}
`);
  writeFileSync(join(root, "src", "version.service.ts"), `import * as VersionPb from "./version.pb";
export class VersionService {
  version(): VersionPb.VersionRes { return new VersionPb.VersionRes(); }
}
`);
  writeFileSync(join(root, "src", "other.service.ts"), `export class OtherService {
  version() { return { other: true }; }
}
`);
  writeFileSync(join(root, "src", "version.pb.ts"), `export class VersionRes {
  baseResponse = { message: "Successfully get version" };
  data = "1.0.0";
}
`);
  writeFileSync(join(root, "src", "version.module.ts"), `import { Module } from "@nestjs/common";
import { VersionController } from "./version.controller";
import { VersionService } from "./version.service";
import { OtherService } from "./other.service";

@Module({
  controllers: [VersionController],
  providers: [VersionService, OtherService],
})
export class VersionModule {}
`);
}

test("MCP-facing core data contains the complete Auth Version flow and truthful affected evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-auth-version-flow-"));
  const dbDir = mkdtempSync(join(tmpdir(), "penguin-auth-version-db-"));
  writeAuthFixture(root);
  const store = KnowledgeStore.open({ dbPath: join(dbDir, "knowledge.db"), ledgerPath: join(dbDir, "ledger.jsonl") });
  try {
    const report = await indexRepo({ store, rootPath: root, mode: "rebuild" });
    const idFor = (qualifiedName) => {
      const row = store.db.prepare(
        "SELECT id FROM nodes WHERE repo_id=? AND json_extract(meta, '$.qualifiedName')=? LIMIT 1",
      ).get(report.repoId, qualifiedName);
      assert.ok(row, `missing symbol ${qualifiedName}`);
      return row.id;
    };
    const controllerVersion = idFor("VersionController.version");
    const controllerOther = idFor("VersionController.other");
    const versionMethod = idFor("VersionService.version");
    const otherMethod = idFor("OtherService.version");
    const versionResponse = idFor("VersionRes");
    const endpoint = store.db.prepare(
      "SELECT id FROM nodes WHERE node_type='endpoint' AND identity_key='grpc::VersionService.version' LIMIT 1",
    ).get();
    assert.ok(endpoint, "Version endpoint must be published");

    const calls = store.db.prepare(
      "SELECT src, dst, provenance FROM edges WHERE edge_type='calls' AND status='active' AND src IN (?, ?)",
    ).all(controllerVersion, controllerOther);
    const versionCall = calls.find((edge) => edge.src === controllerVersion);
    const otherCall = calls.find((edge) => edge.src === controllerOther);
    assert.equal(versionCall?.dst, versionMethod, JSON.stringify(calls));
    assert.equal(otherCall?.dst, otherMethod, JSON.stringify(calls));
    assert.notEqual(versionCall?.dst, otherMethod, "VersionController.version must not bind to OtherService.version");
    const provenance = JSON.parse(versionCall.provenance);
    assert.equal(provenance.receiver, "this.versionService");
    assert.equal(provenance.receiverType, "VersionService");
    assert.ok(Number(provenance.startLine) > 0, JSON.stringify(provenance));

    const moduleId = idFor("VersionModule");
    const moduleControllerEdge = store.db.prepare(
      "SELECT 1 FROM edges WHERE edge_type='provides' AND src=? AND dst=? AND status='active' LIMIT 1",
    ).get(moduleId, controllerVersion.replace(/::[^:]+$/, ""));
    const moduleProvidesController = store.db.prepare(
      "SELECT 1 FROM edges e JOIN nodes n ON n.id=e.dst WHERE e.edge_type='provides' AND e.src=? AND n.title='VersionController' AND e.status='active' LIMIT 1",
    ).get(moduleId);
    assert.ok(moduleProvidesController ?? moduleControllerEdge, "@Module controllers must be represented");

    const flow = buildFlow(store, "VersionService.Version", { repoId: report.repoId, branchId: report.branchId });
    const flowIds = new Set(flow.steps.map((step) => step.nodeId));
    assert.ok(flowIds.has(endpoint.id), JSON.stringify(flow));
    assert.ok(flowIds.has(controllerVersion), JSON.stringify(flow));
    assert.ok(flowIds.has(versionMethod), JSON.stringify(flow));
    assert.ok(flowIds.has(versionResponse), JSON.stringify(flow));
    assert.ok(!flowIds.has(otherMethod), JSON.stringify(flow));

    const affected = affectedByFiles(store, ["src/version.controller.ts"], { branchId: report.branchId });
    assert.ok(affected.routes.some((route) => /VersionService\.Version/u.test(route)), JSON.stringify(affected));
    assert.ok(affected.dependencies.some((node) => node.nodeId === versionMethod), JSON.stringify(affected));
    assert.equal(affected.tests.length, 0, "no direct test file is indexed in this fixture");
    assert.equal(affected.totalIsExact, false, "absence of a test edge is not proof of complete test coverage");
    assert.ok(affected.suggestedVerification?.length, JSON.stringify(affected));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

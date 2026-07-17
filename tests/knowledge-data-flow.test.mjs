import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, GitTopologyStore, SourceStore, SourceSnapshotStore, traceDataFlow, traceDataFlowPath } from "../packages/knowledge-core/dist/index.js";

test("bounded data-flow returns source-backed steps for parser gaps", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-flow-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "flow", rootPath: dir });
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: "flow", repoId, parserVersion: "p", resolverVersion: "r", schemaVersion: 13 });
  const raw = Buffer.from("const cpf = request.cpf;\nconst result = lookup(cpf);\nreturn result;\n");
  const hash = createHash("sha256").update(raw).digest("hex");
  const source = new SourceStore(store); const blob = source.putBlob({ contentHash: hash, rawBytes: raw, decodedContent: raw.toString(), encoding: "utf8" });
  const fact = source.putSourceFact({ repoId, filePath: "src/flow.ts", factFingerprint: hash, contentHash: hash, sourceBlobId: blob, coverage: { status: "admitted", reasonCode: "text_searchable", classification: "source" } });
  new SourceSnapshotStore(store).replaceOverlay(snapshot.id, [{ op: "add", path: "src/flow.ts", sourceFactId: fact }]); new SourceSnapshotStore(store).materializeManifest(snapshot.id);
  const result = traceDataFlow(store, { snapshotId: snapshot.id, filePath: "src/flow.ts", variable: "cpf" });
  assert.equal(result.status, "found"); assert.equal(result.steps[0].kind, "definition"); assert.equal(result.steps.every((step) => step.evidence === "verified"), true);
  store.close();
});

test("SSA-lite data-flow records verified steps and stops at opaque calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-flow-path-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "flow-path", rootPath: dir });
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: "flow-path", repoId, parserVersion: "p", resolverVersion: "r", schemaVersion: 13 });
  const raw = Buffer.from("const cpf = request.cpf;\nconst normalized = normalize(cpf);\nif (!normalized) throw new Error('invalid');\nreturn normalized;\n");
  const hash = createHash("sha256").update(raw).digest("hex");
  const source = new SourceStore(store); const blob = source.putBlob({ contentHash: hash, rawBytes: raw, decodedContent: raw.toString(), encoding: "utf8" });
  const fact = source.putSourceFact({ repoId, filePath: "src/path.ts", factFingerprint: hash, contentHash: hash, sourceBlobId: blob, coverage: { status: "admitted", reasonCode: "text_searchable", classification: "source" } });
  new SourceSnapshotStore(store).replaceOverlay(snapshot.id, [{ op: "add", path: "src/path.ts", sourceFactId: fact }]); new SourceSnapshotStore(store).materializeManifest(snapshot.id);
  const result = traceDataFlowPath(store, { snapshotId: snapshot.id, filePath: "src/path.ts", variable: "cpf", maxSteps: 20 });
  assert.ok(result);
  assert.deepEqual(result.steps.map((step) => step.kind), ["assign", "assign", "argument", "guard", "return"]);
  assert.equal(result.steps[2].status, "candidate");
  assert.equal(result.sink.kind, "return");
  assert.match(result.gaps[0], /opaque call boundary/);
  assert.equal(result.steps.every((step) => step.locator.revisionId === snapshot.id), true);
  store.close();
});

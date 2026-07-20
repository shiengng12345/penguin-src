import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, GitTopologyStore, SourceStore, SourceSnapshotStore, traceDataFlow, traceDataFlowPath, traceVerifiedInterproceduralFlow } from "../packages/knowledge-core/dist/index.js";

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
  assert.equal(result.sink.locator.filePath, "src/path.ts");
  assert.equal(result.sink.locator.startLine, 4);
  assert.match(result.gaps[0], /opaque call boundary/);
  assert.equal(result.steps.every((step) => step.locator.revisionId === snapshot.id), true);
  store.close();
});

test("inter-procedural data-flow follows verified call edges and stops at candidate edges", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-flow-inter-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "flow-inter", rootPath: dir });
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: "flow-inter", repoId, parserVersion: "p", resolverVersion: "r", schemaVersion: 13 });
  const source = new SourceStore(store);
  const add = (filePath, content) => {
    const raw = Buffer.from(content); const hash = createHash("sha256").update(raw).digest("hex");
    const blob = source.putBlob({ contentHash: hash, rawBytes: raw, decodedContent: content, encoding: "utf8" });
    return source.putSourceFact({ repoId, filePath, factFingerprint: hash, contentHash: hash, sourceBlobId: blob, coverage: { status: "admitted", reasonCode: "text_searchable", classification: "source" } });
  };
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(snapshot.id, [{ op: "add", path: "src/a.ts", sourceFactId: add("src/a.ts", "const cpf = request.cpf;\nconst result = lookup(cpf);\nreturn result;\n"), }, { op: "add", path: "src/b.ts", sourceFactId: add("src/b.ts", "const input = request.cpf;\nreturn input;\n") }]);
  cow.materializeManifest(snapshot.id);
  const verified = traceVerifiedInterproceduralFlow(store, { snapshotId: snapshot.id, filePath: "src/a.ts", variable: "cpf", callEdges: [{ fromFilePath: "src/a.ts", fromLine: 2, toFilePath: "src/b.ts", toVariable: "input", status: "verified" }] });
  assert.ok(verified);
  assert.ok(verified.steps.some((step) => step.status === "verified" && step.expression.includes("verified call")));
  assert.ok(verified.steps.some((step) => step.locator.filePath === "src/b.ts"));
  const candidate = traceVerifiedInterproceduralFlow(store, { snapshotId: snapshot.id, filePath: "src/a.ts", variable: "cpf", callEdges: [{ fromFilePath: "src/a.ts", fromLine: 2, toFilePath: "src/b.ts", toVariable: "input", status: "candidate" }] });
  assert.ok(candidate.gaps.some((gap) => gap.includes("unverified inter-procedural")));
  assert.equal(candidate.steps.some((step) => step.locator.filePath === "src/b.ts"), false);
  store.close();
});

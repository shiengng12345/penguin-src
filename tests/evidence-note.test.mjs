import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, search } from "../packages/knowledge-core/dist/index.js";
import { upsertEvidenceNote } from "../packages/knowledge-indexer/dist/evidence.js";
import { reindexNotesDir } from "../packages/knowledge-indexer/dist/notes-fs.js";

function fixture(message = "unique-evidence-term") {
  const root = mkdtempSync(join(tmpdir(), "penguin-evidence-"));
  const notesDir = join(root, "notes");
  const store = KnowledgeStore.open({ dbPath: join(root, "knowledge.db"), ledgerPath: join(root, "ledger.jsonl") });
  const target = { targetId: "fpms-uat", environment: "uat", aliases: [], regionId: "ap-southeast-1", project: "platform-uat-aliyun-logs", logstore: "platform-fpms-uat", services: [], enabled: true, source: "config" };
  const packet = { target, topicHash: "topic-1", question: "why", result: { queryStatus: "success", rows: [], completedStepIds: [], pendingStepIds: [], attempts: 1, truncated: false, warnings: [], target }, codeFacts: [], wikiFacts: [], slsFacts: [{ claimId: "c1", statement: message, targetId: target.targetId, evidenceIds: ["ev1"] }], inferences: [], gaps: [], evidence: [{ evidenceId: "ev1", source: "sls", targetId: target.targetId }], observations: [{ observationId: "obs-1", targetId: target.targetId, sourceTimestamp: "2026-07-01T00:00:00Z", traceId: "trace-1", raw: { msg: message }, evidenceIds: ["ev1"] }] };
  return { root, notesDir, store, packet };
}

test("evidence note is typed, sensitive-allowed, searchable, idempotent, and appends changed observations", () => {
  const f = fixture();
  const first = upsertEvidenceNote({ store: f.store, notesDir: f.notesDir, packet: f.packet });
  assert.equal(first.status, "created");
  const source = readFileSync(first.path, "utf8");
  assert.match(source, /type: evidence/);
  assert.match(source, /sensitive: true/);
  assert.match(source, /mcp_access: allowed/);
  const same = upsertEvidenceNote({ store: f.store, notesDir: f.notesDir, packet: f.packet });
  assert.equal(same.status, "duplicate_observed");
  assert.equal(same.observationCount, 2);
  assert.equal((readFileSync(same.path, "utf8").match(/### Observation/g) ?? []).length, 1);
  const changedPacket = { ...f.packet, observations: [{ ...f.packet.observations[0], observationId: "obs-2", raw: { msg: "changed-evidence-term" } }], slsFacts: [{ ...f.packet.slsFacts[0], statement: "changed-evidence-term" }] };
  const changed = upsertEvidenceNote({ store: f.store, notesDir: f.notesDir, packet: changedPacket });
  assert.equal(changed.status, "updated");
  assert.equal((readFileSync(changed.path, "utf8").match(/### Observation/g) ?? []).length, 2);
  assert.equal(search(f.store, "changed-evidence-term", { includeSensitive: true }).length, 1);
  f.store.close();
});

test("Markdown evidence survives deleting SQLite and reindexing notes", () => {
  const f = fixture("rebuildable-evidence-term");
  const first = upsertEvidenceNote({ store: f.store, notesDir: f.notesDir, packet: f.packet });
  const dbPath = f.store.db.name;
  f.store.close();
  rmSync(dbPath, { force: true });
  const rebuilt = KnowledgeStore.open({ dbPath, ledgerPath: join(f.root, "ledger.jsonl") });
  reindexNotesDir({ store: rebuilt, notesDir: f.notesDir });
  assert.equal(search(rebuilt, "rebuildable-evidence-term", { includeSensitive: true }).length, 1);
  rebuilt.close();
});

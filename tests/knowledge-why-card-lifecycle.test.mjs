import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, SourceStore, WhyCardStore, createWhyCard } from "../packages/knowledge-core/dist/index.js";

function sha(value) { return createHash("sha256").update(value).digest("hex"); }

test("verified WHY cards become stale when their source evidence hash changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-why-lifecycle-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "fixture", rootPath: dir });
  const oldContent = "old source";
  const oldHash = sha(oldContent);
  const source = new SourceStore(store);
  const oldBlob = source.putBlob({ contentHash: oldHash, rawBytes: Buffer.from(oldContent), decodedContent: oldContent, encoding: "utf8" });
  source.putSourceFact({ repoId, filePath: "src/a.ts", factFingerprint: "old", contentHash: oldHash, sourceBlobId: oldBlob, coverage: { status: "admitted", reasonCode: "text_searchable", classification: "source" } });
  const card = createWhyCard({ subject: { nodeId: "node-a" }, question: "why", answer: "because", decision: "old", alternatives: [], constraints: [], consequences: [], evidence: [{ contentHash: oldHash }], gaps: [], owners: [] });
  const verified = { ...card, status: "verified" };
  new WhyCardStore(store).put(verified);
  const newContent = "new source";
  const newHash = sha(newContent);
  const newBlob = source.putBlob({ contentHash: newHash, rawBytes: Buffer.from(newContent), decodedContent: newContent, encoding: "utf8" });
  source.putSourceFact({ repoId, filePath: "src/a.ts", factFingerprint: "new", contentHash: newHash, sourceBlobId: newBlob, coverage: { status: "admitted", reasonCode: "text_searchable", classification: "source" } });
  assert.equal(new WhyCardStore(store).get(card.id).status, "stale");
  assert.ok(store.db.prepare("SELECT 1 FROM knowledge_audit_events WHERE capability_id='knowledge.why.stale'").get());
  store.close();
});

test("different reviewed WHY decisions for one subject become disputed instead of merging", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-why-conflict-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const why = new WhyCardStore(store);
  const first = createWhyCard({ subject: { nodeId: "same" }, question: "why", answer: "a", decision: "a", alternatives: [], constraints: [], consequences: [], evidence: [], gaps: [], owners: [] });
  why.put({ ...first, status: "reviewed" });
  const second = createWhyCard({ subject: { nodeId: "same" }, question: "why", answer: "b", decision: "b", alternatives: [], constraints: [], consequences: [], evidence: [], gaps: [], owners: [] });
  why.put({ ...second, status: "reviewed" });
  assert.equal(why.get(first.id).status, "disputed");
  assert.equal(why.get(second.id).status, "reviewed");
  store.close();
});

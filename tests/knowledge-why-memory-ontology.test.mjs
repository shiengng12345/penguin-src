import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, createWhyCard, transitionWhyCard, WhyCardStore, MemoryStore, OntologyStore, AuditStore, buildOnboarding, buildOnboardingDocument } from "../packages/knowledge-core/dist/index.js";

function store() { const dir = mkdtempSync(join(tmpdir(), "pk-why-")); return KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") }); }

test("WHY card state transitions preserve evidence boundary", () => {
  const card = createWhyCard({ subject: { nodeId: "n1" }, question: "why", answer: "observed", decision: "use guard", alternatives: [], constraints: [], consequences: [], evidence: [{ status: "verified" }], gaps: [], owners: [] });
  const reviewed = transitionWhyCard(card, "reviewed");
  assert.equal(transitionWhyCard(reviewed, "verified").status, "verified");
  assert.throws(() => transitionWhyCard(card, "verified"), /WHY_INVALID_TRANSITION/);
});

test("WHY store transitions are audited", () => {
  const db = store();
  const cards = new WhyCardStore(db);
  const card = createWhyCard({ subject: { nodeId: "n2" }, question: "why", answer: "answer", decision: "decision", alternatives: [], constraints: [], consequences: [], evidence: [{ status: "verified" }], gaps: [], owners: [] });
  cards.put(card);
  assert.equal(cards.transition(card.id, "reviewed", "reviewer").status, "reviewed");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM knowledge_audit_events WHERE capability_id='knowledge.why.transition'").get().n, 1);
  db.close();
});

test("memory, ontology and onboarding are scoped and persisted", () => {
  const db = store();
  const memory = new MemoryStore(db);
  const item = memory.remember({ class: "decision", scope: { repoId: "r1" }, subject: "guard", body: "keep guard", source: [{ locator: "a.ts:1" }], confidence: 0.9, retention: "indefinite" });
  assert.equal(memory.recall({ repoId: "r1" })[0].id, item.id);
  memory.forget(item.id);
  assert.equal(memory.recall({ repoId: "r1" }).length, 0);
  const terms = new OntologyStore(db);
  terms.upsert({ id: "term:cpf", canonicalName: "CPF", aliases: ["tax id"], scope: {}, type: "entity", definition: "synthetic identifier", evidence: [], status: "draft" });
  assert.equal(terms.list()[0].aliases[0], "tax id");
  assert.match(buildOnboarding(db), /系统边界/);
  const onboarding = buildOnboardingDocument(db);
  assert.match(onboarding.markdown, /revision-hash=[a-f0-9]{64}/);
  assert.match(onboarding.markdown, /capability-hash=[a-f0-9]{64}/);
  assert.equal(onboarding.capabilityHash.length, 64);
  db.close();
});

test("ontology alias conflicts return candidates and expansion is non-proof ranking only", () => {
  const db = store();
  const terms = new OntologyStore(db);
  const first = { id: "term:cpf", canonicalName: "CPF", aliases: ["tax id"], scope: {}, type: "entity", definition: "synthetic identifier", evidence: [], status: "draft" };
  assert.equal(terms.upsert(first).status, "unique");
  const conflict = terms.upsert({ ...first, id: "term:tax-id", canonicalName: "Tax Identifier", aliases: ["tax id"], type: "capability" });
  assert.equal(conflict.status, "ambiguous");
  assert.equal(conflict.candidates.length, 1);
  assert.equal(terms.resolveAlias("tax id").status, "unique");
  const expansion = terms.expansion("tax id");
  assert.deepEqual(expansion.terms, ["CPF"]);
  assert.equal(expansion.boost, 0.04);
  assert.deepEqual(terms.expansion("does-not-exist"), { terms: [], boost: 0, ambiguous: [] });
  db.close();
});

test("session memory gets a bounded TTL while decisions remain durable by default", () => {
  const db = store();
  const memory = new MemoryStore(db);
  const session = memory.remember({ class: "session", scope: { workspaceId: "w" }, subject: "session", body: "temporary", source: [], confidence: 1, retention: "ephemeral" });
  const decision = memory.remember({ class: "decision", scope: { workspaceId: "w" }, subject: "decision", body: "durable", source: [], confidence: 1, retention: "indefinite" });
  assert.ok(session.expiresAt);
  assert.equal(decision.expiresAt, undefined);
  assert.equal(memory.promote(session.id).expiresAt, undefined);
  db.close();
});

test("repo-scoped memory does not cross workspace boundaries and revision drift marks source-backed memory stale", () => {
  const db = store();
  const memory = new MemoryStore(db);
  const item = memory.remember({ class: "decision", scope: { workspaceId: "w1", repoId: "r1" }, subject: "boundary", body: "body", source: [{ revisionId: "rev-old" }], confidence: 1, retention: "indefinite" });
  assert.equal(memory.recall({ workspaceId: "w2", repoId: "r1" }).length, 0);
  assert.equal(memory.markStaleByRevision("rev-old"), 1);
  assert.equal(memory.recall({ workspaceId: "w1", repoId: "r1" }).length, 0);
  assert.equal(item.scope.repoId, "r1");
  db.close();
});

test("local identity is audit metadata, not indexed memory or secret content", () => {
  const db = store();
  const memory = new MemoryStore(db);
  memory.remember({ class: "session", scope: { workspaceId: "w1" }, subject: "local session", body: "temporary context", source: [], confidence: 1, retention: "ephemeral" });
  new AuditStore(db).append({ capabilityId: "knowledge.memory.remember", actorId: "local-user", scopeHash: "scope", input: { personalSecret: "must-not-be-stored" }, resultCode: "completed" });
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE body LIKE '%must-not-be-stored%'").get().n, 0);
  const audit = db.db.prepare("SELECT actor_id AS actorId,input_digest AS inputDigest FROM knowledge_audit_events").get();
  assert.equal(audit.actorId, "local-user");
  assert.equal(audit.inputDigest.includes("must-not-be-stored"), false);
  db.close();
});

test("forget removes memory body without placing recoverable content in audit", () => {
  const db = store();
  const memory = new MemoryStore(db);
  const item = memory.remember({ class: "decision", scope: {}, subject: "forget", body: "private decision text", source: [], confidence: 1, retention: "indefinite" });
  memory.forget(item.id);
  assert.equal(db.db.prepare("SELECT body FROM memory_items WHERE id=?").get(item.id).body, "");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM knowledge_audit_events WHERE input_digest LIKE '%private decision text%'").get().n, 0);
  db.close();
});

test("same ontology alias can be scoped to different repositories without string-merging", () => {
  const db = store();
  const terms = new OntologyStore(db);
  assert.equal(terms.upsert({ id: "term:r1", canonicalName: "Order", aliases: ["ticket"], scope: { repoIds: ["r1"] }, type: "entity", definition: "r1", evidence: [], status: "draft" }).status, "unique");
  assert.equal(terms.upsert({ id: "term:r2", canonicalName: "Order", aliases: ["ticket"], scope: { repoIds: ["r2"] }, type: "entity", definition: "r2", evidence: [], status: "draft" }).status, "unique");
  assert.equal(terms.resolveAlias("ticket", { repoIds: ["r1"] }).status, "unique");
  assert.equal(terms.resolveAlias("ticket", { repoIds: ["r2"] }).status, "unique");
  assert.equal(terms.resolveAlias("ticket").status, "ambiguous");
  db.close();
});

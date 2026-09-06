import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GitTopologyStore,
  KnowledgeStore,
  SourceSnapshotStore,
  SourceStore,
  parseKnowledgeQuery,
  planSearch,
  searchKnowledge,
} from "../packages/knowledge-core/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pk-round18-search-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "FPMS-NT", rootPath: dir });
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: "round18", repoId, parserVersion: "p", resolverVersion: "r", schemaVersion: 17 });
  const branchId = store.registerBranch({ repoId, name: "brazil-v2", status: "live" });
  store.db.prepare("UPDATE branches SET current_snapshot_id=?,last_indexed_commit=? WHERE id=?").run(snapshot.id, "round18-commit", branchId);

  const files = [
    {
      path: "apps/payment/src/payment/withdrawal/checks/handlers/balance.check.ts",
      content: "export class BalanceCheckHandler {\n  handle() { return true; }\n}\n",
      symbol: { title: "BalanceCheckHandler", kind: "class" },
    },
    {
      path: "apps/payment/src/payment/withdrawal/checks/withdrawal-check.service.ts",
      content: "export class WithdrawalCheckService {\n  runChecks() {\n    return 'withdrawal payout approval decision';\n  }\n}\n",
      symbol: { title: "WithdrawalCheckService", kind: "class" },
    },
    {
      path: "README.md",
      content: [
        "withdrawal overview",
        ...Array(8).fill("unrelated documentation"),
        "payout overview",
        ...Array(8).fill("unrelated documentation"),
        "approval overview",
        ...Array(8).fill("unrelated documentation"),
        "decision overview",
      ].join("\n"),
      symbol: { title: "ReadmeTerms", kind: "document" },
    },
  ];
  const source = new SourceStore(store);
  const overlay = [];
  for (const file of files) {
    const raw = Buffer.from(file.content, "utf8");
    const contentHash = createHash("sha256").update(raw).digest("hex");
    const blobId = source.putBlob({ contentHash, rawBytes: raw, decodedContent: file.content, encoding: "utf8" });
    const sourceFactId = source.putSourceFact({ repoId, filePath: file.path, factFingerprint: contentHash, contentHash, sourceBlobId: blobId, coverage: { status: "admitted", reasonCode: "text_searchable", classification: "source" } });
    overlay.push({ op: "add", path: file.path, sourceFactId });
    store.db.prepare("INSERT INTO coverage_records(repo_id,file_path,git_state,coverage_status,reason_code,classification,byte_size,reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(repoId, file.path, "tracked", "admitted", "text_searchable", "source", raw.length, "ok", new Date().toISOString());
    const nodeId = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::${file.path}::${file.symbol.title}`, repoId, title: file.symbol.title });
    store.indexSymbolText({ nodeId, name: file.symbol.title, signature: `class ${file.symbol.title}` });
    store.upsertSymbolVersion({ nodeId, branchId, commitSha: "round18-commit", filePath: file.path, lang: "typescript", kind: file.symbol.kind, startLine: 1, endLine: 5, contentHash, status: "fresh" });
    file.nodeId = nodeId;
  }
  const snapshots = new SourceSnapshotStore(store);
  snapshots.replaceOverlay(snapshot.id, overlay);
  snapshots.materializeManifest(snapshot.id);
  return { store, repoId, snapshot, files };
}

function scope(repoId, snapshotId) {
  return { revisions: [{ repoId, snapshotId }] };
}

test("Round 18 exact identifier returns the real symbol identity at rank 1", () => {
  const { store, repoId, snapshot, files } = fixture();
  try {
    const response = searchKnowledge({ query: "BalanceCheckHandler", mode: "exact", scope: scope(repoId, snapshot.id), page: { limit: 10 } }, { store, scopes: [{ repoId, snapshotId: snapshot.id }], cursorSecret: "round18-secret" });
    assert.equal(response.hits[0].lane, "symbol", JSON.stringify(response.hits.slice(0, 3)));
    assert.equal(response.hits[0].nodeId, files[0].nodeId);
    assert.equal(response.hits[0].locator.nodeId, files[0].nodeId);
    assert.match(response.hits[0].rankReasons.find((reason) => reason.startsWith("rank_tuple=")) ?? "", /^rank_tuple=1\//);
  } finally {
    store.close();
  }
});

test("Round 18 path-qualified identifier resolves the same node as the bare identifier", () => {
  const { store, repoId, snapshot, files } = fixture();
  try {
    const request = { query: "apps/payment/src/payment/withdrawal/checks/handlers/balance.check.ts:BalanceCheckHandler", scope: scope(repoId, snapshot.id), page: { limit: 10 } };
    const parsed = parseKnowledgeQuery(request);
    assert.equal(parsed.intent, "path_qualified");
    assert.equal(parsed.path, "apps/payment/src/payment/withdrawal/checks/handlers/balance.check.ts");
    assert.equal(parsed.identifier, "BalanceCheckHandler");
    assert.deepEqual(planSearch(request).stages.map((stage) => stage.lane), ["path", "source", "symbol"]);
    const response = searchKnowledge(request, { store, scopes: [{ repoId, snapshotId: snapshot.id }], cursorSecret: "round18-secret" });
    assert.equal(response.hits[0].nodeId, files[0].nodeId, JSON.stringify(response.hits.slice(0, 3)));
    assert.equal(response.hits[0].locator.filePath, parsed.path);
  } finally {
    store.close();
  }
});

test("Round 18 business-intent search tokenizes terms and stays under the withdrawal path", () => {
  const { store, repoId, snapshot } = fixture();
  try {
    const response = searchKnowledge({ query: "withdrawal payout approval decision", scope: scope(repoId, snapshot.id), page: { limit: 10 } }, { store, scopes: [{ repoId, snapshotId: snapshot.id }], cursorSecret: "round18-secret" });
    assert.ok(response.hits.length > 0, JSON.stringify(response));
    assert.ok(response.hits.some((hit) => hit.locator.filePath.startsWith("apps/payment/src/payment/withdrawal/")), JSON.stringify(response.hits));
    assert.equal(response.hits[0].locator.filePath, "apps/payment/src/payment/withdrawal/checks/withdrawal-check.service.ts", JSON.stringify(response.hits.slice(0, 5)));
    assert.ok(response.hits.filter((hit) => hit.locator.filePath === "README.md").length <= 1, JSON.stringify(response.hits));
    assert.ok(response.diagnostics.searchedLanes.includes("source"));
    assert.ok(response.hits.some((hit) => hit.rankReasons.some((reason) => reason === "business intent term coverage=4/4")));
  } finally {
    store.close();
  }
});

test("search cursor fingerprint rejects a cursor created for a different parsed query", () => {
  const { store, repoId, snapshot } = fixture();
  try {
    const first = searchKnowledge({ query: "withdrawal", page: { limit: 1 }, scope: scope(repoId, snapshot.id) }, { store, scopes: [{ repoId, snapshotId: snapshot.id }], cursorSecret: "round18-secret" });
    assert.equal(typeof first.page.nextCursor, "string");
    assert.throws(() => searchKnowledge({ query: "withdrawal payout", page: { limit: 1, cursor: first.page.nextCursor }, scope: scope(repoId, snapshot.id) }, { store, scopes: [{ repoId, snapshotId: snapshot.id }], cursorSecret: "round18-secret" }), /CURSOR_STALE/);
  } finally {
    store.close();
  }
});

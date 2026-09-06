import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, buildDomainFlow } from "../packages/knowledge-core/dist/index.js";

test("domain flow deduplicates repeated graph rows before rendering", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-domain-dedup-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const now = new Date().toISOString();
  store.db.prepare("INSERT INTO nodes(id,node_type,identity_key,repo_id,title,meta,created_at) VALUES (?,?,?,?,?,?,?)")
    .run("domain:login", "endpoint", "domain:login", null, "Login", "{}", now);
  store.db.prepare("INSERT INTO nodes(id,node_type,identity_key,repo_id,title,meta,created_at) VALUES (?,?,?,?,?,?,?)")
    .run("domain:auth", "service", "domain:auth", null, "AuthService", "{}", now);
  for (const id of ["duplicate-a", "duplicate-b"]) {
    store.db.prepare("INSERT INTO edges(id,src,dst,edge_type,origin,method,status,provenance) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, "domain:login", "domain:auth", "invokes", "parser", "fixture", "active", JSON.stringify({ filePath: "src/login.ts", startLine: 1 }));
  }
  const flow = buildDomainFlow(store, { target: "Login", limit: 20 });
  assert.equal(flow.length, 1);
  assert.equal(flow[0].from, "Login");
  assert.equal(flow[0].to, "AuthService");
  assert.equal(flow[0].duplicateCount, 1);
  store.close();
});

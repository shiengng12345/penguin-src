import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, buildDomainClaims, buildDomainFlow } from "../packages/knowledge-core/dist/index.js";

test("domain model emits candidate claims with source evidence and persona filtering", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-domain-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  store.db.prepare("INSERT INTO nodes(id,node_type,identity_key,repo_id,title,meta,created_at) VALUES (?,?,?,?,?,?,?)").run("endpoint:login", "endpoint", "login", null, "Login", "{}", new Date().toISOString());
  store.db.prepare("INSERT INTO nodes(id,node_type,identity_key,repo_id,title,meta,created_at) VALUES (?,?,?,?,?,?,?)").run("service:auth", "service", "auth", null, "AuthService", "{}", new Date().toISOString());
  store.db.prepare("INSERT INTO edges(id,src,dst,edge_type,origin,method,status) VALUES (?,?,?,?,?,?,?)").run("edge:login-auth", "endpoint:login", "service:auth", "invokes", "test", "fixture", "active");
  const all = buildDomainClaims(store);
  assert.equal(all.length, 2);
  assert.ok(all.every((claim) => claim.status === "candidate" && claim.evidence[0].nodeId));
  assert.ok(buildDomainClaims(store, { persona: "frontend" }).length > 0);
  assert.equal(buildDomainFlow(store, { target: "Login" })[0].to, "AuthService");
  assert.ok(buildDomainFlow(store, { target: "Login" })[0].evidence[0].nodeId);
  store.close();
});

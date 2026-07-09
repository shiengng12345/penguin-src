import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, endpointSamples } from "../packages/knowledge-core/dist/index.js";

function store() {
  const dir = mkdtempSync(join(tmpdir(), "pk-rs-"));
  return KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
}

test("response sample is recorded via ledger and read back", () => {
  const s = store();
  const repoId = s.registerRepo({ name: "svc", rootPath: "/svc" });
  const ep = s.upsertNode({ nodeType: "endpoint", identityKey: "svc::endpoint::GET /users", title: "GET /users", repoId });
  s.recordKnowledge({
    type: "response_sample_captured", origin: "user", method: "ASSERTED",
    actor: { type: "user", id: "t" }, target: { node_id: ep },
    payload: { endpoint_id: ep, endpoint_key: "GET /users", status: "200", content_type: "application/json", sample: '{"ok":true}' },
  });
  const rows = endpointSamples(s, "GET /users");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "200");
  assert.equal(rows[0].sample, '{"ok":true}');
  s.close();
});

test("response samples survive a rebuild-from-ledger (not parser-derived)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-rs2-"));
  const paths = { dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") };
  let s = KnowledgeStore.open(paths);
  const repoId = s.registerRepo({ name: "svc", rootPath: "/svc" });
  const ep = s.upsertNode({ nodeType: "endpoint", identityKey: "svc::endpoint::x", title: "x", repoId });
  s.recordKnowledge({
    type: "response_sample_captured", origin: "user", method: "ASSERTED",
    actor: { type: "user", id: "t" }, target: { node_id: ep },
    payload: { endpoint_id: ep, endpoint_key: "x", status: "200", content_type: null, sample: "hi" },
  });
  s.close();
  // Reopen (replays the ledger into a fresh materialized state).
  s = KnowledgeStore.open(paths);
  assert.equal(endpointSamples(s, "x").length, 1);
  s.close();
});

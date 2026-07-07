import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Ledger,
  materialize,
  openDatabase,
} from "../packages/knowledge-core/dist/index.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "pk-mat-"));
}

function setup() {
  const dir = tempDir();
  const db = openDatabase(join(dir, "knowledge.db"));
  const { ledger } = Ledger.open(join(dir, "ledger.jsonl"));
  db.prepare(
    "INSERT INTO nodes (id, node_type, identity_key, title, created_at) VALUES ('node_a','symbol','repo:UserService.login','UserService.login','2026-07-07T00:00:00Z')",
  ).run();
  db.prepare(
    "INSERT INTO nodes (id, node_type, identity_key, title, created_at) VALUES ('node_b','note','cases/demo.md','Demo Case','2026-07-07T00:00:00Z')",
  ).run();
  return { db, ledger };
}

const ALIAS_EVENT = {
  type: "node_alias_added",
  origin: "system",
  method: "EXTRACTED",
  actor: { type: "system", id: "knowledge-indexer" },
  target: { node_id: "node_a" },
  payload: {
    alias_key: "repo:UserService.signIn",
    alias_type: "qualified_name",
    reason: "rename",
    confidence: 1.0,
  },
  provenance: { file: "src/auth/user.service.ts", commit: "abc123" },
};

const EDGE_EVENT = {
  type: "manual_edge_created",
  origin: "user",
  method: "ASSERTED",
  actor: { type: "user", id: "shieng" },
  target: { node_id: "node_b" },
  payload: { src: "node_b", dst: "node_a", edge_type: "wikilink" },
  provenance: {},
};

test("materialize applies alias + edge events and advances ledger_state", () => {
  const { db, ledger } = setup();
  const e1 = ledger.append(ALIAS_EVENT, () => "2026-07-07T10:00:00.000Z");
  const e2 = ledger.append(EDGE_EVENT, () => "2026-07-07T10:00:01.000Z");

  const { applied } = materialize(db, [e1, e2]);
  assert.equal(applied, 2);

  const alias = db
    .prepare("SELECT * FROM node_aliases WHERE node_id = 'node_a'")
    .get();
  assert.equal(alias.alias_key, "repo:UserService.signIn");
  assert.equal(alias.current_identity_key, "repo:UserService.login");
  assert.equal(alias.id, `alias_${e1.id}`);

  const edge = db.prepare("SELECT * FROM edges WHERE src = 'node_b'").get();
  assert.equal(edge.dst, "node_a");
  assert.equal(edge.origin, "user");
  assert.equal(edge.method, "ASSERTED");
  assert.equal(edge.id, `edge_${e2.id}`);

  const evRows = db.prepare("SELECT * FROM events ORDER BY ledger_seq").all();
  assert.equal(evRows.length, 2);
  assert.equal(evRows[0].origin, "system");
  assert.equal(evRows[0].method, "EXTRACTED");

  const state = db.prepare("SELECT * FROM ledger_state WHERE id='main'").get();
  assert.equal(state.materialized_seq, 2);
  db.close();
});

test("materialize is resumable — already-applied events are skipped", () => {
  const { db, ledger } = setup();
  const e1 = ledger.append(ALIAS_EVENT, () => "2026-07-07T10:00:00.000Z");
  materialize(db, [e1]);
  const e2 = ledger.append(EDGE_EVENT, () => "2026-07-07T10:00:01.000Z");

  const { applied } = materialize(db, [e1, e2]); // 全量传入，只应 1 条
  assert.equal(applied, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM events").get().n,
    2,
  );
  db.close();
});

test("alias_merge_undone sets valid_to on the alias", () => {
  const { db, ledger } = setup();
  const e1 = ledger.append(ALIAS_EVENT, () => "2026-07-07T10:00:00.000Z");
  const undo = ledger.append(
    {
      type: "alias_merge_undone",
      origin: "user",
      method: "ASSERTED",
      actor: { type: "user", id: "shieng" },
      target: { node_id: "node_a" },
      payload: {
        alias_key: "repo:UserService.signIn",
        alias_type: "qualified_name",
      },
      provenance: {},
    },
    () => "2026-07-07T11:00:00.000Z",
  );
  materialize(db, [e1, undo]);
  const alias = db
    .prepare("SELECT * FROM node_aliases WHERE node_id='node_a'")
    .get();
  assert.equal(alias.valid_to, "2026-07-07T11:00:00.000Z");
  db.close();
});

test("unknown event types land in events table only", () => {
  const { db, ledger } = setup();
  const e = ledger.append(
    {
      type: "snapshot_manifest_created",
      origin: "user",
      method: "ASSERTED",
      actor: { type: "user", id: "shieng" },
      payload: { name: "incident-42" },
      provenance: {},
    },
    () => "2026-07-07T10:00:00.000Z",
  );
  const { applied } = materialize(db, [e]);
  assert.equal(applied, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
  db.close();
});

// tests/pipeline-second-pass.test.mjs
// Forward references must survive a single indexRepo run. Single-pass
// resolution sees only symbols indexed BEFORE the current file, so a.ts
// calling a symbol defined in z.ts (walked later) silently dropped the edge —
// a fresh rebuild under-linked vs a converged incremental DB (audit finding:
// fresh rebuild lost ~25% calls / ~42% references fleet-wide).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexRepo } from "../packages/knowledge-indexer/dist/pipeline.js";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-2p-"));
  return KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
}

test("forward reference (caller file walked before definer) links in ONE indexRepo run", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pk-2p-src-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  // Walk order is directory order: a_caller.ts is processed BEFORE z_target.ts,
  // so at its resolution time zTargetHelper has zero candidates in the table.
  writeFileSync(
    join(repo, "src", "a_caller.ts"),
    `import { zTargetHelper } from "./z_target.js";
export function forwardCaller() { return zTargetHelper() + 1; }
`,
  );
  writeFileSync(
    join(repo, "src", "z_target.ts"),
    `export function zTargetHelper() { return 41; }
`,
  );
  const store = openStore();
  await indexRepo({ store, rootPath: repo, mode: "incremental" });

  const edge = store.db
    .prepare(
      `SELECT e.id FROM edges e
       JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
       WHERE e.edge_type = 'calls' AND e.status = 'active'
         AND s.title = 'forwardCaller' AND d.title = 'zTargetHelper'`,
    )
    .all();
  assert.ok(edge.length >= 1, "calls edge forwardCaller → zTargetHelper exists after one run");
  store.close();
});

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
  const report = await indexRepo({ store, rootPath: repo, mode: "incremental" });

  const edge = store.db
    .prepare(
      `SELECT e.id FROM edges e
       JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
       WHERE e.edge_type = 'calls' AND e.status = 'active'
         AND s.title = 'forwardCaller' AND d.title = 'zTargetHelper'`,
    )
    .all();
  assert.ok(edge.length >= 1, "calls edge forwardCaller → zTargetHelper exists after one run");
  const publishedEdgeSets = Object.values(report.timings.parse.edgeSets)
    .reduce((total, count) => total + count, 0);
  assert.equal(report.timings.parse.secondPasses, 1, "the internal forward reference is re-linked once");
  assert.equal(publishedEdgeSets, 2, "each parsed file publishes one final edge set");
  store.close();
});

test("rebuild does not run a second parse for names that remain external", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pk-2p-external-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "src", "external.ts"),
    `export function usesExternal() { return externalSdkCall(); }
`,
  );
  const store = openStore();
  const report = await indexRepo({ store, rootPath: repo, mode: "rebuild" });

  assert.equal(
    report.timings.parse.secondPasses,
    0,
    "an unresolved external name cannot become a forward reference later in the same rebuild",
  );
  const defines = store.db.prepare(
    `SELECT COUNT(*) AS count FROM edges WHERE edge_type='defines' AND status='active'`,
  ).get();
  assert.ok(defines.count >= 1, "first-pass structural edges remain published");
  store.close();
});

test("external member calls do not retry when an unrelated same-name symbol appears later", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pk-2p-member-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "src", "a_external.ts"),
    `export function usesExternalSdk(sdk) { return sdk.sign("payload"); }
`,
  );
  writeFileSync(
    join(repo, "src", "z_unrelated.ts"),
    `export function sign(value) { return value; }
`,
  );
  const store = openStore();
  const report = await indexRepo({ store, rootPath: repo, mode: "rebuild" });

  assert.equal(
    report.timings.parse.secondPasses,
    0,
    "an external member call must not be promoted to a forward reference by an unrelated later symbol",
  );
  const wrongEdge = store.db.prepare(
    `SELECT COUNT(*) AS count FROM edges e
     JOIN nodes s ON s.id=e.src JOIN nodes d ON d.id=e.dst
     WHERE e.edge_type='calls' AND e.status='active'
       AND s.title='usesExternalSdk' AND d.title='sign'`,
  ).get();
  assert.equal(wrongEdge.count, 0, "external sdk.sign must not bind to the unrelated repository helper");
  store.close();
});

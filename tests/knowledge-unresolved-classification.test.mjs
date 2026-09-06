import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { KnowledgeStore, listCoverageDebt } from "../packages/knowledge-core/dist/index.js";
import { classifyUnresolvedReference } from "../packages/knowledge-indexer/dist/index.js";

const EXPECTED = new Set([
  "external_dependency",
  "language_builtin",
  "dynamic_dispatch",
  "generated_code",
  "no_enclosing_symbol",
  "ambiguous_internal",
  "missing_internal",
]);

test("[unresolved-reference-classification] every unresolved reason maps to the frozen seven-class taxonomy and remains queryable", () => {
  const cases = [
    ["external_package", "src/client.ts", "external_dependency"],
    ["platform_member", "src/runtime.ts", "language_builtin"],
    ["rust_dynamic_dispatch", "src/service.rs", "dynamic_dispatch"],
    ["no_candidate", "src/generated/client.pb.ts", "generated_code"],
    ["no_enclosing_symbol", "src/free.ts", "no_enclosing_symbol"],
    ["ambiguous_candidates", "src/service.ts", "ambiguous_internal"],
    ["no_candidate", "src/service.ts", "missing_internal"],
  ];
  assert.deepEqual(new Set(cases.map(([reason, path]) => classifyUnresolvedReference(reason, path))), EXPECTED);

  const directory = mkdtempSync(join(tmpdir(), "penguin-unresolved-classification-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  try {
    const repoId = store.registerRepo({ name: "classification", rootPath: join(directory, "repo") });
    const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
    const insert = store.db.prepare(`INSERT INTO unresolved_reference_items
      (id,repo_id,branch_id,revision_id,file_path,start_line,source_node_id,raw_target,reason_code,classification,reason,created_at)
      VALUES (?,?,?,?,?,1,NULL,?,?,?,?,?)`);
    cases.forEach(([reasonCode, filePath, classification], index) => insert.run(
      `u-${index}`, repoId, branchId, "snapshot-1", filePath, `Target${index}`, reasonCode, classification, "classified abstention", new Date().toISOString(),
    ));
    store.db.prepare(`INSERT INTO unresolved_reference_coverage
      (repo_id,branch_id,file_path,revision_id,resolved,total,updated_at) VALUES (?,?,?,?,0,?,?)`)
      .run(repoId, branchId, "src/all", "snapshot-1", cases.length, new Date().toISOString());
    const result = listCoverageDebt(store, { repo: repoId, kind: "unresolved", limit: 100 });
    assert.equal(result.items.length, cases.length);
    assert.equal(result.items.every((item) => EXPECTED.has(item.classification)), true);
    assert.equal(result.items.every((item) => item.rawTarget && item.reasonCode), true, "classification must preserve raw evidence");
    assert.equal(result.nextCursor, null);
  } finally {
    store.close();
  }
});

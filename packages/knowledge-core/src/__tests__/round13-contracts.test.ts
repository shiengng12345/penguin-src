import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  KnowledgeStore,
  affectedByNode,
  deadCode,
  resolveGrpcEndpoint,
} from "../index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-round13-core-"));
  const store = KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
  const repoId = store.registerRepo({ name: "round13-core", rootPath: dir });
  const branchId = store.registerBranch({
    repoId,
    name: "main",
    headCommit: "round13-contract-commit",
    status: "live",
  });
  store.db
    .prepare("UPDATE branches SET last_indexed_commit=? WHERE id=?")
    .run("round13-contract-commit", branchId);

  const node = (title: string, filePath: string) => {
    const nodeId = store.upsertNode({
      nodeType: "symbol",
      identityKey: `${repoId}::${title}`,
      title,
      repoId,
    });
    store.upsertSymbolVersion({
      nodeId,
      branchId,
      commitSha: "round13-contract-commit",
      filePath,
      lang: "typescript",
      kind: "function",
      signature: `${title}()`,
      contentHash: `round13-${title}`,
      status: "fresh",
    });
    return nodeId;
  };

  const target = node("round13Target", "src/target.ts");
  const caller = node("round13Caller", "src/caller.ts");
  const entry = node("round13Entry", "src/entry.ts");
  const orphans = [
    node("round13OrphanA", "src/orphan-a.ts"),
    node("round13OrphanB", "src/orphan-b.ts"),
    node("round13OrphanC", "src/orphan-c.ts"),
  ];
  const endpoint = store.upsertNode({
    nodeType: "endpoint",
    identityKey: "grpc::Round13Service.getThing",
    title: "gRPC Round13Service.getThing",
    repoId,
  });

  store.replaceFileEdges({
    branchId,
    filePath: "src/caller.ts",
    edges: [{ src: caller, dst: target, edgeType: "calls", origin: "parser", method: "EXTRACTED" }],
  });
  store.replaceFileEdges({
    branchId,
    filePath: "src/entry.ts",
    edges: [{ src: entry, dst: caller, edgeType: "calls", origin: "parser", method: "EXTRACTED" }],
  });
  store.replaceFileEdges({
    branchId,
    filePath: "src/endpoint.ts",
    edges: [{ src: endpoint, dst: caller, edgeType: "handles", origin: "parser", method: "EXTRACTED" }],
  });

  return { store, repoId, branchId, target, caller, endpoint, orphans };
}

test("affected node:<id> is a node contract, not a file-path contract", () => {
  const { store, target, caller } = fixture();
  const result = affectedByNode(store, `node:${target}`);

  assert.ok(result);
  assert.ok(result.target);
  assert.equal(result.target.nodeId, target);
  assert.deepEqual(result.files, ["src/target.ts"]);
  assert.ok(result.impacted.some((item) => item.nodeId === caller));
  assert.ok(!result.files.some((file) => file.startsWith("node:")));
  store.close();
});

test("canonical gRPC identity resolves to the same endpoint node", () => {
  const { store, endpoint } = fixture();
  const result = resolveGrpcEndpoint(store, "grpc::Round13Service.getThing");

  assert.deepEqual(result, { kind: "unique", nodeId: endpoint });
  store.close();
});

test("deadcode continuation reaches a truthful terminal page", () => {
  const { store, orphans } = fixture();
  const seen = new Set<string>();
  let after: { filePath: string; startLine: number; nodeId: string } | undefined;
  let terminal = false;

  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const page = deadCode(store, {
      repo: "round13-core",
      limit: 1,
      ...(after ? { after } : {}),
    });
    assert.equal(page.totalIsExact, true);
    for (const candidate of page.candidates) {
      assert.equal(seen.has(candidate.nodeId), false, `duplicate deadcode candidate ${candidate.nodeId}`);
      seen.add(candidate.nodeId);
    }
    if (!page.truncated) {
      terminal = true;
      break;
    }
    const last = page.candidates.at(-1);
    assert.ok(last, "a truncated page must return a candidate for continuation");
    after = {
      filePath: last.filePath ?? "",
      startLine: last.startLine ?? -1,
      nodeId: last.nodeId,
    };
  }

  assert.equal(terminal, true);
  for (const orphan of orphans) assert.ok(seen.has(orphan), `missing orphan ${orphan}`);
  store.close();
});

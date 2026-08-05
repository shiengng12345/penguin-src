import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, buildFlow, buildContextPack } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

import { resolveRevisionContext } from "../packages/knowledge-core/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-fallback-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const rootPath = join(dir, "repo");
  const repoId = store.registerRepo({ name: "demo", rootPath });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: "sha", status: "live" });
  const a = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::A`, repoId, title: "A" });
  const b = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::B`, repoId, title: "B" });
  store.upsertSymbolVersion({ nodeId: a, branchId, commitSha: "sha", filePath: "src/a.ts", lang: "typescript", kind: "function", signature: "A()", contentHash: "ha" });
  store.upsertSymbolVersion({ nodeId: b, branchId, commitSha: "sha", filePath: "src/b.ts", lang: "typescript", kind: "function", signature: "B()", contentHash: "hb" });
  store.indexSymbolText({ nodeId: a, name: "A", signature: "A()" });
  store.db.prepare("INSERT INTO edges (id, src, dst, edge_type, branch_id, origin, method, status) VALUES ('e1', ?, ?, 'calls', ?, 'parser', 'EXTRACTED', 'active')").run(a, b, branchId);
  return { store, repoId, a, branchId, rootPath };
}

// CliDeps.cwd is a plain string field (mirrors tests/knowledge-cli-scope.test.mjs's cliDeps()).
function cliDeps(store, cwd, lines) {
  return { openStore: () => store, storeExists: () => true, out: (l) => lines.push(l), err: (l) => lines.push(l), cwd };
}

test("buildFlow without a revision marks the live-branch fallback", () => {
  const { store, branchId } = fixture();
  const flow = buildFlow(store, "A");
  assert.deepEqual(flow.scopeFallback, { branchId });
  store.close();
});

test("buildFlow with an explicit revision does NOT mark fallback", () => {
  const { store, repoId } = fixture();
  const revision = resolveRevisionContext(store, { repoId, branch: "main" }).context;
  const flow = buildFlow(store, "A", { revision });
  assert.equal(flow.scopeFallback, undefined);
  store.close();
});

test("buildContextPack marks fallback the same way", () => {
  const { store, repoId, a, branchId } = fixture();
  const noRevision = buildContextPack(store, a);
  assert.deepEqual(noRevision.scopeFallback, { branchId });
  const revision = resolveRevisionContext(store, { repoId, branch: "main" }).context;
  assert.equal(buildContextPack(store, a, { revision }).scopeFallback, undefined);
  store.close();
});

// CLI emit() integration (Task 7's second half): the legacy graph verbs never
// resolve a scope at all (command-dispatch.ts's `default:` case calls
// exploreGraph() with no revision and emit()s with no ScopeEnvelope), so the
// FALLBACK_LIVE_BRANCH warning has to be spliced directly into the plain JSON
// payload rather than through the scope-envelope wrapper Task 6 built.
test("CLI: an unscoped legacy graph verb (callers) surfaces scopeFallback + a FALLBACK_LIVE_BRANCH warning", async () => {
  const { store, branchId, rootPath } = fixture();
  const lines = [];
  const code = await runCli(["callers", "B", "--json"], cliDeps(store, rootPath, lines));
  assert.equal(code, 0);
  const payload = JSON.parse(lines.at(-1));
  assert.deepEqual(payload.scopeFallback, { branchId });
  assert.equal(payload.locator, undefined); // no ScopeEnvelope for this verb — confirms the non-wrapper code path ran
  assert.ok(
    payload.warnings?.some((w) => w.code === "FALLBACK_LIVE_BRANCH"),
    `expected a FALLBACK_LIVE_BRANCH warning, got: ${JSON.stringify(payload.warnings)}`,
  );
  store.close();
});

// No double-fire: when the CLI's own scope resolution already answers with
// alignment "fallback" (Task 6's BRANCH_NOT_INDEXED_FALLBACK — reusing that
// fixture idiom from tests/knowledge-cli-scope.test.mjs), the resolved
// revision it hands to buildContextPack always carries a branchId, so the
// core-level scopeFallback never fires on top of it — emit()'s
// `scope?.alignment === "fallback"` guard exists for the (currently
// unreachable via any CLI verb) case where both fire together; this test
// locks the CLI-observable invariant either way: the two warning codes must
// never appear together in the same payload.
test("CLI: context resolved via BRANCH_NOT_INDEXED_FALLBACK does not also emit FALLBACK_LIVE_BRANCH", async () => {
  const { store, rootPath } = fixture();
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-b", "feature-x", rootPath]);
  execFileSync("git", ["-C", rootPath, "commit", "--allow-empty", "-m", "x"], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const lines = [];
  const code = await runCli(["context", "A", "--allow-fallback", "--json"], cliDeps(store, rootPath, lines));
  assert.equal(code, 0);
  const payload = JSON.parse(lines.at(-1));
  assert.equal(payload.alignment, "fallback");
  assert.ok(payload.warnings.some((w) => w.code === "BRANCH_NOT_INDEXED_FALLBACK"));
  assert.ok(!payload.warnings.some((w) => w.code === "FALLBACK_LIVE_BRANCH"));
  store.close();
});

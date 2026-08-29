import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";
import { isExternalPackageSpecifier, isTestFilePath } from "../packages/knowledge-indexer/dist/resolve.js";

// Reproduces the defect that put 797 of 8,992 call edges in a real React repo
// onto jest.mock stubs: `useSelector` is imported from react-redux, has no
// in-repo definition, and the resolver's unique-same-repo-hit tier bound it to
// the only same-named symbol — a mock factory inside a .test.tsx — at the
// highest confidence tier.

function fixtureRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "pk-ext-"));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
  const dir = mkdtempSync(join(tmpdir(), "pk-extdb-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  return { root, store };
}

function callEdges(store) {
  return store.db.prepare(`
    SELECT s.title AS src, d.title AS dst, dv.file_path AS dstFile
      FROM edges e
      JOIN nodes s ON s.id = e.src
      JOIN nodes d ON d.id = e.dst
      LEFT JOIN symbol_versions dv ON dv.node_id = d.id
     WHERE e.edge_type = 'calls' AND e.status = 'active'
  `).all();
}

test("specifier and test-path classification", () => {
  assert.equal(isExternalPackageSpecifier("react-redux"), true);
  assert.equal(isExternalPackageSpecifier("@scope/pkg"), true);
  assert.equal(isExternalPackageSpecifier("./local"), false);
  assert.equal(isExternalPackageSpecifier("../up"), false);
  assert.equal(isExternalPackageSpecifier("/abs"), false);
  assert.equal(isExternalPackageSpecifier("#internal"), false, "Node subpath imports stay in-package");

  assert.equal(isTestFilePath("src/a.test.tsx"), true);
  assert.equal(isTestFilePath("src/a.spec.ts"), true);
  assert.equal(isTestFilePath("src/__tests__/a.ts"), true);
  assert.equal(isTestFilePath("e2e/smoke.ts"), true);
  assert.equal(isTestFilePath("src/latest.ts"), false, "'latest' must not look like a test");
  assert.equal(isTestFilePath("src/contest/a.ts"), false, "'contest' must not look like a test");
  assert.equal(isTestFilePath(null), false);

  // A `tests/` directory is the convention in Rust, Python, Go and this repo.
  // Missing it let production Rust bind generic names like `text` to helpers in
  // crates/*/tests/ — 23 of the fake edges that survived the first fix.
  assert.equal(isTestFilePath("crates/o11y/tests/trace_id_pipeline.rs"), true);
  assert.equal(isTestFilePath("tests/test_api.py"), true);
  assert.equal(isTestFilePath("src/foo/tests.rs"), true, "Rust's in-crate tests module");
  assert.equal(isTestFilePath("pkg/server_test.go"), true, "Go's suffix convention");
  assert.equal(isTestFilePath("app/test_helpers.py"), true, "Python's prefix convention");
  assert.equal(isTestFilePath("crates/ccms-api/src/handler/public_popup/mod.rs"), false);

  // Whole-segment matching only: these are production paths that merely contain
  // the letters, and treating them as tests would drop real edges.
  assert.equal(isTestFilePath("src/contests/a.ts"), false);
  assert.equal(isTestFilePath("src/protests/x.rs"), false);
  assert.equal(isTestFilePath("src/testing/util.ts"), false, "'testing' is not 'tests'");
  assert.equal(isTestFilePath("src/attestation/verify.rs"), false);
});

test("a hook imported from an external package does not bind to a same-named mock", async () => {
  const { root, store } = fixtureRepo({
    "src/Widget.tsx": [
      "import { useSelector } from 'react-redux';",
      "export function Widget() { const v = useSelector((s) => s.v); return v; }",
    ].join("\n"),
    "src/Other.test.tsx": [
      "jest.mock('react-redux', () => ({",
      "  useSelector: () => ({}),",
      "}));",
      "export function useSelector() { return {}; }",
      "it('x', () => { expect(1).toBe(1); });",
    ].join("\n"),
  });
  await indexRepo({ store, rootPath: root });
  const edges = callEdges(store);
  const bad = edges.filter((e) => e.dst === "useSelector" && (e.dstFile ?? "").includes(".test."));
  assert.deepEqual(bad, [], `production code must not call into a test stub, got ${JSON.stringify(bad)}`);
  store.close();
});

test("a genuine in-repo import still resolves", async () => {
  // The guard must not cost real edges — this is the regression that matters.
  const { root, store } = fixtureRepo({
    "src/math.ts": "export function calculate(a) { return a * 2; }",
    "src/use.ts": [
      "import { calculate } from './math';",
      "export function run() { return calculate(2); }",
    ].join("\n"),
  });
  await indexRepo({ store, rootPath: root });
  const edges = callEdges(store);
  assert.ok(
    edges.some((e) => e.src === "run" && e.dst === "calculate"),
    `relative import must still resolve, got ${JSON.stringify(edges)}`,
  );
  store.close();
});

test("a test file calling a test helper still resolves", async () => {
  // The test-file guard only applies to PRODUCTION callers; the test graph
  // must survive intact.
  const { root, store } = fixtureRepo({
    "src/helpers/__tests__/factory.ts": "export function makeUser() { return { id: 1 }; }",
    "src/a.test.ts": [
      "import { makeUser } from './helpers/__tests__/factory';",
      "export function seed() { return makeUser(); }",
    ].join("\n"),
  });
  await indexRepo({ store, rootPath: root });
  const edges = callEdges(store);
  assert.ok(
    edges.some((e) => e.src === "seed" && e.dst === "makeUser"),
    `test-to-test-helper must resolve, got ${JSON.stringify(edges)}`,
  );
  store.close();
});

test("an aliased external import is also caught", async () => {
  const { root, store } = fixtureRepo({
    "src/Widget.tsx": [
      "import { useDispatch as dispatch } from 'react-redux';",
      "export function Widget() { return dispatch(); }",
    ].join("\n"),
    "src/Other.test.tsx": [
      "export function dispatch() { return 1; }",
      "it('x', () => { expect(1).toBe(1); });",
    ].join("\n"),
  });
  await indexRepo({ store, rootPath: root });
  const bad = callEdges(store).filter((e) => (e.dstFile ?? "").includes(".test."));
  assert.deepEqual(bad, [], `alias binding must be treated as external, got ${JSON.stringify(bad)}`);
  store.close();
});

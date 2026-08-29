import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  KnowledgeStore,
  buildContextPack,
  buildExplorePack,
} from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";

// Fixing the mock-binding defect made the resolver *abstain* on external calls,
// which traded a wrong answer for a silent gap: a function whose two most
// important calls go into an SDK now reports a short callee list with
// confidence "high". These tests pin the gap being visible instead.

function indexed(files) {
  const root = mkdtempSync(join(tmpdir(), "pk-extcall-"));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
  const dir = mkdtempSync(join(tmpdir(), "pk-extcalldb-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  return { root, store };
}

const WIDGET = {
  "src/widget.ts": [
    "import { proposalSDK } from '@fpms/proposal-sdk';",
    "import { useSelector } from 'react-redux';",
    "import { localHelper } from './helper';",
    "export function createProposal(id) {",
    "  const state = useSelector((s) => s.v);",
    "  const data = proposalSDK.getProposalData(id);",
    "  proposalSDK.submit(data);",
    "  return localHelper(state, data);",
    "}",
  ].join("\n"),
  "src/helper.ts": "export function localHelper(a, b) { return [a, b]; }",
};

test("external calls are recorded with callee, receiver, specifier and line", async () => {
  const { root, store } = indexed(WIDGET);
  await indexRepo({ store, rootPath: root });
  const rows = store.db
    .prepare("SELECT callee, receiver, specifier, line, reason FROM external_calls ORDER BY line")
    .all();
  const seen = rows.map((r) => `${r.receiver ? `${r.receiver}.` : ""}${r.callee}<-${r.specifier}`);
  assert.ok(seen.includes("useSelector<-react-redux"), `bare external call missing, got ${JSON.stringify(seen)}`);
  assert.ok(
    seen.includes("proposalSDK.getProposalData<-@fpms/proposal-sdk"),
    `member call on an external binding missing, got ${JSON.stringify(seen)}`,
  );
  assert.ok(
    seen.includes("proposalSDK.submit<-@fpms/proposal-sdk"),
    `every member call counts, not just the first, got ${JSON.stringify(seen)}`,
  );
  assert.ok(rows.every((r) => r.line > 0), "each fact carries the call site line");
  assert.ok(rows.every((r) => r.reason === "external-package"));
  store.close();
});

test("an in-repo call is not misfiled as external", async () => {
  const { root, store } = indexed(WIDGET);
  await indexRepo({ store, rootPath: root });
  const local = store.db.prepare("SELECT COUNT(*) AS n FROM external_calls WHERE callee='localHelper'").get();
  assert.equal(local.n, 0, "a resolved relative import must stay a real edge, not an external fact");
  const edges = store.db
    .prepare(
      `SELECT d.title AS dst FROM edges e JOIN nodes d ON d.id = e.dst
        WHERE e.edge_type='calls' AND e.status='active'`,
    )
    .all()
    .map((r) => r.dst);
  assert.ok(edges.includes("localHelper"), `the real edge must survive, got ${JSON.stringify(edges)}`);
  store.close();
});

test("a platform global is not treated as an external package call", async () => {
  const { root, store } = indexed({
    "src/clock.ts": "export function stamp() { return Date.now(); }",
  });
  await indexRepo({ store, rootPath: root });
  const rows = store.db.prepare("SELECT callee FROM external_calls").all();
  assert.deepEqual(rows, [], `Date.now has no import binding and must not be recorded, got ${JSON.stringify(rows)}`);
  store.close();
});

test("re-indexing a file replaces its external facts instead of duplicating them", async () => {
  const { root, store } = indexed(WIDGET);
  await indexRepo({ store, rootPath: root });
  const first = store.db.prepare("SELECT COUNT(*) AS n FROM external_calls").get().n;
  writeFileSync(join(root, "src/widget.ts"), `${WIDGET["src/widget.ts"]}\n// touched\n`);
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "touch"], { cwd: root });
  await indexRepo({ store, rootPath: root });
  const second = store.db.prepare("SELECT COUNT(*) AS n FROM external_calls").get().n;
  assert.equal(second, first, "stale rows from the previous version must be gone");
  store.close();
});

test("ContextPack groups external calls by package", async () => {
  const { root, store } = indexed(WIDGET);
  await indexRepo({ store, rootPath: root });
  const pack = buildContextPack(store, "createProposal");
  assert.ok(pack.focus, "focus must resolve");

  const specifiers = pack.externalCalls.map((g) => g.specifier);
  assert.deepEqual(
    specifiers,
    ["@fpms/proposal-sdk", "react-redux"],
    "one entry per package, sorted — not one per call site",
  );
  const sdk = pack.externalCalls.find((g) => g.specifier === "@fpms/proposal-sdk");
  assert.equal(sdk.callees.length, 2, "both SDK calls are listed under the one package");
  assert.ok(sdk.callees.every((c) => c.receiver === "proposalSDK" && c.line > 0));

  assert.equal(pack.completeness.status, "partial");
  assert.equal(pack.completeness.externalCallCount, 3);
  store.close();
});

test("a symbol with no external calls is still only a lower bound", async () => {
  const { root, store } = indexed(WIDGET);
  await indexRepo({ store, rootPath: root });
  const pack = buildContextPack(store, "localHelper");
  assert.ok(pack.focus);
  assert.deepEqual(pack.externalCalls, []);
  // No EXTERNAL calls is not the same as a complete calls list: the resolver
  // does not model constructor invocation, interface dispatch, static calls or
  // calls inside callback bodies, so the list stays a lower bound.
  assert.equal(pack.completeness.status, "lower_bound");
  assert.equal(pack.completeness.externalCallCount, 0);
  store.close();
});

test("ExplorePack shows the gap and stops claiming high confidence", async () => {
  const { root, store } = indexed(WIDGET);
  await indexRepo({ store, rootPath: root });
  const pack = buildExplorePack(store, "createProposal");
  assert.equal(pack.completeness.status, "partial");
  assert.equal(pack.completeness.externalCallCount, 3);
  assert.deepEqual(
    pack.externalCalls.map((g) => g.specifier),
    ["@fpms/proposal-sdk", "react-redux"],
    "the tier-0 entry point must not be the one view that hides the gap",
  );
  assert.notEqual(
    pack.confidence.level,
    "high",
    "a callee list missing its external calls must not read as fully trustworthy",
  );
  assert.ok(
    pack.diagnostics.some((d) => /external packages/.test(d)),
    `diagnostics must say why, got ${JSON.stringify(pack.diagnostics)}`,
  );
  store.close();
});

test("ExplorePack for a symbol with no external calls carries no external warning", async () => {
  const { root, store } = indexed(WIDGET);
  await indexRepo({ store, rootPath: root });
  const pack = buildExplorePack(store, "localHelper");
  assert.equal(pack.completeness.status, "lower_bound");
  assert.deepEqual(pack.externalCalls, []);
  assert.ok(
    !pack.diagnostics.some((d) => /external packages/.test(d)),
    "no gap means no warning — the signal must stay meaningful",
  );
  store.close();
});

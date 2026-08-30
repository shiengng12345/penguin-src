import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "@penguin/knowledge-core";
import { resolveEndpointId } from "@penguin/knowledge-core";
import { runCli } from "../index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-round13-cli-"));
  const store = KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
  const repo = "round13-cli";
  const repoId = store.registerRepo({ name: repo, rootPath: dir });
  const branchId = store.registerBranch({
    repoId,
    name: "main",
    headCommit: "round13-cli-commit",
    status: "live",
  });
  store.db.prepare("UPDATE branches SET last_indexed_commit=? WHERE id=?").run("round13-cli-commit", branchId);
  const target = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${repoId}::round13CliTarget`,
    title: "round13CliTarget",
    repoId,
  });
  const caller = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${repoId}::round13CliCaller`,
    title: "round13CliCaller",
    repoId,
  });
  const callee = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${repoId}::round13CliCallee`,
    title: "round13CliCallee",
    repoId,
  });
  const endpoint = store.upsertNode({
    nodeType: "endpoint",
    identityKey: "grpc::Round13Service.get",
    title: "gRPC Round13Service.get",
    repoId,
  });
  for (const [nodeId, filePath, title] of [
    [target, "src/target.ts", "round13CliTarget"],
    [caller, "src/caller.ts", "round13CliCaller"],
    [callee, "src/callee.ts", "round13CliCallee"],
  ] as const) {
    store.upsertSymbolVersion({
      nodeId,
      branchId,
      commitSha: "round13-cli-commit",
      filePath,
      lang: "typescript",
      kind: "function",
      signature: `${title}()`,
      contentHash: `round13-${title}`,
      status: "fresh",
    });
  }
  store.replaceFileEdges({
    branchId,
    filePath: "src/target.ts",
    edges: [{ src: target, dst: callee, edgeType: "calls", origin: "parser", method: "EXTRACTED" }],
  });
  store.replaceFileEdges({
    branchId,
    filePath: "src/caller.ts",
    edges: [{ src: caller, dst: target, edgeType: "calls", origin: "parser", method: "EXTRACTED" }],
  });
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  return { store, dir, dbPath, ledgerPath, repo, target, endpoint };
}

function deps(dbPath: string, ledgerPath: string, cwd: string, lines: string[]) {
  return {
    cwd,
    openStore: () => KnowledgeStore.open({ dbPath, ledgerPath }),
    storeExists: () => true,
    out: (line: string) => lines.push(line),
    err: (line: string) => lines.push(line),
  };
}

function lastJson(lines: string[]): Record<string, any> | null {
  for (const line of [...lines].reverse()) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object") return value as Record<string, any>;
    } catch {
      // Human diagnostics are intentionally mixed into the in-process sink.
    }
  }
  return null;
}

test("CLI exposes the runtime identity contract through capabilities", async () => {
  const { store, dir, dbPath, ledgerPath } = fixture();
  const lines: string[] = [];
  const code = await runCli(["capabilities", "--json"], deps(dbPath, ledgerPath, dir, lines));
  const payload = lastJson(lines);

  assert.equal(code, 0);
  assert.equal(payload?.schemaVersion, "14");
  assert.equal(payload?.contractVersion, "2");
  assert.equal(payload?.buildId, process.env.PENGUIN_BUILD_ID ?? "local");
  assert.match(String(payload?.capabilityHash), /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(payload?.registrations));
  store.close();
});

test("node:<id> survives context, flow, callers, callees, and affected", async () => {
  const { store, dir, dbPath, ledgerPath, repo, target } = fixture();
  for (const verb of ["context", "flow", "callers", "callees", "affected"]) {
    const lines: string[] = [];
    const code = await runCli([verb, `node:${target}`, "--repo", repo, "--json"], deps(dbPath, ledgerPath, dir, lines));
    const payload = lastJson(lines);
    assert.equal(code, 0, `${verb} failed: ${lines.join("\n")}`);
    assert.ok(payload, `${verb} did not emit JSON: ${lines.join("\n")}`);
    assert.equal(payload?.error, undefined, `${verb} returned an error: ${JSON.stringify(payload)}`);
  }
  store.close();
});

test("callees without a target fails with an actionable non-success result", async () => {
  const { store, dir, dbPath, ledgerPath, repo } = fixture();
  const lines: string[] = [];
  const code = await runCli(["callees", "--repo", repo, "--json"], deps(dbPath, ledgerPath, dir, lines));
  assert.notEqual(code, 0);
  assert.match(lines.join("\n"), /target|usage|resolve/i);
  store.close();
});

test("an explicit wrong revision fails closed instead of returning live-branch evidence", async () => {
  const { store, dir, dbPath, ledgerPath, repo, target } = fixture();
  const lines: string[] = [];
  const invalidRevision = `round13-invalid-${randomUUID()}`;
  const code = await runCli(
    ["context", `node:${target}`, "--repo", repo, "--commit", invalidRevision, "--json"],
    deps(dbPath, ledgerPath, dir, lines),
  );
  assert.equal(code, 4, lines.join("\n"));
  assert.match(lines.join("\n"), new RegExp(invalidRevision));
  assert.match(lines.join("\n"), /scopeError|revision|commit/i);
  store.close();
});

test("an invalid node returns a structured resolution error", async () => {
  const { store, dir, dbPath, ledgerPath, repo } = fixture();
  const lines: string[] = [];
  const missing = `node:round13-missing-${randomUUID()}`;
  const code = await runCli(["context", missing, "--repo", repo, "--json"], deps(dbPath, ledgerPath, dir, lines));
  const payload = lastJson(lines);

  assert.equal(code, 1);
  assert.deepEqual(payload?.error, {
    code: "TARGET_NOT_FOUND",
    message: `target was not found: ${missing}`,
    retryable: false,
    details: { target: missing },
  });
  store.close();
});

test("endpoint identity accepts the public node:<id> form", async () => {
  const { store, dir, dbPath, ledgerPath, endpoint } = fixture();
  const lines: string[] = [];
  const code = await runCli([
    "endpoint-identity",
    "gRPC Round13Service.get",
    "grpc::Round13Service.get",
    `node:${endpoint}`,
    "--json",
  ], deps(dbPath, ledgerPath, dir, lines));

  assert.equal(code, 0, lines.join("\n"));
  assert.equal(resolveEndpointId(store, `node:${endpoint}`), endpoint);
  assert.equal(lastJson(lines)?.equal, true);
  store.close();
});

test("human negative output says not proven when coverage cannot prove absence", async () => {
  const { store, dir, dbPath, ledgerPath, repo } = fixture();
  const lines: string[] = [];
  const code = await runCli(
    ["search", `round13-definitely-absent-${randomUUID()}`, "--repo", repo],
    deps(dbPath, ledgerPath, dir, lines),
  );

  assert.equal(code, 0);
  assert.match(lines.join("\n"), /not proven/i);
  store.close();
});

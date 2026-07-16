import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { dependencyPath, packageDependencies } from "../packages/knowledge-core/dist/index.js";

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-package-query-"));
  const store = KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
  const repoId = store.registerRepo({ name: "fixture-auth", rootPath: "/fixture-auth" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  const ids = new Map();
  for (const name of ["auth", "nestjs-logger", "console-override", "pino", "unrelated"]) {
    ids.set(name, store.upsertNode({
      nodeType: "service",
      identityKey: `npm-package::${name}`,
      title: name,
      repoId: name === "auth" ? repoId : null,
    }));
  }
  store.replaceFileEdges({
    repoId,
    branchId,
    filePath: "~package.json",
    edges: [
      { src: ids.get("auth"), dst: ids.get("nestjs-logger"), edgeType: "depends_on", origin: "parser", method: "EXTRACTED", provenance: { source: "pnpm-lock.yaml", resolvedVersion: "2.1.0" } },
      { src: ids.get("nestjs-logger"), dst: ids.get("console-override"), edgeType: "depends_on", origin: "parser", method: "EXTRACTED", provenance: { source: "pnpm-lock.yaml", resolvedVersion: "2.1.4" } },
      { src: ids.get("console-override"), dst: ids.get("pino"), edgeType: "depends_on", origin: "parser", method: "EXTRACTED", provenance: { source: "pnpm-lock.yaml", resolvedVersion: "9.14.0" } },
    ],
  });
  return { store, ids };
}

test("returns bounded direct and transitive dependencies with evidence", () => {
  const { store } = seed();
  try {
    const direct = packageDependencies(store, {
      subject: "auth",
      direction: "dependencies",
      transitive: false,
      maxDepth: 5,
      limit: 20,
    });
    assert.deepEqual(direct.nodes.map((node) => node.title), ["nestjs-logger"]);

    const transitive = packageDependencies(store, {
      subject: "auth",
      direction: "dependencies",
      transitive: true,
      maxDepth: 5,
      limit: 20,
    });
    assert.deepEqual(transitive.nodes.map((node) => node.title), ["nestjs-logger", "console-override", "pino"]);
    assert.equal(transitive.nodes[0].evidence.resolvedVersion, "2.1.0");
  } finally {
    store.close();
  }
});

test("supports reverse dependents and bounded dependency paths", () => {
  const { store } = seed();
  try {
    const dependents = packageDependencies(store, {
      subject: "pino",
      direction: "dependents",
      transitive: true,
      maxDepth: 5,
      limit: 20,
    });
    assert.deepEqual(dependents.nodes.map((node) => node.title), ["console-override", "nestjs-logger", "auth"]);

    const path = dependencyPath(store, { from: "auth", to: "pino", maxDepth: 5 });
    assert.equal(path.status, "found");
    assert.deepEqual(path.path.map((node) => node.title), ["auth", "nestjs-logger", "console-override", "pino"]);
  } finally {
    store.close();
  }
});

test("distinguishes missing subjects, no paths, and depth truncation", () => {
  const { store } = seed();
  try {
    assert.equal(
      packageDependencies(store, { subject: "missing", direction: "dependencies", transitive: true, maxDepth: 5, limit: 20 }).status,
      "subject_not_found",
    );
    assert.equal(dependencyPath(store, { from: "auth", to: "unrelated", maxDepth: 5 }).status, "no_path");
    const bounded = packageDependencies(store, {
      subject: "auth",
      direction: "dependencies",
      transitive: true,
      maxDepth: 1,
      limit: 20,
    });
    assert.deepEqual(bounded.nodes.map((node) => node.title), ["nestjs-logger"]);
    assert.equal(bounded.truncated, true);
  } finally {
    store.close();
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readPackageDependencies } from "../packages/knowledge-indexer/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/pipeline.js";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

function makeFixture({ withLockfile = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "penguin-package-deps-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture-auth",
      dependencies: {
        "@snsoft/nestjs-logger": "2.1.0",
        pino: "^9.14.0",
      },
      devDependencies: {
        typescript: "^5.9.0",
      },
    }),
  );
  if (withLockfile) {
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '9.0'",
        "importers:",
        "  .:",
        "    dependencies:",
        "      '@snsoft/nestjs-logger':",
        "        specifier: 2.1.0",
        "        version: 2.1.0",
        "      pino:",
        "        specifier: ^9.14.0",
        "        version: 9.14.0",
        "    devDependencies:",
        "      typescript:",
        "        specifier: ^5.9.0",
        "        version: 5.9.3",
        "packages:",
        "  '@snsoft/nestjs-logger@2.1.0': {}",
        "  pino@9.14.0: {}",
        "  typescript@5.9.3: {}",
        "snapshots:",
        "  '@snsoft/nestjs-logger@2.1.0': {}",
        "  pino@9.14.0: {}",
        "  typescript@5.9.3: {}",
        "",
      ].join("\n"),
    );
  }
  return root;
}

test("reads package and lockfile dependencies without node_modules", () => {
  const root = makeFixture();
  try {
    const report = readPackageDependencies(root);
    assert.ok(report);
    assert.equal(report.packageName, "fixture-auth");
    assert.equal(report.complete, true);
    assert.equal(report.lockfilePath, join(root, "pnpm-lock.yaml"));
    assert.equal(report.dependencies.find((d) => d.name === "pino")?.resolvedVersion, "9.14.0");
    assert.equal(
      report.dependencies.find((d) => d.name === "@snsoft/nestjs-logger")?.source,
      "pnpm-lock.yaml",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports incomplete dependency evidence when lockfile is absent", () => {
  const root = makeFixture({ withLockfile: false });
  try {
    const report = readPackageDependencies(root);
    assert.ok(report);
    assert.equal(report.complete, false);
    assert.equal(report.dependencies.find((d) => d.name === "pino")?.source, "package.json");
    assert.ok(report.gaps.some((gap) => gap.includes("pnpm-lock.yaml")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("indexes manifest dependencies without node_modules and preserves provenance", async () => {
  const root = makeFixture();
  const dbRoot = mkdtempSync(join(tmpdir(), "penguin-package-db-"));
  const store = KnowledgeStore.open({
    dbPath: join(dbRoot, "knowledge.db"),
    ledgerPath: join(dbRoot, "ledger.jsonl"),
  });
  try {
    await indexRepo({ store, rootPath: root, mode: "incremental" });
    const rows = store.db.prepare(
      `SELECT src.title AS fromTitle, dst.title AS toTitle, provenance
       FROM edges
       JOIN nodes src ON src.id = edges.src
       JOIN nodes dst ON dst.id = edges.dst
       WHERE edges.edge_type = 'depends_on'`,
    ).all();
    const pino = rows.find((row) => row.toTitle === "pino");
    assert.ok(pino, "pino dependency should be indexed without node_modules");
    const provenance = JSON.parse(pino.provenance);
    assert.equal(provenance.source, "pnpm-lock.yaml");
    assert.equal(provenance.resolvedVersion, "9.14.0");
    assert.equal(provenance.file, "~package.json");
  } finally {
    store.close();
    rmSync(dbRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

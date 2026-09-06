#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  KnowledgeStore,
  reconcileCorpus,
} from "../packages/knowledge-core/dist/index.js";
import {
  collectIndependentCorpusOracle,
  discoverFullCorpusRepositories,
  langForExtension,
  readGitContext,
} from "../packages/knowledge-indexer/dist/index.js";

function option(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : undefined;
}

function required(name) {
  const value = option(name);
  if (!value) throw new Error(`missing --${name}=...`);
  return value;
}

function transportReport(name) {
  const path = option(`${name}-report`);
  if (!path) return undefined;
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`${name} report not found: ${resolved}`);
  const report = JSON.parse(readFileSync(resolved, "utf8"));
  return {
    counts: report.counts ?? report.layers ?? {},
    endpointKeys: report.endpointKeys ?? report.endpoints?.persisted ?? [],
    status: report.status,
    statusPath: resolved,
  };
}

async function reconcileRepository(store, rootPath) {
  const canonicalRoot = realpathSync.native(rootPath);
  const git = readGitContext(canonicalRoot);
  const repo = store.getRepoByRoot(git.checkoutPath);
  if (!repo) {
    return {
      rootPath: canonicalRoot,
      status: "incomplete",
      gaps: ["repository:not_registered"],
      source: null,
    };
  }
  const branch = store.getBranch(repo.id, git.branch);
  if (!branch) {
    return {
      rootPath: canonicalRoot,
      repo: { id: repo.id, name: repo.name },
      status: "incomplete",
      gaps: ["branch:not_registered"],
      source: null,
    };
  }
  const oracle = await collectIndependentCorpusOracle(canonicalRoot);
  const source = oracle.source;
  const cli = transportReport("cli");
  const mcp = transportReport("mcp");
  const tauri = transportReport("tauri");
  const result = reconcileCorpus({
    store,
    scope: { repoId: repo.id, branchId: branch.id, snapshotId: branch.current_snapshot_id ?? null },
    source,
    ...(cli ? { cli } : {}),
    ...(mcp ? { mcp } : {}),
    ...(tauri ? { tauri } : {}),
  });
  return {
    ...result,
    repo: { id: repo.id, name: repo.name, rootPath: repo.root_path },
    git: {
      branch: git.branch,
      head: git.commit,
      worktreeState: git.worktreeState,
      worktreeFingerprint: git.worktreeFingerprint,
      dirtyFiles: git.dirtyFiles.length,
    },
    sourceOracle: {
      endpointOccurrences: oracle.source.endpointOccurrences,
      endpointRecords: oracle.endpointRecords,
      parserErrors: oracle.parserErrors,
      discoveryWarnings: oracle.discoveryWarnings,
    },
  };
}

const rootPath = resolve(required("root"));
const dbPath = resolve(option("db") ?? join(homedir(), ".penguin", "knowledge", "knowledge.db"));
const ledgerPath = option("ledger") ? resolve(option("ledger")) : undefined;
const strict = process.argv.includes("--strict");
if (!existsSync(dbPath)) {
  console.log(JSON.stringify({ ok: false, code: "KNOWLEDGE_DB_NOT_FOUND", dbPath }, null, 2));
  process.exit(2);
}

const store = KnowledgeStore.open({ dbPath, ...(ledgerPath ? { ledgerPath } : {}), allowSchemaMutation: false });
try {
  const repositories = discoverFullCorpusRepositories(rootPath);
  const targets = repositories.length > 0 ? repositories : [rootPath];
  const results = [];
  for (const target of targets) results.push(await reconcileRepository(store, target));
  const failures = results.flatMap((result) => [
    ...(result.status === "failed" ? [`${result.rootPath}: ${result.gaps.length} reconciliation gap(s)`] : []),
    ...(result.sourceOracle?.parserErrors ?? []).map((error) => `${result.rootPath}:${error.filePath}: ${error.error}`),
  ]);
  const output = {
    ok: failures.length === 0 && results.every((result) => result.status === "passed"),
    rootPath,
    dbPath,
    strict,
    generatedAt: new Date().toISOString(),
    repositories: results,
    failures,
  };
  console.log(JSON.stringify(output, null, 2));
  if (strict && !output.ok) process.exitCode = 1;
} finally {
  store.close();
}

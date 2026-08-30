#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

const root = resolve(import.meta.dirname, "..");
const dbPath = process.env.PENGUIN_KNOWLEDGE_DB ?? join(homedir(), ".penguin", "knowledge", "knowledge.db");
const ledgerPath = process.env.PENGUIN_KNOWLEDGE_LEDGER ?? join(homedir(), ".penguin", "knowledge", "ledger.jsonl");
const requestedRepo = process.env.PENGUIN_REPO ?? process.argv.slice(2).find((arg) => !arg.startsWith("-")) ?? "FPMS-NT";
const strict = process.argv.includes("--strict");
const reportPath = process.env.PENGUIN_COVERAGE_REPORT ?? resolve(root, "docs/quality/knowledge-coverage-audit.md");

if (!existsSync(dbPath)) {
  console.error(JSON.stringify({ ok: false, code: "KNOWLEDGE_DB_NOT_FOUND", dbPath }, null, 2));
  process.exit(2);
}

const store = KnowledgeStore.open({ dbPath, ledgerPath, allowSchemaMutation: false });
try {
  const repoIds = store.resolveRepoIds(requestedRepo);
  if (repoIds.length === 0) {
    console.error(JSON.stringify({ ok: false, code: "REPOSITORY_NOT_FOUND", repo: requestedRepo }, null, 2));
    process.exit(2);
  }

  const repositories = repoIds.map((repoId) => {
    const repo = store.db.prepare("SELECT id, name, root_path AS rootPath FROM repos WHERE id=?").get(repoId);
    const coverage = store.db.prepare(`
      SELECT COUNT(*) AS discovered,
             COALESCE(SUM(coverage_status='admitted'),0) AS admitted,
             COALESCE(SUM(coverage_status='excluded'),0) AS excluded,
             COALESCE(SUM(coverage_status='failed'),0) AS failed,
             COALESCE(SUM(coverage_status='stale'),0) AS stale
        FROM coverage_records WHERE repo_id=?
    `).get(repoId);
    const excludedFiles = store.db.prepare(`
      SELECT file_path AS filePath, reason_code AS reasonCode, classification, reason
        FROM coverage_records
       WHERE repo_id=? AND coverage_status='excluded'
       ORDER BY file_path
    `).all(repoId);
    let unresolvedReferences = [];
    try {
      unresolvedReferences = store.db.prepare(`
        SELECT branch_id AS branchId, file_path AS filePath, revision_id AS revisionId,
               resolved, total, total-resolved AS unresolved, updated_at AS updatedAt
          FROM unresolved_reference_coverage
         WHERE repo_id=? AND total-resolved > 0
         ORDER BY file_path, revision_id
      `).all(repoId);
    } catch {
      // Older databases may not have the additive unresolved-reference table.
    }
    const unresolvedCount = unresolvedReferences.reduce((sum, row) => sum + Math.max(0, Number(row.unresolved) || 0), 0);
    return {
      repo,
      coverage: Object.fromEntries(Object.entries(coverage).map(([key, value]) => [key, Number(value ?? 0)])),
      excludedFiles,
      unresolvedReferences,
      unresolvedCount,
      proofStatus: excludedFiles.length || unresolvedCount ? "not_proven" : "proven",
    };
  });

  const summary = {
    ok: true,
    repo: requestedRepo,
    dbPath,
    strict,
    repositories,
    generatedAt: new Date().toISOString(),
  };
  const blockers = repositories.flatMap((item) => [
    ...(item.excludedFiles.length ? [`${item.repo.name}: ${item.excludedFiles.length} excluded files`] : []),
    ...(item.coverage.failed ? [`${item.repo.name}: ${item.coverage.failed} failed files`] : []),
    ...(item.unresolvedCount ? [`${item.repo.name}: ${item.unresolvedCount} unresolved references`] : []),
  ]);
  const markdown = [
    "# Penguin Knowledge Coverage Audit", "",
    `- Repository selector: \`${requestedRepo}\``,
    `- Database: \`${dbPath}\``,
    `- Generated: \`${summary.generatedAt}\``,
    `- Proof status: **${blockers.length ? "not proven" : "proven"}**`, "",
    "## Repositories", "",
    ...repositories.flatMap((item) => [
      `### ${item.repo.name} (\`${item.repo.id}\`)`,
      `- coverage: ${JSON.stringify(item.coverage)}`,
      `- excluded files: ${item.excludedFiles.length}`,
      `- unresolved references: ${item.unresolvedCount}`,
      item.excludedFiles.length ? `- excluded detail: ${JSON.stringify(item.excludedFiles)}` : "- excluded detail: none",
      item.unresolvedReferences.length ? `- unresolved detail: ${JSON.stringify(item.unresolvedReferences)}` : "- unresolved detail: none",
      "",
    ]),
    "## Gate", "",
    blockers.length ? `NOT PROVEN: ${blockers.join("; ")}.` : "PROVEN: no excluded, failed, or unresolved records were found.", "",
  ];
  mkdirSync(resolve(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, markdown.join("\n"));
  console.log(JSON.stringify({ ...summary, blockers, reportPath }, null, 2));
  process.exit(strict && blockers.length ? 1 : 0);
} finally {
  store.close();
}

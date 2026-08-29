// Audit production→test call edges across the live index.
//
// An edge from production code into a test file's symbol is almost always the
// resolver binding a name it could not resolve to whatever same-named symbol
// existed — a mock stub, a fixture helper. This counts them.
//
// It classifies paths with the resolver's OWN isTestFilePath, never a
// hand-written SQL LIKE. Two separate wrong readings came from doing it by
// hand: `LIKE '%__tests__%'` treats _ as a single-character wildcard and
// matched paths with no test segment at all, and a narrow pattern that knew
// only the JS conventions reported 23 fake edges where there were 537. A
// measurement that can drift from the rule it measures is worse than none.
//
//   node scripts/knowledge-fake-edge-audit.mjs [--json] [--repo <name>]
//   node scripts/knowledge-fake-edge-audit.mjs --samples 20

import { homedir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { isTestFilePath } from "../packages/knowledge-indexer/dist/resolve.js";

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const json = argv.includes("--json");
const repoFilter = flag("repo");
const sampleLimit = Number(flag("samples") ?? 10);

const dbPath = process.env.PENGUIN_KNOWLEDGE_DB
  ?? join(homedir(), ".penguin", "knowledge", "knowledge.db");
const store = KnowledgeStore.open({
  dbPath,
  ledgerPath: join(homedir(), ".penguin", "knowledge", "ledger.jsonl"),
});

// Only live branches: snapshot branches record what the index said at an older
// commit, and re-judging them against today's rules would be revisionism.
const rows = store.db.prepare(`
  SELECT r.name AS repo, b.name AS branch, b.resolver_version AS resolver,
         ssv.file_path AS srcFile, dsv.file_path AS dstFile,
         sn.title AS caller, dn.title AS callee, dsv.start_line AS dstLine
    FROM edges e
    JOIN branches b ON b.id = e.branch_id AND b.status = 'live'
    JOIN repos r ON r.id = b.repo_id
    JOIN symbol_versions ssv ON ssv.node_id = e.src AND ssv.status = 'fresh'
    JOIN symbol_versions dsv ON dsv.node_id = e.dst AND dsv.status = 'fresh'
    JOIN nodes sn ON sn.id = e.src
    JOIN nodes dn ON dn.id = e.dst
   WHERE e.edge_type = 'calls' AND e.status = 'active'
     ${repoFilter ? "AND r.name = ?" : ""}
`).all(...(repoFilter ? [repoFilter] : []));

const perRepo = new Map();
const samples = [];
for (const row of rows) {
  const entry = perRepo.get(row.repo) ?? { repo: row.repo, resolver: row.resolver, calls: 0, fake: 0 };
  entry.calls += 1;
  // Production caller, test-file callee. A test calling a test helper is the
  // test graph doing its job and is not counted.
  if (!isTestFilePath(row.srcFile) && isTestFilePath(row.dstFile)) {
    entry.fake += 1;
    if (samples.length < sampleLimit) {
      samples.push({
        repo: row.repo,
        caller: `${row.caller} (${row.srcFile})`,
        callee: `${row.callee} (${row.dstFile}:${row.dstLine})`,
      });
    }
  }
  perRepo.set(row.repo, entry);
}

const report = {
  dbPath,
  totalCalls: rows.length,
  totalFake: [...perRepo.values()].reduce((sum, r) => sum + r.fake, 0),
  repos: [...perRepo.values()].filter((r) => r.fake > 0).sort((a, b) => b.fake - a.fake),
  samples,
};
store.close();

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const rate = report.totalCalls > 0 ? (report.totalFake / report.totalCalls) * 100 : 0;
  console.log(`${report.totalFake} production→test call edges of ${report.totalCalls} (${rate.toFixed(3)}%)`);
  if (report.repos.length === 0) {
    console.log("clean — no live branch binds production code to a test-file symbol");
  }
  for (const entry of report.repos) {
    console.log(`  ${entry.repo}: ${entry.fake} of ${entry.calls}  [${entry.resolver ?? "resolver unknown"}]`);
  }
  for (const sample of report.samples) {
    console.log(`    ${sample.caller}\n      → ${sample.callee}`);
  }
}
process.exit(report.totalFake > 0 ? 1 : 0);

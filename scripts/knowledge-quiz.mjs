#!/usr/bin/env node
// Generate an index-quality quiz from a REAL indexed repo.
//
// Asking an AI questions only measures index quality if the answers can be
// checked without trusting the index. So every question here comes with two
// independent things:
//
//   expected  — what the index believes (read straight from SQLite)
//   verify    — a ripgrep command that answers the same question from source
//
// That gives a three-way comparison:
//   index vs ripgrep   → index quality (missing edges, phantom edges)
//   AI    vs index     → whether the agent actually used the tools well
//
// Usage:
//   node scripts/knowledge-quiz.mjs [--repo <name>] [--count 12] [--json]
//   node scripts/knowledge-quiz.mjs --repo FPMS-CCMS --count 8 > quiz.md

import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(join(process.cwd(), "packages/knowledge-core/"));
const Database = require("better-sqlite3");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith("--") ? args[at + 1] : fallback;
};
const asJson = args.includes("--json");
const wanted = flag("repo", null);
const count = Number(flag("count", 12));

const dbPath = process.env.PENGUIN_KNOWLEDGE_DB ?? join(homedir(), ".penguin", "knowledge", "knowledge.db");
const db = new Database(dbPath, { readonly: true });

const repos = db.prepare("SELECT id, name, root_path AS rootPath FROM repos ORDER BY name").all();
const repo = wanted
  ? repos.find((r) => r.name === wanted || r.name.includes(wanted))
  : repos.find((r) => r.rootPath && r.name);
if (!repo) {
  console.error(`repo not found. Indexed repos:\n${repos.map((r) => `  ${r.name}`).join("\n")}`);
  process.exit(2);
}

const questions = [];

// ── 1. Callers of a well-connected function ───────────────────────────────
// Picks symbols with a middling caller count: one caller is trivial, fifty is
// unverifiable by hand.
const callerTargets = db.prepare(`
  SELECT d.title AS name, sv.file_path AS filePath, COUNT(DISTINCT e.src) AS callers
    FROM edges e
    JOIN nodes d ON d.id = e.dst
    JOIN symbol_versions sv ON sv.node_id = d.id
   WHERE e.edge_type = 'calls' AND e.status = 'active' AND d.repo_id = ?
     AND LENGTH(d.title) > 6
   GROUP BY d.id
  HAVING callers BETWEEN 2 AND 8
   ORDER BY callers DESC, d.title
   LIMIT ?
`).all(repo.id, Math.ceil(count / 3));

for (const target of callerTargets) {
  const callers = db.prepare(`
    SELECT DISTINCT s.title AS name, svs.file_path AS filePath
      FROM edges e
      JOIN nodes s ON s.id = e.src
      JOIN nodes d ON d.id = e.dst
      JOIN symbol_versions svs ON svs.node_id = s.id
      JOIN symbol_versions svd ON svd.node_id = d.id
     WHERE e.edge_type = 'calls' AND e.status = 'active'
       AND d.title = ? AND svd.file_path = ? AND d.repo_id = ?
     ORDER BY filePath, name
  `).all(target.name, target.filePath, repo.id);
  questions.push({
    kind: "callers",
    question: `In ${repo.name}, which functions call \`${target.name}\` (defined in ${target.filePath})? List every caller with its file.`,
    expected: callers.map((c) => `${c.filePath}:${c.name}`),
    verify: `rg -n --no-heading '\\b${target.name}\\s*\\(' ${repo.rootPath} | grep -v '${target.filePath}'`,
    checks: "Every caller the index lists should appear in the ripgrep output. Extra ripgrep hits are usually same-name symbols in other scopes — read them before calling them missing edges.",
  });
}

// ── 2. What a symbol calls (outgoing edges) ───────────────────────────────
const calleeSources = db.prepare(`
  SELECT s.title AS name, sv.file_path AS filePath, COUNT(DISTINCT e.dst) AS callees
    FROM edges e
    JOIN nodes s ON s.id = e.src
    JOIN symbol_versions sv ON sv.node_id = s.id
   WHERE e.edge_type = 'calls' AND e.status = 'active' AND s.repo_id = ?
     AND LENGTH(s.title) > 6
   GROUP BY s.id
  HAVING callees BETWEEN 3 AND 10
   ORDER BY callees DESC, s.title
   LIMIT ?
`).all(repo.id, Math.ceil(count / 4));

for (const source of calleeSources) {
  const callees = db.prepare(`
    SELECT DISTINCT d.title AS name, svd.file_path AS filePath
      FROM edges e
      JOIN nodes s ON s.id = e.src
      JOIN nodes d ON d.id = e.dst
      JOIN symbol_versions svs ON svs.node_id = s.id
      JOIN symbol_versions svd ON svd.node_id = d.id
     WHERE e.edge_type = 'calls' AND e.status = 'active'
       AND s.title = ? AND svs.file_path = ? AND s.repo_id = ?
     ORDER BY filePath, name
  `).all(source.name, source.filePath, repo.id);
  questions.push({
    kind: "callees",
    question: `In ${repo.name}, what does \`${source.name}\` (${source.filePath}) call? Name each callee and where it lives.`,
    expected: callees.map((c) => `${c.filePath}:${c.name}`),
    verify: `sed -n '/${source.name}/,/^}/p' ${join(repo.rootPath, source.filePath)}`,
    checks: "Read the function body in the verify output and confirm each listed callee really is invoked there.",
  });
}

// ── 3. Endpoints (the hardest thing to fake) ──────────────────────────────
const endpoints = db.prepare(`
  SELECT n.title AS name, json_extract(n.meta, '$.filePath') AS filePath
    FROM nodes n
   WHERE n.repo_id = ? AND n.node_type = 'endpoint'
   ORDER BY n.title
   LIMIT ?
`).all(repo.id, Math.ceil(count / 4));

for (const endpoint of endpoints) {
  const handlers = db.prepare(`
    SELECT DISTINCT d.title AS name, sv.file_path AS filePath
      FROM edges e
      JOIN nodes s ON s.id = e.src
      JOIN nodes d ON d.id = e.dst
      LEFT JOIN symbol_versions sv ON sv.node_id = d.id
     WHERE e.status = 'active' AND s.title = ? AND s.repo_id = ?
     ORDER BY name
  `).all(endpoint.name, repo.id);
  questions.push({
    kind: "endpoint",
    question: `In ${repo.name}, trace the endpoint \`${endpoint.name}\`: which handler serves it, and what does that handler call next?`,
    expected: handlers.map((h) => `${h.filePath ?? "?"}:${h.name}`),
    verify: `rg -n --no-heading '${endpoint.name.split(/[./]/).pop()}' ${repo.rootPath}`,
    checks: "The handler must exist at the stated file:line. A wrong handler is a serious index defect — endpoints are what agents route from.",
  });
}

// ── 4. Symbol inventory of one file (catches missing extraction) ──────────
const files = db.prepare(`
  SELECT f.file_path AS filePath, COUNT(*) AS symbols
    FROM file_fact_symbols s
    JOIN file_facts f ON f.id = s.file_fact_id
   WHERE f.repo_id = ?
   GROUP BY f.file_path
  HAVING symbols BETWEEN 4 AND 12
   ORDER BY symbols DESC
   LIMIT ?
`).all(repo.id, Math.ceil(count / 4));

for (const file of files) {
  const symbols = db.prepare(`
    SELECT s.title AS name, s.kind
      FROM file_fact_symbols s
      JOIN file_facts f ON f.id = s.file_fact_id
     WHERE f.repo_id = ? AND f.file_path = ?
     ORDER BY s.title
  `).all(repo.id, file.filePath);
  questions.push({
    kind: "file_symbols",
    question: `In ${repo.name}, list every function/class/method defined in ${file.filePath}.`,
    expected: symbols.map((s) => `${s.name} (${s.kind})`),
    verify: `rg -n --no-heading '^\\s*(export\\s+)?(async\\s+)?(function|class|const\\s+\\w+\\s*=\\s*(async\\s*)?\\()|^\\s*(public|private|protected)?\\s*\\w+\\s*\\(' ${join(repo.rootPath, file.filePath)}`,
    checks: "A declaration in the file that the index does not list is a missed symbol. This is the check that catches parser gaps in a language.",
  });
}

db.close();

const selected = questions.slice(0, count);

if (asJson) {
  console.log(JSON.stringify({ repo: repo.name, rootPath: repo.rootPath, questions: selected }, null, 2));
  process.exit(0);
}

console.log(`# Index quality quiz — ${repo.name}`);
console.log(`\nRepo: \`${repo.rootPath}\`  ·  ${selected.length} questions\n`);
console.log(`Ask an AI agent the **Question** lines only. Then compare its answer to`);
console.log(`**Index says** (what Penguin believes) and run **Verify** to check the`);
console.log(`index itself against the source.\n`);
console.log(`- AI answer ≠ Index says → the agent did not use the tools properly`);
console.log(`- Index says ≠ Verify output → a real index defect worth reporting\n`);

selected.forEach((q, i) => {
  console.log(`\n---\n\n## Q${i + 1} · ${q.kind}\n`);
  console.log(`**Question**\n\n> ${q.question}\n`);
  console.log(`**Index says** (${q.expected.length})\n`);
  for (const line of q.expected) console.log(`- \`${line}\``);
  console.log(`\n**Verify**\n\n\`\`\`bash\n${q.verify}\n\`\`\`\n`);
  console.log(`**How to judge**: ${q.checks}`);
});

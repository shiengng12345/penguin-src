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
// --out <dir> writes TWO files: questions (safe to hand an AI) and the answer
// key. They are separate on purpose — a single file containing both means the
// AI reads the answers before it answers, and "please ignore that section" is
// not a control.
const outDir = flag("out", null);
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
    // Do NOT exclude the defining file: a helper is very often called by its
    // own siblings, and filtering that file out makes a correct 8-caller
    // answer look like 1. (Caught while grading a real quiz.) The definition
    // line itself is dropped instead, so what remains is call sites only.
    verify: `rg -n --no-heading '\\b${target.name}\\s*\\(' ${repo.rootPath} | grep -vE '(const|function|export)\\s+${target.name}\\b'`,
    checks: "Every caller the index lists should appear in the ripgrep output, INCLUDING calls inside the defining file. Extra hits are often a same-named symbol in another file — check the path before calling anything a missed edge.",
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

// ── 5. Calls that leave the repo (the gap the callee list cannot show) ────
// The resolver abstains on calls into external packages, so a callee list is
// legitimately incomplete for these symbols. What is being measured is whether
// the agent REPORTS that, or presents a short list as the whole truth.
const externalCallers = db.prepare(`
  SELECT n.title AS name, sv.file_path AS filePath, e.src_node_id AS nodeId,
         COUNT(*) AS externals, COUNT(DISTINCT e.callee) AS distinctCallees
    FROM external_calls e
    JOIN nodes n ON n.id = e.src_node_id
    JOIN symbol_versions sv ON sv.node_id = n.id AND sv.status = 'fresh'
   WHERE e.repo_id = ? AND LENGTH(n.title) > 6
     -- Production symbols make the better question: the point is whether an
     -- agent reports the gap in a callee list someone would actually rely on.
     AND sv.file_path NOT LIKE '%/tests/%' AND sv.file_path NOT LIKE '%/test/%'
     AND sv.file_path NOT LIKE '%.test.%' AND sv.file_path NOT LIKE '%.spec.%'
   GROUP BY e.src_node_id
  -- Distinct callees, not just a count: a schema class with @Prop repeated six
  -- times is one fact asked six ways, and answering it proves nothing.
  HAVING externals BETWEEN 2 AND 6 AND distinctCallees >= 2
   ORDER BY distinctCallees DESC, externals DESC, n.title
   LIMIT ?
`).all(repo.id, Math.ceil(count / 5) * 4);

const seenExternalNames = new Set();
for (const target of externalCallers) {
  if (seenExternalNames.has(target.name)) continue;
  seenExternalNames.add(target.name);
  const calls = db.prepare(`
    SELECT specifier, receiver, callee, line FROM external_calls
     WHERE src_node_id = ? ORDER BY line
  `).all(target.nodeId);
  questions.push({
    kind: "external_calls",
    question: `In ${repo.name}, \`${target.name}\` (in ${target.filePath}) calls into code that is NOT defined in this repository. Which calls leave the repo, and which package does each come from? Then answer the part that matters: is the list of what this symbol calls COMPLETE, and how do you know?`,
    expected: calls.map((c) => `${c.specifier} :: ${c.receiver ? c.receiver + "." : ""}${c.callee} (line ${c.line})`),
    verify: `rg -n --no-heading '${calls.map((c) => (c.receiver ?? c.callee)).filter((v, i, a) => a.indexOf(v) === i).join("|")}' ${join(repo.rootPath, target.filePath)} | head -20`,
    checks: "The index should name each package and call site. The honesty half matters more than the list: an agent that says the calls list is COMPLETE here is wrong, because these calls have no edge. Look for it reporting partial completeness or a confidence below high.",
  });
}

// ── 6. Dead-code candidates, scoped ───────────────────────────────────────
// Scoping is the point: an unscoped answer spans every indexed repo and is not
// something anyone can act on.
const deadDirs = db.prepare(`
  SELECT substr(sv.file_path, 1, length(sv.file_path) - length(replace(sv.file_path, '/', '')) * 0) AS ignored,
         sv.file_path AS filePath
    FROM symbol_versions sv
    JOIN branches b ON b.id = sv.branch_id AND b.status = 'live'
   WHERE b.repo_id = ? AND sv.status = 'fresh' AND instr(sv.file_path, '/') > 0
     AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst = sv.node_id AND e.status = 'active'
                       AND e.edge_type IN ('calls','references','handles','tests'))
   LIMIT 1
`).all(repo.id);

if (deadDirs.length > 0) {
  const dir = deadDirs[0].filePath.split("/").slice(0, 2).join("/");
  const dead = db.prepare(`
    SELECT DISTINCT n.title AS name, sv.file_path AS filePath, sv.start_line AS line
      FROM symbol_versions sv
      JOIN nodes n ON n.id = sv.node_id
      JOIN branches b ON b.id = sv.branch_id AND b.status = 'live'
     WHERE b.repo_id = ? AND sv.status = 'fresh'
       AND substr(sv.file_path, 1, ?) = ?
       AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst = sv.node_id AND e.status = 'active'
                         AND e.edge_type IN ('calls','references','handles','tests'))
     ORDER BY sv.file_path, sv.start_line
     LIMIT 25
  `).all(repo.id, dir.length, dir);
  if (dead.length >= 3) {
    questions.push({
      kind: "dead_code",
      question: `In ${repo.name}, which symbols under \`${dir}/\` have NO incoming calls or references — i.e. dead-code candidates? Give file:line for each, and say what scope your answer covers.`,
      expected: dead.map((d) => `${d.filePath}:${d.line} — ${d.name}`),
      verify: `# spot-check one: a candidate should have no call sites outside its own definition\nrg -n --no-heading '\\b${dead[0].name}\\b' ${repo.rootPath} | head -10`,
      checks: "Candidates are leads, not proof — DI, reflection and public entry points are false positives, so a name appearing in ripgrep is not automatically a wrong answer. What IS wrong: an answer that spans other repos, or one that does not say which scope it covers.",
    });
  }
}

db.close();

// Round-robin across kinds rather than taking the first N: the generators run
// in order, so a plain slice silently dropped whole question types off the end
// — the newest ones, which are exactly the ones worth asking about.
const byKind = new Map();
for (const q of questions) {
  const bucket = byKind.get(q.kind) ?? [];
  bucket.push(q);
  byKind.set(q.kind, bucket);
}
const selected = [];
while (selected.length < count) {
  let took = 0;
  for (const bucket of byKind.values()) {
    if (selected.length >= count) break;
    const next = bucket.shift();
    if (next) { selected.push(next); took += 1; }
  }
  if (took === 0) break; // every kind exhausted
}

if (asJson) {
  console.log(JSON.stringify({ repo: repo.name, rootPath: repo.rootPath, questions: selected }, null, 2));
  process.exit(0);
}

if (outDir) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(outDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  const quiz = [
    `# Penguin index-quality quiz — questions`,
    ``,
    `> Self-contained: reading this is enough to start.`,
    `> Repo: \`${repo.name}\` (\`${repo.rootPath}\`) · ${selected.length} questions · ${today}`,
    `> The answers are deliberately NOT in this file (see index-quality-answers.md),`,
    `> so you cannot check yourself — answer honestly.`,
    ``,
    `## Your task`,
    ``,
    `Measure the quality of a local code index (Penguin). You are not changing code.`,
    ``,
    `**Rules**`,
    ``,
    `1. Answer using Penguin's MCP tools only, \`knowledge_explore\` first. No grep, no`,
    `   reading source files, no filling gaps from general knowledge — that would`,
    `   measure something other than the index.`,
    `2. Give the COMPLETE list per answer, with \`file:line\`. No examples-only, no "etc".`,
    `3. **If the tools cannot answer, say so.** This matters most: an honest "not in`,
    `   the index" is worth more than a lucky guess, because a guess hides the gap`,
    `   that is exactly what I am measuring. Leave it blank rather than fill it in.`,
    `4. If a tool reports \`freshness=stale\`, pass that on — do not present stale data`,
    `   as current.`,
    `5. Answer each question independently; do not infer later answers from earlier patterns.`,
    ``,
    `**Output format** (one block per question)`,
    ``,
    "```",
    `## Q<n>`,
    `answer:`,
    `- path/to/file.ts:123 — symbolName`,
    `- ...`,
    `tool used: knowledge_explore("...")`,
    `confidence: high / medium / low — if low, say what the index was missing`,
    "```",
    ``,
    `---`,
  ];
  selected.forEach((q, i) => {
    quiz.push(``, `## Q${i + 1} · ${q.kind}`, ``, q.question, ``);
  });
  writeFileSync(join(outDir, "index-quality-quiz.md"), `${quiz.join("\n")}\n`);

  const key = [
    `# Penguin index-quality quiz — answer key`,
    ``,
    `> For comparison only. **Do not hand this to the AI** (questions live in`,
    `> index-quality-quiz.md). Repo: \`${repo.name}\` · ${today}`,
    ``,
    `## How to judge`,
    ``,
    `Two different failures, kept apart:`,
    ``,
    `| Comparison | Conclusion |`,
    `|---|---|`,
    `| AI answer != **index answer** | The agent did not use the tools properly. Its problem, not the index's. |`,
    `| **index answer** != **verify output** | A real index defect (missed or phantom edge). This is the one worth fixing. |`,
    ``,
    `Reading verify output: extra ripgrep hits are often same-name symbols in other`,
    `scopes. Read them before calling anything a missed edge.`,
    ``,
    `---`,
  ];
  selected.forEach((q, i) => {
    key.push(``, `## Q${i + 1} · ${q.kind}`, ``, `**Question**: ${q.question}`, ``,
      `**Index answer** (${q.expected.length})`, ``);
    for (const line of q.expected) key.push(`- \`${line}\``);
    key.push(``, `**Independent verification**`, ``, "```bash", q.verify, "```", ``,
      `**What to look for**: ${q.checks}`);
  });
  writeFileSync(join(outDir, "index-quality-answers.md"), `${key.join("\n")}\n`);
  console.log(`wrote ${join(outDir, "index-quality-quiz.md")} (give the AI this path)`);
  console.log(`wrote ${join(outDir, "index-quality-answers.md")} (keep for yourself)`);
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

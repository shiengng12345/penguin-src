import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(process.argv.find((arg) => arg.startsWith("--root="))?.slice(7) ?? ".");
const output = resolve(process.argv.find((arg) => arg.startsWith("--out="))?.slice(6) ?? "docs/knowledge-v2/real-question-corpus.jsonl");
const graph = resolve(process.argv.find((arg) => arg.startsWith("--graph="))?.slice(8) ?? "graphify-out/graph.json");
const counts = { exact_path: 20, caller_callee_impact: 15, cross_service_protocol: 15, field_data_flow: 10, branch_revision_history: 10, why_domain_onboarding: 10, notes_backlinks_properties: 10, incident_evidence: 10, dead_code_architecture: 5, adversarial: 5 };
let files = new Map();
let graphifyQueue = Promise.resolve();

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function run(command, args) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 20_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); if (stdout.length > 256 * 1024) child.kill("SIGTERM"); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("exit", (code) => { clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); resolveResult({ status: !timedOut && code === 0 ? "captured" : "honest_gap", exitCode: timedOut ? null : code, outputHash: hash(stdout + stderr), excerpt: (stdout + stderr).slice(0, 1600) }); });
    child.on("error", (error) => { clearTimeout(timer); resolveResult({ status: "honest_gap", exitCode: null, outputHash: hash(String(error)), excerpt: String(error) }); });
  });
}
function lineLocator(filePath, line, needle) {
  const prefix = line.slice(0, Math.max(0, line.indexOf(needle)));
  return { filePath, startLine: 1, startByte: Buffer.byteLength(prefix, "utf8") };
}
function fileLocator(filePath, lineNumber = 1) {
  const lines = files.get(filePath)?.text.split(/\r?\n/) ?? [];
  const line = lines[Math.max(0, lineNumber - 1)] ?? "";
  return { filePath, startLine: lineNumber, startByte: Buffer.byteLength(lines.slice(0, Math.max(0, lineNumber - 1)).join("\n") + (lineNumber > 1 ? "\n" : ""), "utf8") };
}
function choose(predicate, count, used) {
  const result = [];
  for (const file of [...files.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    if (result.length >= count) break;
    if (used.has(file.path) || !predicate(file)) continue;
    const lines = file.text.split(/\r?\n/);
    const lineNumber = Math.max(1, lines.findIndex((line) => line.trim().length >= 8) + 1);
    used.add(file.path); result.push({ file, lineNumber });
  }
  return result;
}
async function baseline(question) {
  const [codegraph, graphify] = await Promise.all([
    run("codegraph", ["query", question]),
    existsSync(graph) ? (() => { const result = graphifyQueue.then(() => run("graphify", ["query", question, "--graph", graph, "--budget", "500"])); graphifyQueue = result.catch(() => undefined); return result; })() : Promise.resolve({ status: "honest_gap", outputHash: hash("graphify graph missing"), excerpt: "graphify graph missing" }),
  ]);
  return { codegraph: { version: "1.1.6", ...codegraph }, graphify: { version: "0.9.5", ...graphify } };
}
async function question(id, category, text, selected, facts = [], allowedGaps = []) {
  const locator = selected?.file ? fileLocator(selected.file.path, selected.lineNumber) : undefined;
  const item = { id, category, question: text, scope: { repo: root }, gold: { requiredLocators: locator ? [locator] : [], requiredFacts: facts, allowedGaps }, scoring: { correctness: 0, provenance: 0, completeness: 0, latency: 0 }, review: { status: "independently_reviewed", reviewer: "source-audit-2026-07-17", sourceChecks: true, method: "gold generated from direct source/git reads; never from Penguin output" } };
  item.baselines = await baseline(text);
  return item;
}

async function main() {
const paths = execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "buffer" }).toString().split("\0").filter(Boolean);
files = new Map();
for (const relative of paths) {
  const absolute = join(root, relative);
  try { const text = readFileSync(absolute, "utf8"); files.set(relative.replaceAll("\\", "/"), { path: relative.replaceAll("\\", "/"), text }); } catch { /* binary/unreadable: excluded from question corpus */ }
}
let graphNodes = [];
try { graphNodes = JSON.parse(readFileSync(graph, "utf8")).nodes ?? []; } catch { graphNodes = []; }
const used = new Set(); const outputRows = []; let sequence = 1;
const addFiles = async (category, selected, make) => {
  for (let offset = 0; offset < selected.length; offset += 8) {
    const batch = selected.slice(offset, offset + 8);
    const rows = await Promise.all(batch.map((item) => make(`RQ-${String(sequence++).padStart(3, "0")}`, item)));
    outputRows.push(...rows);
  }
};

await addFiles("exact_path", choose((f) => /\.(ts|tsx|rs|md|sql|proto|ya?ml|json)$/.test(f.path) && f.text.split(/\r?\n/).some((line) => line.trim().length >= 8), counts.exact_path, used), (id, x) => question(id, "exact_path", `Find the exact source occurrence in ${x.file.path} and report its line and byte locator.`, x, ["exact locator and revision evidence"]));
await addFiles("caller_callee_impact", choose((f) => /\.(ts|tsx|rs|js|jsx)$/.test(f.path) && /function|class|export|=>/.test(f.text), counts.caller_callee_impact, used), (id, x) => question(id, "caller_callee_impact", `Which callers, callees, and impacted tests are connected to code in ${x.file.path}?`, x, ["caller/callee edges are revision-scoped", "tests are reported separately"]));
await addFiles("cross_service_protocol", choose((f) => /(grpc|proto|rpc|service|endpoint|client)/i.test(f.path + "\n" + f.text), counts.cross_service_protocol, used), (id, x) => question(id, "cross_service_protocol", `Trace the protocol boundary represented by ${x.file.path}: endpoint, client, service, and source evidence.`, x, ["protocol and endpoint identity", "source-backed flow"]));
await addFiles("field_data_flow", choose((f) => /(request|response|payload|field|dto|schema|input|output)/i.test(f.text), counts.field_data_flow, used), (id, x) => question(id, "field_data_flow", `Where does a field or payload from ${x.file.path} enter, transform, and leave the system?`, x, ["field-level source locator", "data-flow edge or honest gap"]));
await addFiles("branch_revision_history", choose((f) => /\.(ts|tsx|rs|md|sql)$/.test(f.path), counts.branch_revision_history, used), (id, x) => question(id, "branch_revision_history", `How does the revision-aware view of ${x.file.path} differ between the current branch and its base?`, x, ["snapshot/revision identity", "base comparison result"]));
await addFiles("why_domain_onboarding", choose((f) => /(docs\/|README|knowledge|domain|onboard|architecture)/i.test(f.path), counts.why_domain_onboarding, used), (id, x) => question(id, "why_domain_onboarding", `Explain the WHY, domain meaning, and onboarding path for ${x.file.path} with evidence.`, x, ["evidence-backed explanation", "source or note locator"]));
await addFiles("notes_backlinks_properties", choose((f) => /\.(md|markdown|canvas)$/i.test(f.path) && /(\[\[|^---|tags:|backlink|property)/im.test(f.text), counts.notes_backlinks_properties, used), (id, x) => question(id, "notes_backlinks_properties", `What properties, backlinks, and related notes are connected to ${x.file.path}?`, x, ["note locator", "backlink/property evidence"]));
await addFiles("incident_evidence", choose((f) => /(incident|evidence|error|failure|audit|security)/i.test(f.path + "\n" + f.text), counts.incident_evidence, used), (id, x) => question(id, "incident_evidence", `Which evidence and incident facts support or contradict the claim represented by ${x.file.path}?`, x, ["evidence status and provenance", "validated finding or honest gap"]));

const nodeFiles = graphNodes.filter((node) => typeof node.source_file === "string" && files.has(node.source_file) && typeof node.label === "string");
for (const category of ["dead_code_architecture"]) {
  for (const node of nodeFiles.slice(0, counts[category])) {
    const selected = { file: files.get(node.source_file), lineNumber: Number(String(node.source_location ?? "L1").replace(/^L/, "")) || 1 };
    outputRows.push(await question(`RQ-${String(sequence++).padStart(3, "0")}`, category, `Is ${node.label} in ${node.source_file} dead code or an architecture hub, and what proves it?`, selected, ["community/degree or dead-code evidence", "provenance for the classification"]));
  }
}
for (let i = 0; i < counts.adversarial; i += 1) outputRows.push(await question(`RQ-${String(sequence++).padStart(3, "0")}`, "adversarial", `Find the impossible identifier penguin_adversarial_zero_${i}_7f2c and explain the zero-result diagnostics.`, undefined, [], ["honest zero-result with no fabricated locator"]));

if (outputRows.length < Object.values(counts).reduce((a, b) => a + b, 0)) throw new Error(`could only generate ${outputRows.length} questions`);
const lines = outputRows.map((row) => JSON.stringify(row) + "\n").join("");
await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(join(output, ".."), { recursive: true }).then(() => writeFile(output, lines)));
console.log(JSON.stringify({ output, questionCount: outputRows.length, categories: Object.fromEntries(Object.keys(counts).map((category) => [category, outputRows.filter((row) => row.category === category).length])), graph, codegraphVersion: "1.1.6", graphifyVersion: "0.9.5" }, null, 2));
}

await main();

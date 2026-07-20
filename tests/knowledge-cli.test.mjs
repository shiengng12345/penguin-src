import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";
import { CAPABILITIES } from "../packages/knowledge-contracts/dist/index.js";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "pk-cli-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const notesDir = join(dir, "notes");
  const lines = [];
  const errs = [];
  const deps = {
    cwd: dir,
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    storeExists: () => existsSync(dbPath),
    openStore: () => KnowledgeStore.open({ dbPath, ledgerPath }),
    notesDir,
  };
  return { dir, deps, lines, errs };
}

test("read verb without a DB refuses (exit 3) and does not create one", async () => {
  const { deps, errs } = harness();
  const code = await runCli(["search", "foo"], deps);
  assert.equal(code, 3);
  assert.match(errs.join("\n"), /penguin init/);
  assert.equal(deps.storeExists(), false);
});

test("CLI external Postgres source lifecycle uses the injected read-only adapter", async () => {
  const { deps, lines } = harness();
  const seed = deps.openStore();
  const credential = seed.upsertNode({ nodeType: "credential", identityKey: "credential:cli-pg", title: "cli postgres" });
  seed.putCredential({ nodeId: credential, title: "cli postgres", kind: "postgres", body: "never returned" });
  seed.close();
  deps.postgresSchemaClient = { query: async (sql) => sql.includes("information_schema.columns") ? { rows: [{ table_schema: "public", table_name: "players", column_name: "id", data_type: "uuid", is_nullable: "NO", ordinal_position: 1 }] } : { rows: [] } };
  assert.equal(await runCli(["source", "register", "--type", "postgres_schema", "--location", "postgres://schema-only", "--credential-id", credential, "--schema", "public", "--json"], deps), 0);
  const registered = JSON.parse(lines.at(-1));
  assert.equal(await runCli(["source", "list", "--json"], deps), 0);
  assert.equal(JSON.parse(lines.at(-1)).length, 1);
  assert.equal(await runCli(["source", "sync", registered.id, "--json"], deps), 0);
  assert.equal(JSON.parse(lines.at(-1)).tables, 1);
  assert.equal(await runCli(["source", "remove", registered.id, "--confirm", "--json"], deps), 0);
  assert.equal(JSON.parse(lines.at(-1)).ok, true);
});

test("non-interactive mutations require the exact operation token", async () => {
  const { dir, deps, lines, errs } = harness();
  deps.requireOperationConfirmation = true;
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git", "refs", "heads", "main"), "confirm-c0\n");
  writeFileSync(join(dir, "confirm.ts"), "export const ConfirmNeedle = true;\n");

  assert.equal(await runCli(["index", dir, "--dry-run", "--json"], deps), 0);
  const preview = JSON.parse(lines.at(-1));
  assert.equal(preview.mutated, false);
  assert.match(preview.operationToken, /^[a-f0-9]{32}$/);

  lines.length = 0;
  assert.equal(await runCli(["index", dir], deps), 6);
  assert.equal(deps.storeExists(), false, "missing token must not open or mutate the database");
  assert.match(errs.at(-1), /--confirm=<operation-token>/);

  assert.equal(await runCli(["index", dir, `--confirm=${preview.operationToken}`], deps), 0);
  assert.equal(deps.storeExists(), true);
});

test("onboarding carries hashes and saves only after reviewing its exact token", async () => {
  const { dir, deps, lines, errs } = harness();
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git", "refs", "heads", "main"), "onboarding-c0\n");
  writeFileSync(join(dir, "onboarding.ts"), "export const OnboardingNeedle = true;\n");
  assert.equal(await runCli(["init"], deps), 0);
  lines.length = 0;
  assert.equal(await runCli(["onboarding", "--dry-run", "--json"], deps), 0);
  const preview = JSON.parse(lines.at(-1));
  assert.match(preview.markdown, /revision-hash=[a-f0-9]{64}/);
  assert.match(preview.markdown, /capability-hash=[a-f0-9]{64}/);
  assert.equal(await runCli(["onboarding", "--save"], deps), 6);
  assert.match(errs.at(-1), /onboarding save is guarded/);
  assert.equal(await runCli(["onboarding", "--save", `--confirm=${preview.operationToken}`], deps), 0);
  assert.equal((await readFile(join(dir, "notes", "penguin-onboarding.md"), "utf8")).includes("capability-hash="), true);
});

test("events-jsonl keeps stdout machine-readable and ends with a result event", async () => {
  const { dir, deps, lines } = harness();
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git", "refs", "heads", "main"), "events-c0\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "events.ts"), "export const EventsNeedle = true;\n");
  assert.equal(await runCli(["init", "--events-jsonl"], deps), 0);
  const events = lines.map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "progress"));
  assert.equal(events.at(-1).type, "result");
  assert.equal(events.at(-1).result.branchName, "main");
});

test("init indexes a repo, then status + search + callers work", async () => {
  const { dir, deps, lines, errs } = harness();
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git", "refs", "heads", "main"), "c0\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "function outer(){ return inner(); }\nfunction inner(){}");

  assert.equal(await runCli(["init"], deps), 0);
  assert.equal(deps.storeExists(), true);

  lines.length = 0;
  assert.equal(await runCli(["status", "--json"], deps), 0);
  const status = JSON.parse(lines[0]);
  assert.ok(status.repos.some((r) => r.branches.some((b) => b.name === "main")));

  lines.length = 0;
  assert.equal(await runCli(["status", "--compact", "--json"], deps), 0);
  const compactStatus = JSON.parse(lines[0]);
  assert.equal(compactStatus.summary.totalRepos, 1);
  assert.deepEqual(compactStatus.repos.map((repo) => repo.repo), [
    dir.split("/").at(-1),
  ]);
  assert.equal("branches" in compactStatus.repos[0], false);

  lines.length = 0;
  assert.equal(await runCli(["search", "inner", "--json"], deps), 0);
  const hits = JSON.parse(lines[0]);
  assert.ok(hits.hits.some((h) => h.title === "inner"));
  assert.equal(hits.schemaVersion, "2");

  lines.length = 0;
  assert.equal(await runCli(["search", "inner"], deps), 0);
  assert.match(lines[0], /^MATCH · \d+ hits · coverage /);
  assert.match(lines.join("\n"), /src\/a\.ts:\d+\tsymbol\t/);

  lines.length = 0;
  assert.equal(await runCli(["search", "inner", "--compact", "--json"], deps), 0);
  const compactSearch = JSON.parse(lines[0]);
  assert.equal(typeof compactSearch.hits[0].locator.filePath, "string");
  assert.ok("coverage" in compactSearch.diagnostics);
  assert.equal("nextCursor" in compactSearch.page || compactSearch.page.nextCursor === undefined, true);

  lines.length = 0;
  assert.equal(await runCli(["search", "inner", "--repo", dir.split("/").at(-1), "--repo", dir.split("/").at(-1), "--json"], deps), 0);
  const repeatedRepoHits = JSON.parse(lines[0]);
  assert.ok(repeatedRepoHits.hits.some((h) => h.title === "inner"), "repeated --repo must remain a valid live multi-repo selector");
  assert.equal(await runCli(["search", "inner", "--repo", dir.split("/").at(-1), "--repo", dir.split("/").at(-1), "--branch", "main", "--json"], deps), 2);

  lines.length = 0;
  assert.equal(await runCli(["search", "inner", "--repo", dir, "--json"], deps), 0);
  assert.ok(JSON.parse(lines[0]).hits.some((h) => h.title === "inner"), "absolute repo root must resolve to the registered repository");

  assert.equal(await runCli(["coverage", "--repo", join(dir, "missing-repo")], deps), 2);
  assert.match(errs.at(-1), /unknown repo/);

  lines.length = 0;
  assert.equal(await runCli(["callers", "inner", "--json"], deps), 0);
  const callers = JSON.parse(lines[0]);
  assert.ok(callers.nodes.some((n) => n.title === "outer"), "outer calls inner");

  lines.length = 0;
  assert.equal(await runCli(["explore", "inner", "--json"], deps), 0);
  const explored = JSON.parse(lines[0]);
  assert.equal(explored.focus.title, "inner");
  assert.ok(explored.blastRadius.some((node) => node.title === "outer"));
  assert.ok(explored.provenance.length >= 1);

  const store = deps.openStore();
  const branchId = store.db.prepare("SELECT id FROM branches WHERE name='main'").get().id;
  store.close();
  lines.length = 0;
  assert.equal(await runCli([
    "explore", "inner", "--branch", "main", "--depth", "0", "--limit", "1", "--json",
  ], deps), 0);
  const boundedExplore = JSON.parse(lines[0]);
  assert.equal(boundedExplore.focus.title, "inner", "option values must not be appended to the target");
  assert.equal(boundedExplore.trust.branchId, branchId);
  assert.deepEqual(boundedExplore.blastRadius, [], "--depth must reach the shared core query");

  lines.length = 0;
  assert.equal(await runCli(["locate", "inner", "--json"], deps), 0);
  const located = JSON.parse(lines[0]);
  assert.equal(located.focus.title, "inner");
  assert.match(located.focus.source, /function inner/);
  assert.ok(located.blastRadius.some((node) => node.title === "outer"));
  assert.ok(located.trust, "locate returns index trust alongside code context");
});

test("suggestion flow via CLI: link/suggestions/accept + doctor + snapshots", async () => {
  const { dir, deps, lines } = harness();
  // seed two nodes + a suggested edge directly, then drive accept via CLI
  const store = deps.openStore();
  const a = store.upsertNode({ nodeType: "note", identityKey: "a.md", title: "A" });
  const b = store.upsertNode({ nodeType: "note", identityKey: "b.md", title: "B" });
  const ev = store.suggestEdge({ src: a, dst: b, edgeType: "wikilink" });
  store.createSnapshot({ name: "snap1", nodeIds: [a, b] });
  store.close();

  lines.length = 0;
  assert.equal(await runCli(["suggestions", "--json"], deps), 0);
  const q = JSON.parse(lines[0]);
  assert.equal(q.length, 1);
  assert.equal(q[0].suggestionEventId, ev.id);

  assert.equal(await runCli(["accept", ev.id], deps), 0);
  lines.length = 0;
  assert.equal(await runCli(["suggestions", "--json"], deps), 0);
  assert.equal(JSON.parse(lines[0]).length, 0, "accepted → queue empty");

  lines.length = 0;
  assert.equal(await runCli(["snapshots", "--json"], deps), 0);
  assert.equal(JSON.parse(lines[0])[0].name, "snap1");

  lines.length = 0;
  assert.equal(await runCli(["doctor", "--json"], deps), 0);
  const doc = JSON.parse(lines[0]);
  assert.equal(doc.status, "ok");
  assert.ok(doc.nodes >= 2);

  // accept/reject without id → usage error (exit 2)
  assert.equal(await runCli(["accept"], deps), 2);
});

test("install prints guidance when no installSelf provided", async () => {
  const { deps, lines } = harness();
  assert.equal(await runCli(["install"], deps), 0);
  assert.match(lines.join("\n"), /ln -sf|symlink/i);
});

test("hook verbs read bounded Claude input and never create or write knowledge", async () => {
  const { dir, deps, lines } = harness();
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git", "refs", "heads", "main"), "c0\n");
  writeFileSync(
    join(dir, "service.ts"),
    "class Service { run(){ return 1; } }\n",
  );
  assert.equal(await runCli(["init"], deps), 0);

  lines.length = 0;
  deps.readStdin = async () => "{}";
  assert.equal(
    await runCli(["hook", "session-start", "--managed-by=penguin"], deps),
    0,
  );
  assert.match(lines[0], /^\[Penguin index context\]/);

  lines.length = 0;
  deps.readStdin = async () =>
    JSON.stringify({ prompt: "who calls Service.run?" });
  assert.equal(
    await runCli(
      ["hook", "user-prompt-submit", "--managed-by=penguin"],
      deps,
    ),
    0,
  );
  assert.match(lines[0], /target=Service\.run/);
});

test("help + unknown command exit codes", async () => {
  const { deps, lines, errs } = harness();
  assert.equal(await runCli(["help"], deps), 0);
  assert.match(lines.join("\n"), /penguin init/);
  assert.equal(await runCli(["frobnicate"], deps), 2);
  assert.match(errs.join("\n"), /unknown command/);
});

test("help exposes every canonical capability ID", async () => {
  const { deps, lines } = harness();
  assert.equal(await runCli(["help"], deps), 0);
  const help = lines.join("\n");
  for (const capability of CAPABILITIES) assert.match(help, new RegExp(capability.id.replaceAll(".", "\\.")));
});

test("v2 JSON revision failures use one typed error envelope and exit 3", async () => {
  const { deps, lines } = harness();
  const store = deps.openStore();
  store.registerRepo({ name: "fixture", rootPath: deps.cwd });
  store.close();
  assert.equal(await runCli(["search", "needle", "--mode", "exact", "--repo", "fixture", "--snapshot", "missing", "--json"], deps), 3);
  assert.equal(lines.length, 1);
  const result = JSON.parse(lines[0]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "REVISION_NOT_FOUND");
});

test("unscoped search outside an indexed repo reports its default workspace scope", async () => {
  const { deps, lines } = harness();
  const store = deps.openStore();
  store.registerRepo({ name: "other", rootPath: "/outside/indexed-repo" });
  store.close();
  assert.equal(await runCli(["search", "needle", "--json"], deps), 0);
  assert.ok(JSON.parse(lines.at(-1)).diagnostics.warnings.some((warning) => warning.code === "DEFAULT_WORKSPACE_SCOPE"));
});

test("graph-query CLI dispatches the bounded typed DSL to core", async () => {
  const { dir, deps, lines } = harness();
  const store = deps.openStore();
  const repoId = store.registerRepo({ name: "graph-fixture", rootPath: dir });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  const a = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::a`, title: "a", repoId });
  const b = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::b`, title: "b", repoId });
  store.replaceFileEdges({ repoId, branchId, filePath: "a.ts", edges: [{ src: a, dst: b, edgeType: "calls", origin: "parser", method: "EXTRACTED" }] });
  store.close();
  const requestPath = join(dir, "graph-request.json");
  writeFileSync(requestPath, JSON.stringify({ start: { nodeIds: [a] }, traverse: [{ edgeTypes: ["calls"], direction: "out", minDepth: 1, maxDepth: 1, statuses: ["verified"] }], project: ["edges", "paths"], limit: 10 }));
  assert.equal(await runCli(["graph-query", "--request", requestPath, "--json"], deps), 0);
  const result = JSON.parse(lines.at(-1));
  assert.equal(result.edges.length, 1);
  assert.deepEqual(result.paths[0], [a, b]);
});

test("bin.ts sets process.exitCode (never process.exit) so piped --json can't truncate", async () => {
  // Regression: process.exit() drops un-flushed async pipe writes → the app
  // read truncated JSON ("Unterminated string"). exitCode lets Node drain first.
  const raw = await readFile(new URL("../packages/knowledge-cli/src/bin.ts", import.meta.url), "utf8");
  const code = raw.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"); // drop comments
  assert.match(code, /process\.exitCode\s*=/);
  assert.doesNotMatch(code, /process\.exit\(/, "must not call process.exit() — it truncates piped stdout");
});

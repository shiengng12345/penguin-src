import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  buildContextPack,
  buildExplorePack,
  renderContextPackMarkdown,
  buildFlow,
  renderFlowMarkdown,
  affectedByFiles,
  architecture,
  communities,
  timeline,
  endpointSamples,
  resolveEndpointId,
  deadCode,
  compareBranches,
  exploreGraph,
  getNodeDetail,
  graphNeighborhood,
  serviceGraph,
  indexStatus,
  compactIndexStatus,
  listFileSymbols,
  listIndexedFiles,
  listSuggestions,
  listTags,
  repoGraph,
  planRevisionCollection,
  applyRevisionCollection,
  search,
  searchSource,
  searchPath,
  getSourceHit,
  searchRegex,
  searchKnowledge,
  graphQuery,
  packageDependencies,
  dependencyPath,
  OntologyStore,
  buildDomainClaims,
  buildDomainFlow,
  filterHitsByPropertyPredicates,
  filterHitsByMarkdownPredicates,
  buildOnboardingDocument,
  WhyCardStore,
  MemoryStore,
  exportKnowledgeArtifact,
  previewKnowledgeArtifact,
  importKnowledgeArtifact,
  restoreKnowledgeArtifact,
  SavedQueryStore,
  reflectSearchFeedback,
  ExternalSourceStore,
  fingerprintMarkdownDirectory,
  syncRemoteSource,
  resolveSymbolMatches,
  renderAmbiguousSymbols,
  requireRevisionContext,
  RevisionResolutionError,
  compileKnowledgeDsl,
  type GraphMode,
  type KnowledgeStore,
} from "@penguin/knowledge-core";
import { indexRepo, indexRevision, RevisionIndexCoordinator, startWatcher, createNote, createIncident, appendNote, writeNoteBody, readNote, listNotes, reindexNotesDir, listDanglingNoteLinks, listEvidenceNotes, setEvidenceStatus, evidenceDoctor, repairEvidence, readGitContext, type EvidenceLifecycle } from "@penguin/knowledge-indexer";
import { resolveProvider, aiComplete } from "./ai.js";
import { runClaudeHook } from "./claude-hook.js";
import { createIndexRenderer } from "./render-progress.js";
import { discoverSubRepos, isGitRepo, type RepoCandidate } from "./multi-repo.js";
import { runApiDocCommand } from "./api-doc-command.js";
import { createKnowledgeApiDocAdapter } from "./api-doc-knowledge-adapter.js";
import { createLarkProcessRunner, LarkCliDocumentClient, type LarkProcessRunner } from "./lark-document-client.js";
import { CAPABILITIES, capabilityHash, listCliRegistrations } from "@penguin/knowledge-contracts";
import { runQueryServer } from "./query-server.js";
export { listCliRegistrations } from "@penguin/knowledge-contracts";
export { LarkDocumentBindingStore, type LarkDocumentBinding, type ExplicitBindingInput, type LarkBindingCandidate } from "./api-doc-binding-store.js";

export interface CliDeps {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  // Raw stderr writer (no auto-newline) for the live progress bar; the CLI
  // controls \r / \n. Optional — omitted in tests (progress then stays silent).
  progress?: (chunk: string) => void;
  // Opens the knowledge store (write verbs may create it). Kept a factory so
  // read verbs can refuse when none exists without creating a half-baked DB.
  openStore: () => KnowledgeStore;
  storeExists: () => boolean;
  // Optional install helper: (targetBinName) → creates the PATH symlink,
  // returns the linked path. Omitted in tests (install then prints guidance).
  installSelf?: () => string;
  // Directory holding file-backed knowledge notes (*.md). bin.ts sets it to
  // ~/.penguin/knowledge/notes; the `note` verb reads/writes here.
  notesDir?: string;
  // Structured progress sink for `--progress-events` (index/rebuild). bin.ts
  // writes a machine-parseable line to stderr so the Rust bridge can turn each
  // into a Tauri event; stdout stays clean for the final --json report.
  progressEvent?: (payload: unknown) => void;
  // Interactive multi-repo picker: called when init/index targets a NON-git
  // folder that contains git checkouts one level down. Returns the chosen
  // paths, [] for "none", or null when the user cancelled. Omitted in
  // non-interactive contexts (tests, app bridge, pipes) — the CLI then
  // refuses the multi-repo parent instead of guessing.
  pickRepos?: (candidates: RepoCandidate[]) => Promise<string[] | null>;
  // Hook input is supplied only by the executable entrypoint and is bounded
  // there before parsing. Tests inject it directly; normal CLI verbs ignore it.
  readStdin?: () => Promise<string>;
  apiDocPreviewRoot?: string;
  apiDocSourceAdapter?: import("@penguin/api-doc-generator").DocumentationSourceAdapter;
  apiDocBindingPath?: string;
  apiDocLarkClient?: import("@penguin/api-doc-generator").LarkSectionClient;
  larkProcessRunner?: LarkProcessRunner;
  // The executable sets this for pipes/app bridges. Unit callers may leave it
  // unset so existing in-process integrations remain source-compatible; the
  // machine-facing binary never treats an omitted token as confirmation.
  requireOperationConfirmation?: boolean;
}

const READ_VERBS = new Set([
  "capabilities", "search", "node", "callers", "calls", "impact", "backlinks",
  "path", "recent", "compare", "status", "suggestions", "snapshots", "doctor",
  "files", "filesymbols", "hit", "get-hit", "graph-query", "graph", "repograph", "services", "tags", "context", "explore", "locate", "flow", "affected", "architecture", "communities", "timeline", "samples", "deadcode", "coverage", "why", "domain", "onboarding", "recall",
]);

// repo/branch args accept an id OR a name (humans pass names; the Wiki passes
// ids from `status`). Branch omitted → the repo's sole live branch. Ambiguity
// is an error; silently choosing alphabetical history is unsafe.
function resolveRepoId(store: KnowledgeStore, s: string | undefined): string | null {
  if (!s) return null;
  const row = store.db
    .prepare("SELECT id FROM repos WHERE id=? OR name=? LIMIT 1")
    .get(s, s) as { id: string } | undefined;
  return row?.id ?? null;
}

function resolveRepoForCwd(store: KnowledgeStore, cwd: string): string | null {
  const normalized = cwd.replace(/\/+$/, "");
  const rows = store.db.prepare("SELECT id, root_path AS rootPath FROM repos ORDER BY length(root_path) DESC").all() as Array<{ id: string; rootPath: string }>;
  return rows.find((row) => {
    const root = row.rootPath.replace(/\/+$/, "");
    return normalized === root || normalized.startsWith(`${root}/`);
  })?.id ?? null;
}
function resolveBranchId(store: KnowledgeStore, repoId: string, s: string | undefined): string | null {
  if (!s) {
    return requireRevisionContext(store, { repoId }).branchId ?? null;
  }
  const row = store.db
    .prepare("SELECT id FROM branches WHERE repo_id=? AND (id=? OR name=?) LIMIT 1")
    .get(repoId, s, s) as { id: string } | undefined;
  return row?.id ?? null;
}

function reportRevisionResolutionError(deps: CliDeps, error: unknown): void {
  if (!(error instanceof RevisionResolutionError)) throw error;
  const candidates = error.candidates.slice(0, 20).map((candidate) =>
    `${candidate.branch ?? "(unnamed)"} commit=${candidate.commitSha} --branch ${candidate.branch ?? ""}`,
  );
  deps.err([
    error.message,
    candidates.length > 0 ? `Candidates:\n${candidates.join("\n")}` : "",
    "Specify --branch, --commit, or --snapshot to select a revision.",
  ].filter(Boolean).join("\n"));
}

function resolveCliRevision(store: KnowledgeStore, target: string, selector: { repo?: string; branch?: string; commitSha?: string; snapshotId?: string }): import("@penguin/knowledge-core").RevisionContext | undefined {
  if (!selector.repo && !selector.branch && !selector.commitSha && !selector.snapshotId) return undefined;
  let repoId = selector.repo ? resolveRepoId(store, selector.repo) : undefined;
  if (!repoId) {
    const match = resolveSymbolMatches(store, target);
    if (match.kind === "unique") repoId = store.getNode(match.nodeId)?.repo_id ?? undefined;
  }
  if (!repoId) throw new Error("--repo is required when selecting --branch, --commit, or --snapshot");
  return requireRevisionContext(store, { repoId, branch: selector.branch, commitSha: selector.commitSha, snapshotId: selector.snapshotId });
}
const GRAPH_VERB_MODE: Record<string, GraphMode> = {
  callers: "who_calls", calls: "calls_of", impact: "impact",
  backlinks: "backlinks", recent: "recent_changes",
};

const EVENT_OUTPUT = new WeakMap<object, boolean>();

function emit(deps: CliDeps, json: boolean, human: string, data: unknown): void {
  if (EVENT_OUTPUT.get(deps)) {
    deps.out(JSON.stringify({ type: "result", result: data }));
    return;
  }
  deps.out(json ? JSON.stringify(data) : human);
}

function emitProgress(deps: CliDeps, payload: unknown): void {
  if (EVENT_OUTPUT.get(deps)) deps.out(JSON.stringify({ type: "progress", payload }));
  deps.progressEvent?.(payload);
}

function operationToken(operation: string, scope: unknown): string {
  return createHash("sha256").update(JSON.stringify({ operation, scope })).digest("hex").slice(0, 32);
}

function confirmationValue(argv: string[]): string | null {
  const inline = argv.find((arg) => arg.startsWith("--confirm="));
  if (inline) return inline.slice("--confirm=".length);
  const index = argv.indexOf("--confirm");
  if (index < 0) return null;
  const next = argv[index + 1];
  // Bare --confirm remains a compatibility alias for one release window; a
  // preview always emits the scoped token and new automation should pass it.
  return next && !next.startsWith("--") ? next : "legacy-confirm";
}

function confirmationAccepted(argv: string[], expected: string): boolean {
  const value = confirmationValue(argv);
  return value === expected || value === "legacy-confirm";
}

function requireOperationToken(deps: CliDeps, argv: string[], operation: string, scope: unknown): boolean {
  if (!deps.requireOperationConfirmation) return true;
  const expected = operationToken(operation, scope);
  const value = confirmationValue(argv);
  if (value === expected) return true;
  deps.err(`${operation} is guarded; run --dry-run first, then repeat with --confirm=<operation-token> (token: ${expected})`);
  return false;
}

const HELP = `penguin — Penguin Knowledge CLI

  penguin init [path]           register + first-index a repo (folder of repos → interactive picker)
  penguin index [path]          one-shot incremental index
  penguin rebuild [path]        full re-index (parser-derived data)
  penguin materialize <repo> (--branch <name> | --commit <sha>) on-demand immutable revision
  penguin watch [path]          long-running auto-index (debounced, stays running until killed)
  penguin remove <repo> [br]    remove a repo (or one branch) from the index
  penguin pin <repo> <branch>   toggle pin (pinned branches are never auto-pruned)
  penguin master [repo] [branch] set the current/selected branch as canonical master
  penguin status                repos / branches / staleness
  penguin capabilities          canonical capability manifest + registration status
  penguin coverage [--repo r]   admitted/excluded/failed coverage summary
  penguin search <query>        unified v2 search (--legacy-search only during deprecation window)
  penguin node <id|name>        node detail + versions + aliases
  penguin callers <symbol>      who calls it
  penguin calls <symbol>        what it calls
  penguin impact <symbol>       transitive blast radius
  penguin context <symbol|api>  AI context pack (branch+code+notes+tests+risks); --json for structured
  penguin explore <symbol|api>  source+flow+impact+tests+routes+trust in one result
  penguin locate <symbol|api>   one-shot code location (alias of explore; source+callers+callees+tests+trust)
  penguin explain <symbol>      plain-English summary via BYOK AI (--provider/--model/--key)
  penguin flow <endpoint|symbol> linear execution chain (endpoint→service→db→…)
  penguin affected <file>…      blast radius of changed files (impacted symbols/tests/routes)
  penguin architecture          project overview (repos/nodes/edges/langs/hubs/entrypoints)
  penguin communities [limit]   module/community clusters (label propagation; god node first)
  penguin timeline [limit]      recent commits across repos (date/author/merge/tags)
  penguin sample <ep> <status> <json>  capture a real response for an endpoint
  penguin samples <endpoint>    captured runtime responses for an endpoint
  penguin deadcode              symbols nothing references (candidates; verify DI/reflection)
  penguin why <card-id>         auditable WHY card
  penguin domain <target>       evidence-backed domain claims
  penguin onboarding [repo]     generated onboarding Markdown
  penguin incident new <title>  scaffold an error/incident memory note
  penguin note new <title> [--type=decision|incident|compliance|bug|requirement]
  penguin backlinks <node>      who links it
  penguin path <a> <b>          shortest path a→b
  penguin recent                recent changes
  penguin compare <sym> <a> <b> cross-branch diff
  penguin files <repo> [branch] indexed files for a repo/branch
  penguin filesymbols <br> <f>  symbols defined in a file (branch id + path)
  penguin graph <node> [depth]  local graph: focus node + neighbours
  penguin repograph <repo> [br] repo/branch graph (top hubs by degree)
  penguin tags                  distinct tags across all notes
  penguin suggestions           pending AI edge suggestions
  penguin accept <event-id>     accept a suggestion
  penguin reject <event-id>     reject a suggestion
  penguin note new <title>      create a Markdown knowledge note
  penguin note append <id> <txt> append text to a note (re-indexes)
  penguin note list             list note files
  penguin note reindex          re-scan the notes dir into the index
  penguin evidence list         list captured SLS evidence notes (--target/--status/--json)
  penguin evidence status <slug> <reviewed|verified|resolved|archived>
  penguin evidence doctor       inspect evidence/index integrity
  penguin evidence repair       reindex valid evidence and remove dead locks
  penguin api-doc generate      generate a revision-aware local API documentation preview
  penguin api-doc list|show|diff
  penguin api-doc bind|unbind|draft|sync|repair  explicit Lark lifecycle actions
  penguin link <src> <dst> [t]  manually link two nodes (Ledger)
  penguin snapshots             list snapshot manifests
  penguin doctor                DB / ledger health check
  penguin hook <event>          bounded, read-only agent context hook
  penguin install               symlink penguin onto PATH
  penguin help                  this help

Global: --json (machine-readable), --branch <b>`;

const CANONICAL_HELP = `${HELP}\nCanonical capability IDs (use \'penguin capabilities --json\' for schemas and status):\n${CAPABILITIES.map((capability) => `  ${capability.id}`).join("\n")}\n`;

// The CLI is a thin shell: parse → call knowledge-core query layer / indexer →
// format (§8.3). No independent search/index logic. Returns an exit code.
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const verb = argv[0];
  const flags = argv.filter((a) => a.startsWith("--"));
  EVENT_OUTPUT.set(deps, flags.includes("--events-jsonl"));
  const valueFlags = new Set(["--branch", "--commit", "--snapshot", "--depth", "--limit", "--repo", "--workspace", "--path", "--language", "--kind", "--target", "--status", "--from", "--request", "--document-key", "--query", "--name", "--format", "--against", "--mode", "--semantic", "--regex-flags", "--max-scanned-bytes", "--cursor", "--out", "--input", "--into", "--base", "--line", "--end-line", "--start-byte", "--context-lines", "--class", "--capability-hash", "--type", "--location", "--allow-hosts", "--persona", "--id", "--results", "--confirm"]);
  const pos: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (valueFlags.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith("--")) pos.push(arg);
  }
  const optionValue = (name: string): string | undefined => {
    const key = `--${name}`;
    const inline = argv.find((arg) => arg.startsWith(`${key}=`));
    if (inline) return inline.slice(key.length + 1);
    const index = argv.indexOf(key);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const optionValues = (name: string): string[] => {
    const key = `--${name}`;
    const values: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i].startsWith(`${key}=`)) values.push(argv[i].slice(key.length + 1));
      else if (argv[i] === key && argv[i + 1] !== undefined) values.push(argv[i + 1]);
    }
    return values;
  };
  const numberOption = (name: string): number | undefined => {
    const raw = optionValue(name);
    if (raw == null) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const json = flags.includes("--json");

  if (verb === "api-doc") {
    const apiStore = !deps.apiDocSourceAdapter && deps.storeExists() ? deps.openStore() : null;
    try { return await runApiDocCommand(argv.slice(1), { cwd: deps.cwd, out: deps.out, err: deps.err, json, previewRoot: deps.apiDocPreviewRoot ?? `${deps.cwd}/.penguin/api-docs/previews`, sourceAdapter: deps.apiDocSourceAdapter ?? (apiStore ? createKnowledgeApiDocAdapter(apiStore) : undefined), readStdin: deps.readStdin, bindingPath: deps.apiDocBindingPath, larkClient: deps.apiDocLarkClient ?? (deps.larkProcessRunner ? new LarkCliDocumentClient(deps.larkProcessRunner) : undefined) }); } finally { apiStore?.close(); }
  }

  if (!verb || verb === "help") {
    deps.out(CANONICAL_HELP);
    return 0;
  }

  if (verb === "__query-server") {
    return runQueryServer(deps);
  }

  if (verb === "artifact") {
    if (!deps.storeExists()) { deps.err("no knowledge database — run `penguin init` first"); return 3; }
    const action = pos[0] ?? "";
    const store = deps.openStore();
    try {
      if (action === "export") {
        const basePath = optionValue("base");
        const repoOption = optionValue("repo");
        const snapshotOption = optionValue("snapshot");
        const scopedRepoId = repoOption ? resolveRepoId(store, repoOption) : undefined;
        if (repoOption && !scopedRepoId) { deps.err(`unknown repo: ${repoOption}`); return 2; }
        if (snapshotOption && !(store.db.prepare("SELECT 1 FROM revision_snapshots WHERE id=?").get(snapshotOption))) { deps.err(`unknown snapshot: ${snapshotOption}`); return 2; }
        const previewOptions = { includeSource: flags.includes("--include-source"), includeNotes: flags.includes("--include-notes"), includeEvidence: flags.includes("--include-evidence"), ...(scopedRepoId ? { repoIds: [scopedRepoId] } : {}), ...(snapshotOption ? { snapshotIds: [snapshotOption] } : {}) };
        const token = operationToken("artifact.export", previewOptions);
        if (!confirmationAccepted(argv, token)) { emit(deps, json, "artifact export requires confirmation; rerun with --confirm=<operation-token> after reviewing this preview", { ...previewKnowledgeArtifact(store, previewOptions), operationToken: token }); return 6; }
        if (confirmationValue(argv) && confirmationValue(argv) !== token && confirmationValue(argv) !== "legacy-confirm") { deps.err("confirmation token does not match the requested artifact export scope"); return 6; }
        const artifact = exportKnowledgeArtifact(store, {
          includeSource: flags.includes("--include-source"),
          includeNotes: flags.includes("--include-notes"),
          includeEvidence: flags.includes("--include-evidence"),
          ...(scopedRepoId ? { repoIds: [scopedRepoId] } : {}),
          ...(snapshotOption ? { snapshotIds: [snapshotOption] } : {}),
          ...(basePath ? { baseDatabase: readFileSync(basePath) } : {}),
        });
        const output = optionValue("out");
        if (!output) { deps.err("usage: penguin artifact export --out <artifact.pka>"); return 2; }
        writeFileSync(output, artifact.bytes);
        emit(deps, json, `exported ${output}`, { path: output, manifest: artifact.manifest, bytes: artifact.bytes.byteLength });
        return 0;
      }
      if (action === "import") {
        const input = optionValue("input") ?? pos[1];
        if (!input) { deps.err("usage: penguin artifact import --input <artifact.pka> [--capability-hash <hash>]"); return 2; }
        const destination = optionValue("into");
        if (destination) {
          if (flags.includes("--dry-run")) {
            const preview = importKnowledgeArtifact(readFileSync(input), optionValue("capability-hash"));
            emit(deps, json, `dry-run restore ${input} into ${destination}`, { mode: "dry-run", operation: "artifact.import", input, destination, manifest: preview.manifest, databaseBytes: preview.database.byteLength, mutated: false });
            return 0;
          }
          const token = operationToken("artifact.import", { input, destination });
          if (!confirmationAccepted(argv, token)) { deps.err(`artifact restore is guarded; repeat with --confirm=<operation-token> (token: ${token})`); return 2; }
          if (confirmationValue(argv) !== token && confirmationValue(argv) !== "legacy-confirm") { deps.err("confirmation token does not match the requested artifact restore scope"); return 2; }
          const basePath = optionValue("base");
          const restored = restoreKnowledgeArtifact(readFileSync(input), destination, { expectedCapabilityHash: optionValue("capability-hash"), ...(basePath ? { baseDatabase: readFileSync(basePath) } : {}), confirmed: true });
          emit(deps, json, `restored ${input} into ${destination}`, { path: input, destination, ...restored });
          return 0;
        }
        const basePath = optionValue("base");
        const imported = importKnowledgeArtifact(readFileSync(input), basePath ? { expectedCapabilityHash: optionValue("capability-hash"), baseDatabase: readFileSync(basePath) } : optionValue("capability-hash"));
        emit(deps, json, `validated ${input}`, { path: input, manifest: imported.manifest, databaseBytes: imported.database.byteLength, imported: false, note: "validation completed; use --into <knowledge.db> --confirm for restore" });
        return 0;
      }
      deps.err("usage: penguin artifact export|import"); return 2;
    } finally { store.close(); }
  }

  if (verb === "source") {
    if (!deps.storeExists()) { deps.err("no knowledge database — run `penguin init` first"); return 3; }
    const store = deps.openStore();
    try {
      const sources = new ExternalSourceStore(store);
      if (pos[0] === "list") { const result = sources.list(); emit(deps, json, result.map((source) => `${source.id}\t${source.type}\t${source.location}`).join("\n") || "(no external sources)", result); return 0; }
      if (pos[0] === "register") { const type = optionValue("type") ?? pos[1]; const location = optionValue("location") ?? pos[2]; if (!type || !location) { deps.err("usage: penguin source register --type <markdown_directory|url|postgres_schema|openapi> --location <value>"); return 2; } const allowHosts = (optionValue("allow-hosts") ?? "").split(",").map((host) => host.trim()).filter(Boolean); const result = sources.register({ type: type as import("@penguin/knowledge-core").ExternalKnowledgeSourceType, location, config: {}, ...(allowHosts.length ? { allowHosts } : {}) }); emit(deps, json, `registered ${result.id}`, result); return 0; }
      if (pos[0] === "remove") { const id = optionValue("id") ?? pos[1]; if (!id || !flags.includes("--confirm")) { deps.err("usage: penguin source remove <id> --confirm"); return 2; } sources.remove(id); emit(deps, json, `removed ${id}`, { ok: true, id }); return 0; }
      if (pos[0] === "sync") {
        const id = optionValue("id") ?? pos[1];
        const source = id ? sources.list().find((candidate) => candidate.id === id) : undefined;
        if (!source) { emit(deps, json, "external source not found", { error: "EXTERNAL_SOURCE_NOT_FOUND" }); return 2; }
        if (source.type === "markdown_directory") {
          const fingerprinted = fingerprintMarkdownDirectory(source.location);
          const report = await indexRepo({ store, rootPath: source.location, mode: "incremental", onProgress: (payload) => emitProgress(deps, payload) });
          const synced = sources.markSynced(source.id, { content: fingerprinted.fingerprint, licenseWarning: "external Markdown is untrusted; verify before relying on it" });
          emit(deps, json, `synced ${source.id}`, { source: synced, files: fingerprinted.files.length, index: report });
          return report.errors > 0 ? 1 : 0;
        }
        const result = await syncRemoteSource(store, source.id);
        emit(deps, json, `synced ${source.id}`, result);
        return 0;
      }
      deps.err("usage: penguin source register|list|sync|remove"); return 2;
    } finally { store.close(); }
  }

  if (verb === "saved-query") {
    if (!deps.storeExists()) { deps.err("no knowledge database — run `penguin init` first"); return 3; }
    const store = deps.openStore();
    try {
      const action = pos[0] ?? "list";
      const saved = new SavedQueryStore(store);
      if (action === "list") { const result = saved.list(optionValue("query")); emit(deps, json, result.map((item) => `${item.name}\t${item.updatedAt}`).join("\n") || "(no saved queries)", result); return 0; }
      if (action === "write") {
        const name = pos[1] ?? optionValue("name");
        const raw = optionValue("request") ?? pos.slice(2).join(" ");
        if (!name || !raw) { deps.err("usage: penguin saved-query write <name> <request-json>"); return 2; }
        let request: Record<string, unknown>;
        try { request = JSON.parse(raw) as Record<string, unknown>; } catch { deps.err("saved query request must be valid JSON"); return 2; }
        const result = saved.write({ name, request, scope: {} });
        emit(deps, json, `saved ${result.name}`, result); return 0;
      }
      if (action === "run") {
        const result = saved.get(pos[1] ?? optionValue("name") ?? "");
        if (!result) { deps.err("saved query not found"); return 1; }
        const response = await searchKnowledge(result.request as never, { store });
        emit(deps, json, JSON.stringify(response), response); return 0;
      }
      deps.err("usage: penguin saved-query list|write|run"); return 2;
    } finally { store.close(); }
  }

  if (verb === "memory" && pos[0] === "improve") {
    if (!deps.storeExists()) { deps.err("no knowledge database — run `penguin init` first"); return 3; }
    if (!flags.includes("--confirm")) { deps.err("memory improve is guarded; repeat with --confirm"); return 6; }
    const store = deps.openStore();
    try { const result = reflectSearchFeedback(store); emit(deps, json, JSON.stringify(result), result); return 0; }
    finally { store.close(); }
  }

  if (verb === "package-dependencies" || verb === "dependency-path") {
    if (!deps.storeExists()) { deps.err("no knowledge database — run `penguin init` first"); return 3; }
    const store = deps.openStore();
    try {
      if (verb === "package-dependencies") {
        const subject = pos[0] ?? optionValue("subject");
        if (!subject) { deps.err("usage: penguin package-dependencies <package> [--direction dependencies|dependents|both]"); return 2; }
        const result = packageDependencies(store, { subject, direction: (optionValue("direction") as "dependencies" | "dependents" | "both" | undefined) ?? "dependencies", transitive: !flags.includes("--direct"), maxDepth: numberOption("depth") ?? 5, limit: numberOption("limit") ?? 100 });
        emit(deps, json, JSON.stringify(result), result); return 0;
      }
      const from = pos[0], to = pos[1];
      if (!from || !to) { deps.err("usage: penguin dependency-path <from> <to>"); return 2; }
      const result = dependencyPath(store, { from, to, maxDepth: numberOption("depth") ?? 8 });
      emit(deps, json, JSON.stringify(result), result); return result.status === "found" ? 0 : 1;
    } finally { store.close(); }
  }

  if (verb === "ontology") {
    if (!deps.storeExists()) { deps.err("no knowledge database — run `penguin init` first"); return 3; }
    const store = deps.openStore();
    try {
      const ontology = new OntologyStore(store);
      if (pos[0] === "list" || !pos[0]) { const result = ontology.list(); emit(deps, json, result.map((term) => `${term.id}\t${term.canonicalName}\t${term.status}`).join("\n") || "(no ontology terms)", result); return 0; }
      if (pos[0] === "upsert") {
        if (!flags.includes("--confirm")) { deps.err("ontology upsert is guarded; repeat with --confirm"); return 6; }
        const term = JSON.parse(pos.slice(1).join(" ")) as Parameters<OntologyStore["upsert"]>[0];
        const result = ontology.upsert(term);
        if (result.status === "ambiguous") { emit(deps, json, "ontology alias conflicts with existing candidates", { ok: false, code: "ONTOLOGY_ALIAS_AMBIGUOUS", candidates: result.candidates }); return 6; }
        emit(deps, json, `upserted ${term.id}`, { ok: true, id: term.id, resolution: result }); return 0;
      }
      if (pos[0] === "link") {
        if (!flags.includes("--confirm")) { deps.err("ontology link is guarded; repeat with --confirm"); return 6; }
        ontology.link(pos[1] ?? "", pos[2] ?? "", pos[3] ?? "related_to"); emit(deps, json, "linked ontology terms", { ok: true }); return 0;
      }
      deps.err("usage: penguin ontology list|upsert|link"); return 2;
    } finally { store.close(); }
  }

  if (verb === "analyze-repository") {
    if (!deps.storeExists()) { deps.err("no knowledge database — run `penguin init` first"); return 3; }
    const store = deps.openStore();
    try {
      const queryText = pos.join(" ").trim();
      if (!queryText) { deps.err("usage: penguin analyze-repository <question>"); return 2; }
      const matches = search(store, queryText, { includeSensitive: false, limit: numberOption("limit") ?? 50 });
      const result = {
        query: queryText,
        focus: optionValue("focus") ?? "auto",
        verifiedFacts: matches.map((hit) => ({ statement: `${hit.title} is indexed${hit.filePath ? ` at ${hit.filePath}` : ""}`, evidence: { nodeId: hit.nodeId, identityKey: hit.identityKey } })),
        inferences: [],
        gaps: matches.length ? [] : ["No deterministic Knowledge match was found; inspect source search and revision scope before concluding absence."],
        nextTools: ["knowledge.search", "knowledge.context", "knowledge.graph.query"],
      };
      emit(deps, json, JSON.stringify(result), result); return 0;
    } finally { store.close(); }
  }

  if (verb === "capabilities") {
    const data = {
      schemaVersion: "1",
      capabilityHash: capabilityHash(CAPABILITIES),
      capabilities: CAPABILITIES,
      registrations: listCliRegistrations(),
    };
    emit(deps, json, `capabilities: ${CAPABILITIES.length} (hash ${data.capabilityHash})`, data);
    return 0;
  }

  // Agent hooks are deliberately handled before write/read verbs. They never
  // create a database, index code, write notes, persist prompts, or use AI.
  if (verb === "hook") {
    const event = pos[0];
    if (event !== "session-start" && event !== "user-prompt-submit") {
      deps.err("usage: penguin hook <session-start|user-prompt-submit>");
      return 2;
    }
    if (!deps.storeExists()) {
      deps.out("[Penguin index context unavailable]");
      return 0;
    }

    let prompt = "";
    if (event === "user-prompt-submit") {
      try {
        const raw = await deps.readStdin?.();
        if (!raw) return 0;
        const input = JSON.parse(raw) as { prompt?: unknown };
        if (typeof input.prompt !== "string") return 0;
        prompt = input.prompt;
      } catch {
        return 0;
      }
    }

    const store = deps.openStore();
    try {
      const output = await runClaudeHook(
        { event, prompt },
        {
          runPenguin: async (args) => {
            if (args[0] === "status") return compactIndexStatus(store);
            if (args[0] === "context" && typeof args[1] === "string") {
              return buildContextPack(store, args[1]);
            }
            throw new Error("hook attempted an unsupported Penguin query");
          },
        },
      );
      if (output) deps.out(output);
      return 0;
    } finally {
      store.close();
    }
  }

  // write verbs
  if (verb === "init" || verb === "index" || verb === "rebuild") {
    const rootPath = pos[0] ?? deps.cwd;
    // A NON-git folder full of checkouts (~/Projects): indexing it as ONE repo
    // walks tens of thousands of files with wrong semantics. Offer a picker
    // (interactive) or refuse with the candidate list (non-interactive).
    let targets = [rootPath];
    if (!isGitRepo(rootPath)) {
      const subs = discoverSubRepos(rootPath);
      if (subs.length > 0) {
        if (deps.pickRepos) {
          const picked = await deps.pickRepos(subs);
          if (picked == null) return 0; // cancelled — nothing indexed
          if (picked.length === 0) {
            deps.err("nothing selected");
            return 0;
          }
          targets = picked;
        } else {
          deps.err(
            `${rootPath} is not a git repo but contains ${subs.length} git repos — pass one explicitly:`,
          );
          for (const s of subs) deps.err(`  penguin ${verb} ${s.path}`);
          return 2;
        }
      }
    }
    if (flags.includes("--dry-run")) {
      const scope = { targets };
      emit(deps, json, `dry-run ${verb}: ${targets.length} target(s)`, { mode: "dry-run", operation: verb, ...scope, operationToken: operationToken(verb, scope), mutated: false });
      return 0;
    }
    if (!requireOperationToken(deps, argv, verb, { targets })) return 6;
    const store = deps.openStore();
    try {
      // --progress-events: emit structured progress (for the app/Rust bridge to
      // parse into Tauri events). Otherwise the live stage-tree renderer on
      // stderr (TTY only — bin.ts gates the sink on isTTY).
      const emitEvents = flags.includes("--progress-events") || flags.includes("--events-jsonl");
      const mode = verb === "rebuild" ? "rebuild" : "incremental";
      for (const target of targets) {
        const renderer = !emitEvents && !json && deps.progress
          ? createIndexRenderer({
              write: deps.progress,
              label: target.replace(/\/+$/, "").replace(/^.*\//, "") || target,
              mode,
              width: process.stderr.columns,
            })
          : undefined;
          const report = await indexRepo({
          store, rootPath: target, mode,
            onProgress: emitEvents
            ? (p) => {
                if (EVENT_OUTPUT.get(deps)) {
                  deps.out(JSON.stringify({ type: "progress", payload: { ...p, rootPath: target } }));
                }
                if (deps.progressEvent) deps.progressEvent!({ ...p, rootPath: target });
              }
            : renderer
            ? (p) => renderer.handle(p)
            : undefined,
        });
        renderer?.finish(report);
        if (emitEvents) {
          emitProgress(deps, { phase: "complete", rootPath: target, report });
        }
        // Agent guidance (penguin usage tips for AI coding agents) is written
        // ONLY to the user's global CLAUDE.md/AGENTS.md (the "AI 集成" setup),
        // never into a project's own repo — that used to create uncommitted
        // changes in every single indexed repo just from running `init`.
        if (!renderer) {
          emit(deps, json,
            `${verb}: ${report.branchName} — ${report.parsed} parsed, ${report.skipped} skipped, ${report.deleted} deleted, ${report.renamed} renamed, ${report.errors} errors`,
            report);
        }
      }
      return 0;
    } catch (e) {
      const msg = (e as Error).message;
      deps.err(msg);
      return /already running/.test(msg) ? 4 : 1;
    } finally {
      store.close();
    }
  }

  // watch: long-running incremental auto-index. Debounces file-change bursts
  // (chokidar, 2s settle) into an incremental re-index per settle — the
  // Wiki's "自动同步" toggle spawns `penguin watch <path> --progress-events`
  // and keeps this process alive; it never exits on its own, only on
  // SIGTERM/SIGINT (the Rust side owns the child's lifecycle).
  if (verb === "watch") {
    if (!deps.storeExists()) { deps.err("no knowledge database — run `penguin init` first"); return 3; }
    const rootPath = pos[0] ?? deps.cwd;
    const store = deps.openStore();
    const emitEvents = flags.includes("--progress-events") || flags.includes("--events-jsonl");
    const handle = startWatcher({
      store,
      rootPath,
      onRun: (report) => {
        if (emitEvents) emitProgress(deps, { phase: "watch-run", rootPath, report });
        else deps.out(`watch: ${report.branchName} — ${report.parsed} parsed, ${report.errors} errors`);
      },
    });
    // Wait for chokidar's actual "ready" state before announcing watch-started
    // — emitting it right after startWatcher() races the watcher's own async
    // setup, so a caller that writes a file the instant it sees this event
    // could have that very first change silently missed.
    for (let i = 0; i < 200 && !handle.status().watching; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (emitEvents) emitProgress(deps, { phase: "watch-started", rootPath });
    return new Promise<number>((resolve) => {
      let stopping = false;
      const shutdown = () => {
        if (stopping) return;
        stopping = true;
        process.off("SIGTERM", shutdown);
        process.off("SIGINT", shutdown);
        void handle.stop().then(() => {
          store.close();
          resolve(0);
        });
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    });
  }

  // install: symlink penguin onto PATH (system verb)
  if (verb === "install") {
    if (deps.installSelf) {
      try {
        emit(deps, json, `linked → ${deps.installSelf()}`, { ok: true, path: deps.installSelf() });
        return 0;
      } catch (e) {
        deps.err(`install failed: ${(e as Error).message}`);
        return 1;
      }
    }
    deps.out("To install: symlink the built CLI onto your PATH, e.g.\n  ln -sf <…>/packages/knowledge-cli/dist/bin.js ~/.local/bin/penguin");
    return 0;
  }

  // remove: purge one repo (or a single branch of it). The Wiki delete
  // buttons and "oops, indexed ~/" recovery both land here.
  if (verb === "remove" || verb === "pin") {
    const target = pos[0];
    if (!target) { deps.err(`usage: penguin ${verb} <repo-name|path> [branch]`); return 2; }
    if (!deps.storeExists()) { deps.err("no knowledge database"); return 3; }
    const store = deps.openStore();
    try {
      const norm = target.replace(/\/+$/, "");
      const row = store.db
        .prepare("SELECT id, name, root_path FROM repos WHERE name = ? OR root_path = ?")
        .get(norm, norm) as { id: string; name: string; root_path: string } | undefined;
      if (!row) {
        deps.err(`no indexed repo matches "${target}" — see \`penguin status\` for names`);
        return 1;
      }
      const branchName = pos[1];
      if (flags.includes("--dry-run")) {
        const branch = branchName ? store.getBranch(row.id, branchName) : undefined;
        const scope = { repoId: row.id, ...(branch ? { branchId: branch.id } : {}) };
        emit(deps, json, `dry-run ${verb}: ${row.name}${branchName ? `/${branchName}` : ""}`, { mode: "dry-run", operation: verb, ...scope, name: row.name, rootPath: row.root_path, operationToken: operationToken(verb, scope), mutated: false });
        return 0;
      }
      const scope = { repoId: row.id, ...(branchName ? { branch: branchName } : {}) };
      if (!requireOperationToken(deps, argv, verb, scope)) return 6;
      if (verb === "pin") {
        if (!branchName) { deps.err("usage: penguin pin <repo> <branch>"); return 2; }
        const br = store.getBranch(row.id, branchName);
        if (!br) { deps.err(`no branch "${branchName}" in ${row.name}`); return 1; }
        const pinned = store.toggleBranchPinned(br.id);
        emit(deps, json, `${pinned ? "pinned" : "unpinned"} ${row.name}/${branchName}`, {
          ok: true, repoId: row.id, branchId: br.id, pinned,
        });
        return 0;
      }
      if (branchName) {
        const br = store.getBranch(row.id, branchName);
        if (!br) { deps.err(`no branch "${branchName}" in ${row.name}`); return 1; }
        if ((br as { pinned?: number }).pinned) {
          deps.err(`${row.name}/${branchName} is pinned — unpin first (penguin pin ${row.name} ${branchName})`);
          return 1;
        }
        store.removeBranch(br.id);
        emit(deps, json, `removed branch ${branchName} of ${row.name} from the index`, {
          ok: true, repoId: row.id, branchId: br.id, name: row.name, branch: branchName,
        });
        return 0;
      }
      store.removeRepo(row.id);
      emit(deps, json, `removed ${row.name} (${row.root_path}) from the index`, {
        ok: true, repoId: row.id, name: row.name, rootPath: row.root_path,
      });
      return 0;
    } finally {
      store.close();
    }
  }

  if (verb === "master") {
    if (!deps.storeExists()) { deps.err("no knowledge database"); return 3; }
    const store = deps.openStore();
    try {
      const target = pos[0] ?? readGitContext(deps.cwd).checkoutPath;
      const norm = target.replace(/\/+$/, "");
      const row = store.db
        .prepare("SELECT id, name, root_path AS rootPath FROM repos WHERE name = ? OR root_path = ?")
        .get(norm, norm) as { id: string; name: string; rootPath: string } | undefined;
      if (!row) { deps.err(`no indexed repo matches "${target}" — see \`penguin status\` for names`); return 1; }
      const requested = pos[1];
      const current = readGitContext(pos[0] ? row.rootPath : deps.cwd);
      const branchName = requested ?? current.branch;
      const branch = store.getBranch(row.id, branchName);
      if (!branch) {
        deps.err(`no branch "${branchName}" in ${row.name}; checkout the branch first or pass it explicitly`);
        return 1;
      }
      const selected = store.setDefaultBranch(row.id, branch.id);
      emit(deps, json, `${row.name}/${selected.branch} is now the canonical master branch`, {
        ok: true, repoId: row.id, branchId: selected.branchId, branch: selected.branch, previousBranchId: selected.previousBranchId, defaultBranch: true,
      });
      return 0;
    } finally { store.close(); }
  }

  // file-backed knowledge notes (C9): new/append/list/reindex under notesDir.
  if (verb === "note") {
    const sub = pos[0];
    const notesDir = deps.notesDir;
    if (!notesDir) { deps.err("notes dir not configured"); return 1; }
    const store = deps.openStore();
    try {
      if (sub === "new") {
        const title = pos.slice(1).join(" ").trim();
        if (!title) { deps.err("usage: penguin note new <title> [--type=decision|incident|compliance|bug|requirement|architecture]"); return 2; }
        const type = flags.find((f) => f.startsWith("--type="))?.slice("--type=".length);
        const r = createNote({ store, notesDir, title, frontmatter: type ? { type, status: "open" } : undefined });
        emit(deps, json, `created ${r.path}  (id ${r.slug}${type ? `, type ${type}` : ""})`, { ok: true, slug: r.slug, path: r.path, nodeId: r.nodeId, type });
        return 0;
      }
      if (sub === "append") {
        const slug = pos[1];
        const text = pos.slice(2).join(" ");
        if (!slug || !text) { deps.err("usage: penguin note append <slug> <text>"); return 2; }
        try {
          const r = appendNote({ store, notesDir, slug, text });
          emit(deps, json, `appended → ${r.path}`, { ok: true, path: r.path, nodeId: r.nodeId });
          return 0;
        } catch (e) {
          deps.err((e as Error).message);
          return 1;
        }
      }
      if (sub === "write") {
        // note write <slug> <body> — overwrite body (editor save). Body is a
        // single arg so newlines survive (the app passes it as one argv entry).
        const slug = pos[1];
        const body = pos[2] ?? "";
        if (!slug) { deps.err("usage: penguin note write <slug> <body>"); return 2; }
        try {
          const r = writeNoteBody({ store, notesDir, slug, body });
          emit(deps, json, `wrote → ${r.path}`, { ok: true, path: r.path, nodeId: r.nodeId });
          return 0;
        } catch (e) {
          deps.err((e as Error).message);
          return 1;
        }
      }
      if (sub === "read") {
        const slug = pos[1];
        if (!slug) { deps.err("usage: penguin note read <slug>"); return 2; }
        const src = readNote(notesDir, slug);
        if (src == null) { deps.err(`note not found: ${slug}`); return 1; }
        emit(deps, json, src, { slug, source: src });
        return 0;
      }
      if (sub === "reindex") {
        const r = reindexNotesDir({ store, notesDir });
        const dangling = listDanglingNoteLinks(store);
        emit(deps, json, `reindexed ${r.indexed} notes · dangling links ${dangling.length}`, { ...r, danglingLinks: dangling });
        return 0;
      }
      if (sub === "links") {
        const dangling = listDanglingNoteLinks(store, numberOption("limit"));
        emit(deps, json, dangling.map((link) => `${link.sourcePath ?? link.sourceNodeId}:${link.sourceLine}\t[[${link.rawTarget}${link.targetAnchor ? `#${link.targetAnchor}` : ""}]]\t${link.resolutionStatus}`).join("\n") || "(no dangling links)", dangling);
        return 0;
      }
      if (sub === "list" || sub === undefined) {
        const notes = listNotes(notesDir);
        emit(deps, json, notes.join("\n") || "(no notes)", notes);
        return 0;
      }
      deps.err("usage: penguin note <new|append|list|reindex|links> …");
      return 2;
    } finally {
      store.close();
    }
  }

  // Error/Incident memory (Phase 4): scaffold a structured incident note.
  if (verb === "incident") {
    const notesDir = deps.notesDir;
    if (!notesDir) { deps.err("notes dir not configured"); return 1; }
    const sub = pos[0];
    const title = pos.slice(1).join(" ").trim();
    if (sub !== "new" || !title) { deps.err("usage: penguin incident new <title>"); return 2; }
    const store = deps.openStore();
    try {
      const r = createIncident({ store, notesDir, title });
      emit(deps, json, `incident created ${r.path}  (id ${r.slug})\nfill in root cause / fix, link code with [[Name]]`, { ok: true, slug: r.slug, path: r.path, nodeId: r.nodeId });
      return 0;
    } finally {
      store.close();
    }
  }

  if (verb === "evidence") {
    const sub = pos[0];
    const notesDir = deps.notesDir;
    if (!notesDir) { deps.err("notes dir not configured"); return 1; }
    if (!deps.storeExists()) { deps.err("no knowledge database — run `penguin init` or open Penguin app first"); return 3; }
    const store = deps.openStore();
    try {
      if (sub === "plan") {
        const question = pos.slice(1).join(" ").trim();
        if (!question) { deps.err("usage: penguin evidence plan <question> [--target <target-id>]"); return 2; }
        const targetId = optionValue("target") ?? "knowledge-local";
        const planId = `investigation:${createHash("sha256").update(`${targetId}\n${question}`).digest("hex").slice(0, 24)}`;
        const plan = { planId, question, targetIds: [targetId], bounded: true, steps: ["knowledge.preflight", "evidence.collect", "human.review"], createdAt: new Date().toISOString() };
        mkdirSync(notesDir, { recursive: true });
        writeFileSync(`${notesDir}/.${planId.replaceAll(":", "-")}.json`, JSON.stringify(plan, null, 2));
        emit(deps, json, `planned ${planId}`, plan); return 0;
      }
      if (sub === "capture") {
        const planId = pos[1];
        const rawResults = optionValue("results");
        if (!planId || !rawResults) { deps.err("usage: penguin evidence capture <plan-id> --results <json>"); return 2; }
        let results: unknown;
        try { results = JSON.parse(readFileSync(rawResults, "utf8")); } catch { try { results = JSON.parse(rawResults); } catch { deps.err("results must be a JSON file or JSON value"); return 2; } }
        const targetId = optionValue("target") ?? "knowledge-local";
        const title = `Evidence ${planId}`;
        const note = createNote({ store, notesDir, title, body: `## Captured results\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\``, frontmatter: { type: "evidence", status: "draft", target_id: targetId, topic_hash: createHash("sha256").update(planId).digest("hex") } });
        emit(deps, json, `captured ${note.slug}`, { ok: true, planId, targetId, note }); return 0;
      }
      if (sub === "list") {
        const rows = listEvidenceNotes({ store, notesDir, targetId: optionValue("target"), status: optionValue("status") as EvidenceLifecycle | undefined, limit: numberOption("limit") });
        emit(deps, json, rows.map((row) => `${row.slug}\t${row.status}\t${row.targetId}\t${row.environment}\t${row.project}/${row.logstore}\t${row.observationCount}`).join("\n") || "(no evidence notes)", rows);
        return 0;
      }
      if (sub === "get") {
        const slug = pos[1];
        if (!slug) { deps.err("usage: penguin evidence get <slug>"); return 2; }
        const row = listEvidenceNotes({ store, notesDir, limit: 100 }).find((item) => item.slug === slug);
        const source = row ? readNote(notesDir, slug) : null;
        if (!row || source == null) { deps.err("evidence note not found"); return 1; }
        emit(deps, json, source, { ...row, markdown: source }); return 0;
      }
      if (sub === "validate") {
        const report = evidenceDoctor({ store, notesDir });
        emit(deps, json, JSON.stringify(report), { ...report, status: "validated" });
        return report.missingIndex.length || report.orphanIndex.length || report.malformed.length ? 1 : 0;
      }
      if (sub === "status") {
        const slug = pos[1];
        const to = pos[2] as EvidenceLifecycle | undefined;
        if (!slug || !to || !["reviewed", "verified", "resolved", "archived"].includes(to)) { deps.err("usage: penguin evidence status <slug> <reviewed|verified|resolved|archived>"); return 2; }
        const row = setEvidenceStatus({ store, notesDir, slug, to, from: optionValue("from") as EvidenceLifecycle | undefined });
        emit(deps, json, `${row.slug}: ${row.status}`, row);
        return 0;
      }
      if (sub === "doctor") {
        const report = evidenceDoctor({ store, notesDir });
        emit(deps, json, `evidence files ${report.files} · indexed ${report.indexed} · missing index ${report.missingIndex.length} · orphan index ${report.orphanIndex.length} · malformed ${report.malformed.length}`, report);
        return report.missingIndex.length || report.orphanIndex.length || report.malformed.length ? 1 : 0;
      }
      if (sub === "repair") {
        const report = repairEvidence({ store, notesDir });
        emit(deps, json, `reindexed ${report.reindexed} evidence files · removed ${report.removedLocks} stale locks`, report);
        return 0;
      }
      deps.err("usage: penguin evidence <list|status|doctor|repair> …");
      return 2;
    } finally { store.close(); }
  }

  if (verb === "link" && (pos[0] === "list" || pos[0] === "delete")) {
    if (!deps.storeExists()) { deps.err("no knowledge database — run `penguin init` first"); return 3; }
    const store = deps.openStore();
    try {
      if (pos[0] === "list") {
        const rows = store.db.prepare("SELECT id, src, dst, edge_type AS edgeType, status, provenance FROM edges WHERE status='active' ORDER BY id LIMIT ?").all(numberOption("limit") ?? 100);
        emit(deps, json, (rows as Array<Record<string, unknown>>).map((row) => `${row.id}\t${row.src} → ${row.dst ?? "?"}\t${row.edgeType}`).join("\n") || "(no active links)", rows); return 0;
      }
      const id = pos[1];
      if (!id) { deps.err("usage: penguin link delete <edge-id> --confirm"); return 2; }
      if (!flags.includes("--confirm")) { deps.err("link delete is guarded; repeat with --confirm"); return 6; }
      const event = store.recordKnowledge({ type: "manual_edge_deleted", origin: "user", method: "ASSERTED", actor: { type: "user", id: "cli" }, target: { node_id: id }, payload: { edge_id: id } });
      emit(deps, json, `deleted link ${id}`, { ok: true, eventId: event.id, edgeId: id }); return 0;
    } finally { store.close(); }
  }

  if (verb === "revisions") {
    const sub = pos[0];
    if (sub === "migrate") {
      if (!deps.storeExists()) { deps.err("no knowledge database"); return 3; }
      const store = deps.openStore();
      try {
        const requested = optionValue("repo");
        const repos = (store.db.prepare(requested ? "SELECT id,name,root_path AS rootPath FROM repos WHERE id=? OR name=?" : "SELECT id,name,root_path AS rootPath FROM repos").all(...(requested ? [requested, requested] : [])) as Array<{ id: string; name: string; rootPath: string }>);
        const integrity = (repoId: string) => {
          const count = (sql: string, ...args: unknown[]) => Number((store.db.prepare(sql).get(...args) as { n?: number } | undefined)?.n ?? 0);
          return {
            orphanBranchPointers: count("SELECT COUNT(*) AS n FROM branches b LEFT JOIN revision_snapshots s ON s.id=b.current_snapshot_id WHERE b.repo_id=? AND b.current_snapshot_id IS NOT NULL AND s.id IS NULL", repoId),
            orphanSnapshotBases: count("SELECT COUNT(*) AS n FROM revision_snapshots s LEFT JOIN revision_snapshots b ON b.id=s.base_snapshot_id WHERE s.repo_id=? AND s.base_snapshot_id IS NOT NULL AND b.id IS NULL", repoId),
            orphanOverlays: count("SELECT COUNT(*) AS n FROM snapshot_overlays o LEFT JOIN revision_snapshots s ON s.id=o.snapshot_id LEFT JOIN file_facts f ON f.id=o.file_fact_id WHERE s.repo_id=? AND (s.id IS NULL OR (o.file_fact_id IS NOT NULL AND f.id IS NULL))", repoId),
            orphanResolutionRefs: count("SELECT COUNT(*) AS n FROM snapshot_resolution_refs r LEFT JOIN revision_snapshots s ON s.id=r.snapshot_id LEFT JOIN resolution_sets x ON x.id=r.resolution_set_id WHERE s.repo_id=? AND (s.id IS NULL OR x.id IS NULL)", repoId),
            orphanResolutionEdges: count("SELECT COUNT(*) AS n FROM resolution_sets x LEFT JOIN file_facts f ON f.id=x.file_fact_id WHERE f.repo_id=? AND f.id IS NULL", repoId),
            orphanFileFactSymbols: count("SELECT COUNT(*) AS n FROM file_fact_symbols s LEFT JOIN file_facts f ON f.id=s.file_fact_id WHERE f.repo_id=? AND f.id IS NULL", repoId),
            orphanDeploymentCommits: count("SELECT COUNT(*) AS n FROM deployment_revisions d LEFT JOIN repos r ON r.id=d.repo_id WHERE d.repo_id=? AND r.id IS NULL", repoId),
            orphanNotes: count("SELECT COUNT(*) AS n FROM notes_index ni LEFT JOIN nodes n ON n.id=ni.node_id WHERE n.repo_id=? AND n.id IS NULL", repoId),
          };
        };
        const report = repos.map((repo) => {
          const masterCount = (store.db.prepare("SELECT COUNT(*) AS n FROM branches WHERE repo_id=? AND default_branch=1").get(repo.id) as { n: number }).n;
          return {
            repoId: repo.id,
            repo: repo.name,
            rootPath: repo.rootPath,
            legacyFiles: (store.db.prepare("SELECT COUNT(*) AS n FROM files_index WHERE repo_id=?").get(repo.id) as { n: number }).n,
            notes: (store.db.prepare("SELECT COUNT(*) AS n FROM notes_index ni JOIN nodes n ON n.id=ni.node_id WHERE n.repo_id=?").get(repo.id) as { n: number }).n,
            masterMissing: masterCount === 0,
            duplicateMasters: Math.max(0, masterCount - 1),
            integrity: integrity(repo.id),
            status: flags.includes("--apply") ? "rebuild_required" : "would_rebuild",
          };
        });
        if (!flags.includes("--apply")) { emit(deps, json, `migration dry-run: ${report.length} repo(s)`, { mode: "dry-run", repositories: report, notesAndLedgerPreserved: true, legacyRowsRetained: true }); return 0; }
        const results = []; let failed = false;
        for (const repo of repos) {
          const pointers = store.db.prepare("SELECT id,current_snapshot_id,head_commit,last_indexed_commit,last_indexed_at FROM branches WHERE repo_id=?").all(repo.id) as Array<{ id: string; current_snapshot_id: string | null; head_commit: string | null; last_indexed_commit: string | null; last_indexed_at: string | null }>;
          try {
            const rebuilt = await indexRepo({ store, rootPath: repo.rootPath, mode: "rebuild" });
            const checks = integrity(repo.id); const orphanCount = Object.values(checks).reduce((sum, value) => sum + value, 0);
            if (orphanCount) throw new Error(`integrity check failed: ${JSON.stringify(checks)}`);
            results.push({ repo: repo.name, report: rebuilt, integrity: checks, status: "migrated" });
          } catch (error) {
            failed = true;
            const restore = store.db.transaction(() => { for (const pointer of pointers) store.db.prepare("UPDATE branches SET current_snapshot_id=?,head_commit=?,last_indexed_commit=?,last_indexed_at=? WHERE id=?").run(pointer.current_snapshot_id, pointer.head_commit, pointer.last_indexed_commit, pointer.last_indexed_at, pointer.id); });
            restore();
            results.push({ repo: repo.name, status: "rolled_back", error: String((error as Error).message ?? error), integrity: integrity(repo.id) });
          }
        }
        emit(deps, json, `${failed ? "migration failed" : "migrated"} ${repos.length} repo(s); notes and ledger preserved`, { mode: "apply", repositories: results, notesAndLedgerPreserved: true, legacyRowsRetained: true });
        return failed ? 1 : 0;
      } finally { store.close(); }
    }
    if (sub !== "gc") { deps.err("usage: penguin revisions gc <repo> [--dry-run|--apply] | migrate [--dry-run|--apply]"); return 2; }
    const repoName = pos[1] ?? optionValue("repo");
    if (!repoName || !deps.storeExists()) { deps.err("usage: penguin revisions gc <repo> [--dry-run|--apply]"); return 2; }
    const store = deps.openStore();
    try {
      const repoId = resolveRepoId(store, repoName);
      if (!repoId) { deps.err(`repo not found: ${repoName}`); return 1; }
      const plan = planRevisionCollection(store, repoId);
      if (flags.includes("--apply")) {
        const result = applyRevisionCollection(store, plan);
        emit(deps, json, `collected ${result.collectedSnapshotIds.length} snapshots; cooled ${result.cooledSnapshotIds.length}`, result);
      } else {
        emit(deps, json, `keep ${plan.keep.length}; cool ${plan.cool.length}; collect ${plan.collect.length}`, plan);
      }
      return 0;
    } finally { store.close(); }
  }

  if (verb === "materialize") {
    const repoName = pos[0] ?? optionValue("repo");
    const branch = optionValue("branch");
    const commitSha = optionValue("commit");
    if (!repoName || Boolean(branch) === Boolean(commitSha) || !deps.storeExists()) {
      deps.err("usage: penguin materialize <repo> (--branch <name> | --commit <sha>)");
      return 2;
    }
    const store = deps.openStore();
    try {
      const repoId = resolveRepoId(store, repoName);
      if (!repoId) { deps.err(`repo not found: ${repoName}`); return 1; }
      const repo = store.db.prepare("SELECT root_path AS rootPath FROM repos WHERE id=?").get(repoId) as { rootPath: string };
      const result = await indexRevision({
        store,
        rootPath: repo.rootPath,
        repoId,
        revision: branch ? { branch } : { commitSha },
        parserVersion: "tree-sitter-wasm-v5-single-pass-log-sites",
        resolverVersion: "resolver-v1",
        coordinator: new RevisionIndexCoordinator(),
      });
      emit(deps, json, `materialized ${repoName}@${result.context.commitSha}`, result);
      return 0;
    } catch (error) {
      deps.err(`materialize failed: ${String((error as Error).message ?? error)}`);
      return 1;
    } finally { store.close(); }
  }

  // AI explain (optional BYOK layer): plain-English "what does this do", grounded
  // in the deterministic Context Pack. No AI in the graph itself — this just
  // routes the pack to a provider (DeepSeek default). `explain <symbol>`.
  if (verb === "explain") {
    if (!deps.storeExists()) { deps.err("no knowledge database — run `penguin init` first"); return 3; }
    const target = pos.join(" ").trim();
    if (!target) { deps.err("usage: penguin explain <symbol|endpoint> [--provider=deepseek|openai] [--model=…] [--key=…]"); return 2; }
    const flagVal = (name: string) => flags.find((fl) => fl.startsWith(`--${name}=`))?.slice(name.length + 3);
    const store = deps.openStore();
    try {
      const pack = buildContextPack(store, target);
      if (!pack.focus) {
        if (pack.ambiguous) deps.err(renderAmbiguousSymbols(target, pack.ambiguous));
        else if (pack.assemblyError) deps.err(`"${target}" resolved to a symbol, but building its context failed: ${pack.assemblyError}`);
        else deps.err(`no context for "${target}" — not indexed, or the name doesn't match any symbol/note`);
        return 1;
      }
      const cfg = resolveProvider({ provider: flagVal("provider"), model: flagVal("model"), apiKey: flagVal("key") });
      const md = renderContextPackMarkdown(pack);
      const answer = await aiComplete(cfg, [
        { role: "system", content: "You are a senior engineer. Explain what the given code symbol does in plain English: purpose, key behaviour, inputs/outputs, and notable risks. Be concise (a short paragraph + bullet points). Ground every claim in the provided context; do not invent APIs." },
        { role: "user", content: `Explain \`${pack.focus.title}\`.\n\nContext:\n${md}` },
      ]);
      emit(deps, json, answer, { target, provider: cfg.provider, model: cfg.model, explanation: answer });
      return 0;
    } catch (e) {
      deps.err((e as Error).message);
      return 1;
    } finally {
      store.close();
    }
  }

  // response sample capture (P2 runtime channel): record a real REST/gRPC
  // response for an endpoint. `sample <endpoint> <status> <json> [contentType]`.
  if (verb === "sample") {
    const [endpoint, statusArg, payload, contentType] = pos;
    if (!endpoint || !payload) { deps.err("usage: penguin sample <endpoint> <status> <json-or-text> [contentType]"); return 2; }
    const store = deps.openStore();
    try {
      const endpointId = resolveEndpointId(store, endpoint);
      const ev = store.recordKnowledge({
        type: "response_sample_captured", origin: "user", method: "ASSERTED",
        actor: { type: "user", id: "cli" }, target: { node_id: endpointId },
        payload: { endpoint_id: endpointId, endpoint_key: endpoint, status: statusArg ?? null, content_type: contentType ?? null, sample: payload },
      });
      emit(deps, json, `captured sample for ${endpoint}${statusArg ? ` (${statusArg})` : ""}`, { ok: true, eventId: ev.id, endpointId });
      return 0;
    } finally {
      store.close();
    }
  }

  // ledger write verbs (may create the DB, §9)
  if (verb === "accept" || verb === "reject" || verb === "link" || verb === "snapshot" || verb === "remember" || verb === "forget") {
    const store = deps.openStore();
    try {
      if (verb === "link") {
        const [src, dst, edgeType] = pos;
        if (!src || !dst) { deps.err("usage: penguin link <src> <dst> [edgeType]"); return 2; }
        const ev = store.recordKnowledge({
          type: "manual_edge_created", origin: "user", method: "ASSERTED",
          actor: { type: "user", id: "cli" }, target: { node_id: src },
          payload: { src, dst, edge_type: edgeType ?? "wikilink" },
        });
        emit(deps, json, `linked ${src} → ${dst}`, { ok: true, eventId: ev.id });
        return 0;
      }
      if (verb === "snapshot") {
        const [name, ...nodeIds] = pos;
        if (!name) { deps.err("usage: penguin snapshot <name> <nodeId...>"); return 2; }
        const ev = store.createSnapshot({ name, nodeIds });
        emit(deps, json, `snapshot '${name}' (${nodeIds.length} nodes)`, { ok: true, eventId: ev.id });
        return 0;
      }
      if (verb === "remember") {
        const subject = pos[0];
        const body = pos.slice(1).join(" ").trim();
        if (!subject || !body) { deps.err("usage: penguin remember <subject> <body> [--repo <repo>|--workspace <id>|--global] [--class=decision|runbook|incident|preference|project|session]"); return 2; }
        if (!optionValue("repo") && !optionValue("workspace") && !flags.includes("--global")) { deps.err("remember requires an explicit scope: --repo, --workspace, or --global"); return 2; }
        const item = new MemoryStore(store).remember({
          class: (optionValue("class") as import("@penguin/knowledge-core").MemoryClass | undefined) ?? "project",
          scope: { ...(optionValue("repo") ? { repoId: resolveRepoId(store, optionValue("repo")!) ?? optionValue("repo") } : {}), ...(optionValue("workspace") ? { workspaceId: optionValue("workspace") } : {}), ...(flags.includes("--global") ? { workspaceId: "global" } : {}) },
          subject, body, source: [{ type: "cli" }], confidence: 1, retention: "normal",
        });
        emit(deps, json, `remembered ${item.id}`, item);
        return 0;
      }
      if (verb === "forget") {
        const id = pos[0];
        if (!id) { deps.err("usage: penguin forget <memory-id>"); return 2; }
        if (!flags.includes("--confirm")) { deps.err("forget is guarded; repeat with --confirm after reviewing the memory id"); return 2; }
        new MemoryStore(store).forget(id);
        emit(deps, json, `forgotten ${id}`, { ok: true, id });
        return 0;
      }
      const id = pos[0];
      if (!id) { deps.err(`usage: penguin ${verb} <suggestion-event-id>`); return 2; }
      if (verb === "accept") store.acceptSuggestion(id);
      else store.rejectSuggestion(id);
      emit(deps, json, `${verb}ed ${id}`, { ok: true });
      return 0;
    } finally {
      store.close();
    }
  }

  // read verbs: never create a DB (§9)
  if (READ_VERBS.has(verb)) {
    if (!deps.storeExists()) {
      deps.err("no knowledge database — run `penguin init` or open Penguin app first");
      return 3;
    }
    const store = deps.openStore();
    try {
      switch (verb) {
        case "coverage": {
          const repoId = resolveRepoId(store, optionValue("repo") ?? pos[0]);
          const summary = (repoId ? store.db.prepare("SELECT COUNT(*) AS discovered, SUM(coverage_status='admitted') AS admitted, SUM(coverage_status<>'admitted') AS excluded, SUM(coverage_status='failed') AS failed FROM coverage_records WHERE repo_id=?").get(repoId) : store.db.prepare("SELECT COUNT(*) AS discovered, SUM(coverage_status='admitted') AS admitted, SUM(coverage_status<>'admitted') AS excluded, SUM(coverage_status='failed') AS failed FROM coverage_records").get()) as { discovered: number; admitted: number; excluded: number; failed: number };
          const result = { discovered: summary.discovered ?? 0, admitted: summary.admitted ?? 0, excluded: summary.excluded ?? 0, failed: summary.failed ?? 0, stale: 0 };
          emit(deps, json, `coverage: ${result.admitted} admitted · ${result.excluded} excluded · ${result.failed} failed`, result);
          return 0;
        }
        case "onboarding": {
          const repoId = resolveRepoId(store, optionValue("repo") ?? pos[0]) ?? undefined;
          const document = buildOnboardingDocument(store, repoId);
          const scope = { repoId: repoId ?? null, revisionHash: document.revisionHash, capabilityHash: document.capabilityHash };
          const token = operationToken("onboarding.save", scope);
          if (flags.includes("--dry-run")) {
            emit(deps, json, `dry-run onboarding save (token: ${token})`, { mode: "dry-run", operation: "onboarding.save", ...scope, operationToken: token, markdown: document.markdown, mutated: false });
            return 0;
          }
          if (flags.includes("--save")) {
            if (confirmationValue(argv) !== token) { deps.err(`onboarding save is guarded; review the preview, then repeat with --confirm=${token}`); return 6; }
            if (!deps.notesDir) { deps.err("notes dir not configured"); return 1; }
            const note = createNote({ store, notesDir: deps.notesDir, title: repoId ? "Penguin Onboarding - Repository" : "Penguin Onboarding", body: document.markdown, frontmatter: { type: "architecture", status: "reviewed", revision_hash: document.revisionHash, capability_hash: document.capabilityHash } });
            emit(deps, json, `saved onboarding → ${note.path}`, { ok: true, ...scope, note });
            return 0;
          }
          emit(deps, json, document.markdown, { markdown: document.markdown, ...scope, saveOperationToken: token });
          return 0;
        }
        case "domain": {
          const repoId = resolveRepoId(store, optionValue("repo") ?? pos[0]);
          const result = { target: pos.join(" "), claims: buildDomainClaims(store, { ...(repoId ? { repoId } : {}), ...(optionValue("persona") ? { persona: optionValue("persona") as "frontend" | "backend" | "qa" | "sre" | "pm/security" } : {}) }), flow: buildDomainFlow(store, { ...(repoId ? { repoId } : {}), ...(pos.join(" ") ? { target: pos.join(" ") } : {}) }), gaps: repoId ? [] : ["repo scope not specified"] };
          emit(deps, json, JSON.stringify(result), result);
          return 0;
        }
        case "why": {
          const id = pos[0];
          const card = id ? new WhyCardStore(store).get(id) : undefined;
          emit(deps, json, card ? `${card.question}\n${card.answer}` : "(no WHY card)", card ?? { cards: [] });
          return card ? 0 : 1;
        }
        case "recall": {
          const memories = new MemoryStore(store).recall(optionValue("repo") ? { repoId: resolveRepoId(store, optionValue("repo")!) ?? optionValue("repo") } : undefined);
          emit(deps, json, memories.map((item) => `${item.id}\t${item.subject}\t${item.body}`).join("\n") || "(no memories)", memories);
          return 0;
        }
        case "search": {
          let queryText = pos.join(" ");
          let mode = optionValue("mode") ?? "auto";
          let dslPaths: string[] = [];
          let propertyPredicates: import("@penguin/knowledge-core").KnowledgeDslPredicate[] = [];
          let markdownPredicates: import("@penguin/knowledge-core").KnowledgeDslPredicate[] = [];
          if (flags.includes("--dsl")) {
            try {
              const compiled = compileKnowledgeDsl(queryText);
              queryText = compiled.request.query;
              mode = compiled.request.mode ?? "auto";
              dslPaths = compiled.request.scope?.paths ?? [];
              propertyPredicates = compiled.propertyPredicates;
              markdownPredicates = compiled.markdownPredicates;
            } catch (error) { deps.err(String((error as Error).message ?? error)); return 2; }
          }
          const revisionKinds = [optionValue("snapshot"), optionValue("commit"), flags.includes("--working-tree") ? "working-tree" : undefined].filter(Boolean);
          if (revisionKinds.length > 1) { deps.err("--snapshot, --commit, and --working-tree are mutually exclusive"); return 2; }
          const repoSelectors = optionValues("repo");
          if (repoSelectors.length > 1 && (optionValue("branch") || revisionKinds.length > 0)) {
            deps.err("repeated --repo supports live multi-repo search only; combine it with --branch, --commit, --snapshot, or --working-tree one repo at a time");
            return 2;
          }
          const resolvedRepoIds = repoSelectors.map((selector) => resolveRepoId(store, selector));
          if (resolvedRepoIds.some((repoId) => !repoId)) {
            const missing = repoSelectors[resolvedRepoIds.findIndex((repoId) => !repoId)];
            deps.err(`unknown repo: ${missing}`);
            return 2;
          }
          const selectedRepoIds = resolvedRepoIds.filter((repoId): repoId is string => Boolean(repoId));
          let revision: import("@penguin/knowledge-core").RevisionContext | undefined;
          try {
            if (repoSelectors.length <= 1 && (optionValue("repo") || optionValue("branch") || optionValue("commit") || optionValue("snapshot"))) {
              revision = resolveCliRevision(store, queryText, { repo: optionValue("repo"), branch: optionValue("branch"), commitSha: optionValue("commit"), snapshotId: optionValue("snapshot") });
            }
          } catch (error) {
            if (json && error instanceof RevisionResolutionError) {
              deps.out(JSON.stringify({ ok: false, error: { code: "REVISION_NOT_FOUND", message: error.message, details: { candidates: error.candidates }, retryable: false } }));
            } else {
              reportRevisionResolutionError(deps, error);
            }
            return json ? 3 : 2;
          }
          const defaultRepoId = selectedRepoIds.length === 0 && !revision && revisionKinds.length === 0
            ? resolveRepoForCwd(store, deps.cwd)
            : null;
          const repoId = selectedRepoIds[0] ?? revision?.repoId ?? defaultRepoId;
          const sourceSnapshotId = revision && !revision.snapshotId.startsWith("legacy:")
            ? revision.snapshotId
            : (revision?.branchId
              ? (store.db.prepare("SELECT current_snapshot_id FROM branches WHERE id=?").get(revision.branchId) as { current_snapshot_id: string | null } | undefined)?.current_snapshot_id ?? null
              : (store.db.prepare(repoId
                ? "SELECT current_snapshot_id FROM branches WHERE repo_id=? AND status='live' AND current_snapshot_id IS NOT NULL ORDER BY default_branch DESC, name LIMIT 1"
                : "SELECT current_snapshot_id FROM branches WHERE status='live' AND current_snapshot_id IS NOT NULL ORDER BY default_branch DESC, name LIMIT 1")
                .get(...(repoId ? [repoId] : [])) as { current_snapshot_id: string | null } | undefined)?.current_snapshot_id ?? null);
          const useV2Search = !flags.includes("--legacy-search");
          if (useV2Search || optionValue("mode") || flags.includes("--compact") || optionValue("cursor")) {
            const revisions = sourceSnapshotId
              ? [{ ...(repoId ? { repoId } : {}), ...(flags.includes("--working-tree") ? { workingTree: true } : { snapshotId: sourceSnapshotId }) }]
              : selectedRepoIds.length > 0
              ? selectedRepoIds.map((selected) => ({ repoId: selected }))
              : undefined;
            let response = await searchKnowledge({ query: queryText, mode: mode as never, scope: { ...(revisions ? { revisions } : {}), ...(optionValue("workspace") ? { workspaceId: optionValue("workspace") } : {}), ...((optionValues("path").length || dslPaths.length) ? { paths: [...optionValues("path"), ...dslPaths] } : {}), ...(optionValues("language").length ? { languages: optionValues("language") } : {}), ...(optionValues("kind").length ? { kinds: optionValues("kind") } : {}) }, options: { caseSensitive: flags.includes("--case-sensitive") || !flags.includes("--case-insensitive"), wholeWord: flags.includes("--whole-word"), includeGenerated: flags.includes("--include-generated"), includeVendor: flags.includes("--include-vendor"), includeExcludedMetadata: flags.includes("--include-excluded-metadata"), semantic: (optionValue("semantic") as "off" | "fallback" | "blend" | undefined) ?? "off", compact: flags.includes("--compact"), explain: flags.includes("--explain") }, page: { limit: numberOption("limit") ?? 50, ...(optionValue("cursor") ? { cursor: optionValue("cursor") } : {}) } }, { store, scopes: sourceSnapshotId ? [{ snapshotId: sourceSnapshotId, repoId }] : undefined });
            if (!repoId && selectedRepoIds.length === 0 && !revision && revisionKinds.length === 0 && !optionValue("workspace")) {
              response = { ...response, diagnostics: { ...response.diagnostics, warnings: [...response.diagnostics.warnings, { code: "DEFAULT_WORKSPACE_SCOPE", message: "cwd is outside an indexed repository; search used the configured workspace scope" }] } };
            }
            if (propertyPredicates.length) response = { ...response, hits: filterHitsByPropertyPredicates(store, response.hits, propertyPredicates), page: { ...response.page, totalIsExact: false }, diagnostics: { ...response.diagnostics, warnings: [...response.diagnostics.warnings, { code: "PROPERTY_FILTER_APPLIED", message: "typed Markdown property predicates were applied after indexed retrieval" }] } };
            if (markdownPredicates.length) response = { ...response, hits: filterHitsByMarkdownPredicates(store, response.hits, markdownPredicates), page: { ...response.page, totalIsExact: false }, diagnostics: { ...response.diagnostics, warnings: [...response.diagnostics.warnings, { code: "MARKDOWN_LOCATOR_FILTER_APPLIED", message: "line/section/block/task predicates were applied with exact Markdown locators" }] } };
            if (response.error) {
              const envelope = { ok: false, error: response.error, response };
              emit(deps, json, `${response.error.code}: ${response.error.message}`, envelope);
              return 3;
            }
            const human = [
              `${response.hits.length} hits · coverage ${response.diagnostics.coverage.admitted}/${response.diagnostics.coverage.discovered}`,
              ...response.hits.map((hit) => `${hit.locator.filePath}${hit.locator.startLine ? `:${hit.locator.startLine}` : ""}\t${hit.lane}\t${hit.snippet ?? hit.title}`),
              ...(response.diagnostics.warnings.length ? [`warnings: ${response.diagnostics.warnings.map((warning) => warning.code).join(", ")}`] : []),
            ].join("\n");
            emit(deps, json, human, response);
            return 0;
          }
          const regexResult = sourceSnapshotId && mode === "regex"
            ? searchRegex(store, { snapshotId: sourceSnapshotId, repoId }, queryText, { flags: optionValue("regex-flags") ?? "g", maxScannedBytes: numberOption("max-scanned-bytes"), allowPartial: flags.includes("--allow-partial") })
            : null;
          if (regexResult?.status === "error") { emit(deps, json, `${regexResult.code}: ${regexResult.message}`, regexResult); return 1; }
          const sourceHits = sourceSnapshotId && ["auto", "exact", "phrase", "substring"].includes(mode)
            ? searchSource(store, { snapshotId: sourceSnapshotId, repoId }, { query: queryText, mode: mode as "auto" | "exact" | "phrase" | "substring", options: { caseSensitive: true, wholeWord: false, includeGenerated: true, includeVendor: true, includeExcludedMetadata: false, semantic: "off", compact: false, explain: false } }).map((hit) => ({ ...hit, lane: "source" as const }))
            : [];
          const pathHits = sourceSnapshotId && mode === "path" ? searchPath(store, { snapshotId: sourceSnapshotId, repoId }, queryText, flags.includes("--include-excluded-metadata")) : [];
          const graphHits = search(store, queryText, { includeSensitive: false });
          const hits = mode === "regex"
            ? (regexResult?.status === "ok" ? regexResult.hits.map((hit) => ({ ...hit, lane: "source" as const })) : [])
            : mode === "path"
            ? pathHits
            : mode === "exact" || mode === "phrase" || mode === "substring"
            ? sourceHits
            : [...sourceHits, ...graphHits];
          const table = hits
            .map((h) => "lane" in h ? (h.lane === "path" ? `path\t${h.filePath}\t${h.coverageStatus}\t${h.metadataOnly ? "metadata-only" : "content"}` : `source\t${h.filePath}\t${h.startLine}\t${h.endLine}`) : `${h.nodeType}\t${h.identityKey}\t${h.filePath ?? "-"}\t${h.branch ?? "-"}\t${h.rank ?? "-"}`)
            .join("\n");
          emit(deps, json, table || "(no results)", hits);
          return 0;
        }
        case "graph-query": {
          const requestPath = optionValue("request") ?? pos[0];
          if (!requestPath) { deps.err("usage: penguin graph-query --request <json-file> --json"); return 2; }
          let request: import("@penguin/knowledge-core").GraphQueryRequest;
          try { request = JSON.parse(readFileSync(requestPath, "utf8")) as import("@penguin/knowledge-core").GraphQueryRequest; }
          catch { deps.err("invalid graph-query request JSON"); return 2; }
          try { const result = graphQuery(store, request); emit(deps, json, JSON.stringify(result), result); return 0; }
          catch (error) { deps.err(String((error as Error).message ?? error)); return 2; }
        }
        case "hit":
        case "get-hit": {
          const snapshotId = optionValue("snapshot");
          const filePath = pos.join(" ");
          if (!snapshotId || !filePath) { deps.err("usage: penguin get-hit <file-path> --snapshot <snapshot-id> [--line <n>|--start-byte <n>]"); return 2; }
          const repoId = optionValue("repo") ? resolveRepoId(store, optionValue("repo")) ?? undefined : undefined;
          const hit = getSourceHit(store, { snapshotId, filePath, ...(repoId ? { repoId } : {}), ...(numberOption("line") !== undefined ? { startLine: numberOption("line") } : {}), ...(numberOption("end-line") !== undefined ? { endLine: numberOption("end-line") } : {}), ...(numberOption("start-byte") !== undefined ? { startByte: numberOption("start-byte") } : {}), ...(numberOption("context-lines") !== undefined ? { contextLines: numberOption("context-lines") } : {}) });
          emit(deps, json, hit ? JSON.stringify(hit) : "source hit not found", hit);
          return hit ? 0 : 1;
        }
        case "node": {
          const target = pos[0] ?? "";
          const detail = getNodeDetail(store, target);
          if (!detail) {
            const resolution = resolveSymbolMatches(store, target);
            if (resolution.kind === "ambiguous") {
              deps.err(renderAmbiguousSymbols(target, resolution.candidates));
              return 1;
            }
            deps.err(`no node found for "${target}" — not indexed, or the name doesn't match any symbol/note title or qualified name`);
            return 1;
          }
          emit(deps, json, `${detail.node.nodeType} ${detail.node.title}\nversions: ${detail.versions.length}\naliases: ${detail.aliases.length}`, detail);
          return 0;
        }
        case "context": {
          // AI Context Pack: --json → structured; default → Markdown for an agent.
          const target = pos.join(" ");
          let revision: import("@penguin/knowledge-core").RevisionContext | undefined;
          try { revision = resolveCliRevision(store, target, { repo: optionValue("repo"), branch: optionValue("branch"), commitSha: optionValue("commit"), snapshotId: optionValue("snapshot") }); }
          catch (error) { reportRevisionResolutionError(deps, error); return 2; }
          const pack = buildContextPack(store, target, { revision });
          if (!pack.focus) {
            emit(deps, json, renderContextPackMarkdown(pack), pack);
            return 1;
          }
          emit(deps, json, renderContextPackMarkdown(pack), pack);
          return 0;
        }
        case "locate":
        case "explore": {
          const target = pos.join(" ");
          const requestedBranch = optionValue("branch");
          let revision: import("@penguin/knowledge-core").RevisionContext | undefined;
          try { revision = resolveCliRevision(store, target, { repo: optionValue("repo"), branch: requestedBranch, commitSha: optionValue("commit"), snapshotId: optionValue("snapshot") }); }
          catch (error) { reportRevisionResolutionError(deps, error); return 2; }
          let branchId: string | undefined;
          if (requestedBranch) {
            const exact = store.db.prepare("SELECT id FROM branches WHERE id=?").get(requestedBranch) as { id: string } | undefined;
            branchId = exact?.id;
            if (!branchId) {
              const resolution = resolveSymbolMatches(store, target);
              const repoId = resolution.kind === "unique" ? store.getNode(resolution.nodeId)?.repo_id : null;
              if (repoId) branchId = resolveBranchId(store, repoId, requestedBranch) ?? undefined;
            }
            if (!branchId) {
              deps.err(`branch "${requestedBranch}" was not found for "${target}"`);
              return 1;
            }
          }
          const pack = buildExplorePack(store, target, {
            branchId,
            revision,
            depth: numberOption("depth"),
            limit: numberOption("limit"),
          });
          emit(deps, json, JSON.stringify(pack, null, 2), pack);
          return pack.focus || pack.callPath.length > 0 ? 0 : 1;
        }
        case "flow": {
          // Flow Explorer: linear execution chain from an endpoint/symbol.
          const target = pos.join(" ");
          let revision: import("@penguin/knowledge-core").RevisionContext | undefined;
          try { revision = resolveCliRevision(store, target, { repo: optionValue("repo"), branch: optionValue("branch"), commitSha: optionValue("commit"), snapshotId: optionValue("snapshot") }); }
          catch (error) { reportRevisionResolutionError(deps, error); return 2; }
          const flow = buildFlow(store, target, { revision });
          if (!flow.root) {
            emit(deps, json, renderFlowMarkdown(flow), flow);
            return 1;
          }
          emit(deps, json, renderFlowMarkdown(flow), flow);
          if (flow.diagnostic) return 1; // resolved, but a dead end — signal via exit code, still print the (partial) flow
          return 0;
        }
        case "affected": {
          // Blast radius of changed files (pass paths, or a git diff piped in).
          let revision: import("@penguin/knowledge-core").RevisionContext | undefined;
          try { revision = resolveCliRevision(store, "", { repo: optionValue("repo"), branch: optionValue("branch"), commitSha: optionValue("commit"), snapshotId: optionValue("snapshot") }); }
          catch (error) { reportRevisionResolutionError(deps, error); return 2; }
          const a = affectedByFiles(store, pos, { revision });
          const txt = pos.length === 0 ? "usage: penguin affected <file>…"
            : `changed ${a.changed.length} · impacted ${a.impacted.length} · tests ${a.tests.length} · routes ${a.routes.length}\n`
              + a.routes.map((r) => `  route: ${r}`).join("\n");
          emit(deps, json, txt, a);
          return 0;
        }
        case "architecture": {
          const o = architecture(store);
          const txt = [
            `repos: ${o.repos.map((r) => `${r.name}(${r.branches}br)`).join(", ")}`,
            `nodes: ${Object.entries(o.nodeCounts).map(([k, v]) => `${k} ${v}`).join(" · ")}`,
            `edges: ${Object.entries(o.edgeCounts).map(([k, v]) => `${k} ${v}`).join(" · ")}`,
            `langs: ${o.languages.map((l) => `${l.lang} ${l.symbols}`).join(" · ")}`,
            `hubs: ${o.hubs.map((h) => h.title).join(", ")}`,
            `entrypoints: ${o.entryPoints.length}`,
          ].join("\n");
          emit(deps, json, txt, o);
          return 0;
        }
        case "services": {
          const sg = serviceGraph(store);
          emit(deps, json, `${sg.nodes.length} services/endpoints · ${sg.edges.length} cross-service links`, sg);
          return 0;
        }
        case "communities": {
          const c = communities(store, { limit: pos[0] ? Number(pos[0]) || 20 : 20 });
          const txt = `${c.totalCommunities} communities across ${c.totalNodes} connected nodes; top ${c.communities.length}:\n`
            + c.communities.map((m) => `  #${m.id} (${m.size}) ${m.repos.slice(0, 3).join("/")} — ${m.topMembers.map((t) => t.title).slice(0, 4).join(", ")}`).join("\n");
          emit(deps, json, txt, c);
          return 0;
        }
        case "timeline": {
          const t = timeline(store, { limit: pos[0] ? Number(pos[0]) || 50 : 50, repoId: optionValue("repo"), revision: (() => { try { return resolveCliRevision(store, "", { repo: optionValue("repo"), branch: optionValue("branch"), commitSha: optionValue("commit"), snapshotId: optionValue("snapshot") }); } catch { return undefined; } })() });
          const txt = t.entries.map((e) => `${(e.date ?? "").slice(0, 10)}  ${e.repo ?? "?"}  ${e.merge ? "⑃ " : ""}${e.subject}${e.tags.length ? ` [${e.tags.join(",")}]` : ""}`).join("\n") || "(no commits indexed)";
          emit(deps, json, txt, t);
          return 0;
        }
        case "samples": {
          const rows = endpointSamples(store, pos.join(" "));
          const txt = rows.map((r) => `${(r.capturedAt ?? "").slice(0, 19)}  ${r.status ?? ""}  ${r.contentType ?? ""}\n${r.sample.slice(0, 400)}`).join("\n---\n") || "(no samples — capture with `penguin sample <endpoint> <status> <json>`)";
          emit(deps, json, txt, rows);
          return 0;
        }
        case "deadcode": {
          const d = deadCode(store, { limit: 100 });
          emit(deps, json, `${d.candidates.length} candidate(s) — ${d.note}\n` + d.candidates.slice(0, 40).map((c) => `  ${c.title}`).join("\n"), d);
          return 0;
        }
        case "compare": {
          let revision: import("@penguin/knowledge-core").RevisionContext | undefined;
          try { revision = resolveCliRevision(store, pos[0] ?? "", { repo: optionValue("repo"), branch: optionValue("branch"), commitSha: optionValue("commit"), snapshotId: optionValue("snapshot") }); }
          catch (error) { reportRevisionResolutionError(deps, error); return 2; }
          const diff = compareBranches(store, pos[0] ?? "", pos[1] ?? "", pos[2] ?? "", { revision });
          if (!diff) { deps.err("symbol not found"); return 1; }
          emit(deps, json, diff.identical ? "identical (no diff)" : "differs", diff);
          return 0;
        }
        case "status": {
          if (flags.includes("--revisions")) {
            const rows = store.db.prepare(
              `SELECT r.name AS repo, b.name AS branch, b.status, b.current_snapshot_id AS snapshotId,
                      s.base_snapshot_id AS baseSnapshotId, s.commit_sha AS headCommit, s.merge_base_sha AS mergeBaseCommit,
                      s.state AS cacheState, s.last_accessed_at AS lastAccessedAt,
                      (SELECT COUNT(*) FROM snapshot_overlays o WHERE o.snapshot_id=s.id AND o.operation IN ('add','modify')) AS changedFiles,
                      (SELECT COUNT(*) FROM effective_snapshot_files e WHERE e.snapshot_id=s.id) AS totalFiles
                 FROM branches b JOIN repos r ON r.id=b.repo_id
                 LEFT JOIN revision_snapshots s ON s.id=b.current_snapshot_id ORDER BY r.name,b.name`,
            ).all() as Array<Record<string, unknown>>;
            const data: Array<Record<string, unknown>> = rows.map((row) => ({ ...row, baseCommit: row.baseSnapshotId ? (store.db.prepare("SELECT commit_sha AS commitSha FROM revision_snapshots WHERE id=?").get(row.baseSnapshotId) as { commitSha: string | null } | undefined)?.commitSha ?? null : null, reusePercent: row.totalFiles ? 100 - (Number(row.changedFiles) / Number(row.totalFiles) * 100) : null, pinned: Boolean(store.db.prepare("SELECT pinned FROM branches WHERE name=? AND current_snapshot_id=?").get(row.branch, row.snapshotId)) }));
            emit(deps, json, data.map((row) => `${row.repo}/${row.branch} ${row.cacheState ?? "legacy"} ${row.headCommit ?? "(none)"} reused=${row.reusePercent == null ? "—" : `${Math.round(Number(row.reusePercent))}%`}`).join("\n") || "(no revisions)", data);
            return 0;
          }
          const compact = flags.includes("--compact");
          const st = compact ? compactIndexStatus(store) : indexStatus(store);
          if (compact) {
            const summary = st as ReturnType<typeof compactIndexStatus>;
            emit(
              deps,
              json,
              summary.repos
                .map((repo) => `${repo.repo}\t${repo.liveBranch ?? "—"}\t${repo.freshness}\terrors=${repo.indexErrorCount}`)
                .join("\n") || "(no repos)",
              summary,
            );
            return 0;
          }
          const detailed = st as ReturnType<typeof indexStatus>;
          emit(deps, json,
            detailed.repos.map((r) => `${r.name}\t${r.branches.map((b) => `${b.name}(${b.status},stale=${b.staleSymbols})`).join(" ")}`).join("\n") || "(no repos)",
            detailed);
          return 0;
        }
        case "path": {
          let revision: import("@penguin/knowledge-core").RevisionContext | undefined;
          try { revision = resolveCliRevision(store, pos[0] ?? "", { repo: optionValue("repo"), branch: optionValue("branch"), commitSha: optionValue("commit"), snapshotId: optionValue("snapshot") }); }
          catch (error) { reportRevisionResolutionError(deps, error); return 2; }
          const res = exploreGraph(store, "path", pos[0] ?? "", { to: pos[1], revision });
          emit(deps, json, res.nodes.map((n) => n.title).join(" → ") || "(no path)", res);
          return 0;
        }
        case "suggestions": {
          const q = listSuggestions(store);
          emit(deps, json,
            q.map((s) => `${s.suggestionEventId}\t${s.src} → ${s.dst ?? "?"}  (${s.edgeType}, conf ${s.confidence})`).join("\n") || "(no pending suggestions)",
            q);
          return 0;
        }
        case "snapshots": {
          const snaps = store.listSnapshots();
          emit(deps, json,
            snaps.map((s) => `${s.ts}\t${s.name}\t${s.nodeIds.length} nodes`).join("\n") || "(no snapshots)",
            snaps);
          return 0;
        }
        case "doctor": {
          const check = store.consistencyCheck();
          const nodes = (store.db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n;
          const edges = (store.db.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }).n;
          const pending = listSuggestions(store).length;
          const report = { ...check, nodes, edges, pendingSuggestions: pending, verify: flags.includes("--verify") };
          emit(deps, json,
            `ledger seq ${check.ledgerSeq} / materialized ${check.materializedSeq} — ${check.status}` +
              (check.ledgerTruncatedAtLine ? ` (ledger truncated @line ${check.ledgerTruncatedAtLine})` : "") +
              `\nnodes ${nodes}, edges ${edges}, pending suggestions ${pending}`,
            report);
          return 0;
        }
        case "files": {
          const repoId = resolveRepoId(store, pos[0]);
          if (!repoId) { deps.err("repo not found (pass a repo id or name — see `penguin status`)"); return 1; }
          let branchId: string | null;
          try {
            branchId = resolveBranchId(store, repoId, pos[1]);
          } catch (error) {
            reportRevisionResolutionError(deps, error);
            return 2;
          }
          if (!branchId) { deps.err("branch not found for that repo"); return 1; }
          let revision: import("@penguin/knowledge-core").RevisionContext | undefined;
          try { revision = resolveCliRevision(store, pos[0] ?? "", { repo: pos[0], branch: optionValue("branch") ?? pos[1], commitSha: optionValue("commit"), snapshotId: optionValue("snapshot") }); }
          catch (error) { reportRevisionResolutionError(deps, error); return 2; }
          const files = listIndexedFiles(store, repoId, revision ? { revision } : branchId);
          emit(deps, json,
            files.map((f) => `${f.status === "indexed" ? " " : "·"} ${f.filePath}${f.lang ? `  [${f.lang}]` : ""}`).join("\n") || "(no files)",
            files);
          return 0;
        }
        case "filesymbols": {
          // filesymbols <branchId> <filePath> — Wiki passes the branch id from `files`.
          const syms = listFileSymbols(store, pos[0] ?? "", pos[1] ?? "");
          emit(deps, json, syms.map((s) => `${s.kind}\t${s.title}${s.status === "stale" ? " (stale)" : ""}`).join("\n") || "(no symbols)", syms);
          return 0;
        }
        case "graph": {
          const depth = pos[1] ? Number(pos[1]) || 1 : 1;
          const g = graphNeighborhood(store, pos[0] ?? "", { depth });
          if (!g.focus) { deps.err("node not found"); return 1; }
          emit(deps, json, `focus + ${g.nodes.length - 1} neighbours, ${g.edges.length} edges`, g);
          return 0;
        }
        case "repograph": {
          const repoId = resolveRepoId(store, pos[0]);
          if (!repoId) { deps.err("repo not found (pass a repo id or name — see `penguin status`)"); return 1; }
          let branchId: string | null;
          try {
            branchId = resolveBranchId(store, repoId, pos[1]);
          } catch (error) {
            reportRevisionResolutionError(deps, error);
            return 2;
          }
          if (!branchId) { deps.err("branch not found for that repo"); return 1; }
          const g = repoGraph(store, repoId, branchId);
          emit(deps, json, `${g.nodes.length} nodes, ${g.edges.length} edges`, g);
          return 0;
        }
        case "tags": {
          const tags = listTags(store);
          emit(deps, json, tags.join("\n") || "(no tags)", tags);
          return 0;
        }
        default: {
          const res = exploreGraph(store, GRAPH_VERB_MODE[verb], pos[0] ?? "");
          emit(deps, json, res.nodes.map((n) => `${n.nodeType}\t${n.title}`).join("\n") || "(none)", res);
          return 0;
        }
      }
    } finally {
      store.close();
    }
  }

  deps.err(`unknown command: ${verb} (try \`penguin help\`)`);
  return 2;
}

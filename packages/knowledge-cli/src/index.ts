import {
  compareBranches,
  exploreGraph,
  getNodeDetail,
  graphNeighborhood,
  indexStatus,
  listFileSymbols,
  listIndexedFiles,
  listSuggestions,
  repoGraph,
  search,
  type GraphMode,
  type KnowledgeStore,
} from "@penguin/knowledge-core";
import { indexRepo } from "@penguin/knowledge-indexer";

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
}

const READ_VERBS = new Set([
  "search", "node", "callers", "calls", "impact", "backlinks",
  "path", "recent", "compare", "status", "suggestions", "snapshots", "doctor",
  "files", "filesymbols", "graph", "repograph",
]);

// repo/branch args accept an id OR a name (humans pass names; the Wiki passes
// ids from `status`). Branch omitted → the repo's single/first branch.
function resolveRepoId(store: KnowledgeStore, s: string | undefined): string | null {
  if (!s) return null;
  const row = store.db
    .prepare("SELECT id FROM repos WHERE id=? OR name=? LIMIT 1")
    .get(s, s) as { id: string } | undefined;
  return row?.id ?? null;
}
function resolveBranchId(store: KnowledgeStore, repoId: string, s: string | undefined): string | null {
  if (!s) {
    const row = store.db
      .prepare("SELECT id FROM branches WHERE repo_id=? ORDER BY name LIMIT 1")
      .get(repoId) as { id: string } | undefined;
    return row?.id ?? null;
  }
  const row = store.db
    .prepare("SELECT id FROM branches WHERE repo_id=? AND (id=? OR name=?) LIMIT 1")
    .get(repoId, s, s) as { id: string } | undefined;
  return row?.id ?? null;
}
const GRAPH_VERB_MODE: Record<string, GraphMode> = {
  callers: "who_calls", calls: "calls_of", impact: "impact",
  backlinks: "backlinks", recent: "recent_changes",
};

function emit(deps: CliDeps, json: boolean, human: string, data: unknown): void {
  deps.out(json ? JSON.stringify(data) : human);
}

function progressBar(done: number, total: number): string {
  const width = 24;
  const frac = total > 0 ? Math.min(1, done / total) : 1;
  const filled = Math.round(frac * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return `[${bar}] ${String(Math.round(frac * 100)).padStart(3)}%  ${done}/${total}`;
}

function truncPath(p: string, max = 44): string {
  return p.length <= max ? p : "…" + p.slice(-(max - 1));
}

const HELP = `penguin — Penguin Knowledge CLI

  penguin init [path]           register + first-index a repo
  penguin index [path]          one-shot incremental index
  penguin rebuild [path]        full re-index (parser-derived data)
  penguin status                repos / branches / staleness
  penguin search <query>        unified search
  penguin node <id|name>        node detail + versions + aliases
  penguin callers <symbol>      who calls it
  penguin calls <symbol>        what it calls
  penguin impact <symbol>       transitive blast radius
  penguin backlinks <node>      who links it
  penguin path <a> <b>          shortest path a→b
  penguin recent                recent changes
  penguin compare <sym> <a> <b> cross-branch diff
  penguin files <repo> [branch] indexed files for a repo/branch
  penguin filesymbols <br> <f>  symbols defined in a file (branch id + path)
  penguin graph <node> [depth]  local graph: focus node + neighbours
  penguin repograph <repo> [br] repo/branch graph (top hubs by degree)
  penguin suggestions           pending AI edge suggestions
  penguin accept <event-id>     accept a suggestion
  penguin reject <event-id>     reject a suggestion
  penguin link <src> <dst> [t]  manually link two nodes (Ledger)
  penguin snapshots             list snapshot manifests
  penguin doctor                DB / ledger health check
  penguin install               symlink penguin onto PATH
  penguin help                  this help

Global: --json (machine-readable), --branch <b>`;

// The CLI is a thin shell: parse → call knowledge-core query layer / indexer →
// format (§8.3). No independent search/index logic. Returns an exit code.
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const verb = argv[0];
  const flags = argv.filter((a) => a.startsWith("--"));
  const pos = argv.slice(1).filter((a) => !a.startsWith("--"));
  const json = flags.includes("--json");

  if (!verb || verb === "help") {
    deps.out(HELP);
    return 0;
  }

  // write verbs
  if (verb === "init" || verb === "index" || verb === "rebuild") {
    const rootPath = pos[0] ?? deps.cwd;
    const store = deps.openStore();
    try {
      const progress = json ? undefined : deps.progress;
      const step = (total: number) => Math.max(1, Math.floor(total / 100)); // ~1% cadence
      const report = await indexRepo({
        store, rootPath, mode: verb === "rebuild" ? "rebuild" : "incremental",
        // Phased progress bar on stderr (stdout stays clean for --json).
        onProgress: progress
          ? (p) => {
              if (p.phase === "scan") {
                progress(`  Scanning files — ${p.total} found\n`);
                return;
              }
              if (p.done === p.total || p.done % step(p.total) === 0) {
                progress(`\r  Indexing  ${progressBar(p.done, p.total)}  ${truncPath(p.file)}\x1b[K`);
              }
            }
          : undefined,
      });
      if (progress) progress("\n");
      emit(deps, json,
        `${verb}: ${report.branchName} — ${report.parsed} parsed, ${report.skipped} skipped, ${report.deleted} deleted, ${report.renamed} renamed, ${report.errors} errors`,
        report);
      return 0;
    } catch (e) {
      const msg = (e as Error).message;
      deps.err(msg);
      return /already running/.test(msg) ? 4 : 1;
    } finally {
      store.close();
    }
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

  // ledger write verbs (may create the DB, §9)
  if (verb === "accept" || verb === "reject" || verb === "link" || verb === "snapshot") {
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
        case "search": {
          const hits = search(store, pos.join(" "), { includeSensitive: false });
          emit(deps, json, hits.map((h) => `${h.nodeType}\t${h.title}`).join("\n") || "(no results)", hits);
          return 0;
        }
        case "node": {
          const detail = getNodeDetail(store, pos[0] ?? "");
          if (!detail) { deps.err("node not found"); return 1; }
          emit(deps, json, `${detail.node.nodeType} ${detail.node.title}\nversions: ${detail.versions.length}\naliases: ${detail.aliases.length}`, detail);
          return 0;
        }
        case "compare": {
          const diff = compareBranches(store, pos[0] ?? "", pos[1] ?? "", pos[2] ?? "");
          if (!diff) { deps.err("symbol not found"); return 1; }
          emit(deps, json, diff.identical ? "identical (no diff)" : "differs", diff);
          return 0;
        }
        case "status": {
          const st = indexStatus(store);
          emit(deps, json,
            st.repos.map((r) => `${r.name}\t${r.branches.map((b) => `${b.name}(${b.status},stale=${b.staleSymbols})`).join(" ")}`).join("\n") || "(no repos)",
            st);
          return 0;
        }
        case "path": {
          const res = exploreGraph(store, "path", pos[0] ?? "", { to: pos[1] });
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
          const branchId = resolveBranchId(store, repoId, pos[1]);
          if (!branchId) { deps.err("branch not found for that repo"); return 1; }
          const files = listIndexedFiles(store, repoId, branchId);
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
          const branchId = resolveBranchId(store, repoId, pos[1]);
          if (!branchId) { deps.err("branch not found for that repo"); return 1; }
          const g = repoGraph(store, repoId, branchId);
          emit(deps, json, `${g.nodes.length} nodes, ${g.edges.length} edges`, g);
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

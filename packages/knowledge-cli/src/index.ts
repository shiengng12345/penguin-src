import {
  compareBranches,
  exploreGraph,
  getNodeDetail,
  indexStatus,
  search,
  type GraphMode,
  type KnowledgeStore,
} from "@penguin/knowledge-core";
import { indexRepo } from "@penguin/knowledge-indexer";

export interface CliDeps {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  // Opens the knowledge store (write verbs may create it). Kept a factory so
  // read verbs can refuse when none exists without creating a half-baked DB.
  openStore: () => KnowledgeStore;
  storeExists: () => boolean;
}

const READ_VERBS = new Set([
  "search", "node", "callers", "calls", "impact", "backlinks",
  "path", "recent", "compare", "status",
]);
const GRAPH_VERB_MODE: Record<string, GraphMode> = {
  callers: "who_calls", calls: "calls_of", impact: "impact",
  backlinks: "backlinks", recent: "recent_changes",
};

function emit(deps: CliDeps, json: boolean, human: string, data: unknown): void {
  deps.out(json ? JSON.stringify(data) : human);
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
      const report = await indexRepo({
        store, rootPath, mode: verb === "rebuild" ? "rebuild" : "incremental",
        // Progress on stderr (stdout stays clean for --json); shows life on
        // large repos and pinpoints a file if one ever hangs.
        onProgress: json
          ? undefined
          : ({ scanned, parsed, file }) => {
              if (scanned % 25 === 0 || parsed === 0) {
                deps.err(`  indexing… ${parsed} parsed / ${scanned} scanned  (${file})`);
              }
            },
      });
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

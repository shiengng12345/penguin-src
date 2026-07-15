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
  search,
  resolveSymbolMatches,
  renderAmbiguousSymbols,
  type GraphMode,
  type KnowledgeStore,
} from "@penguin/knowledge-core";
import { indexRepo, startWatcher, createNote, createIncident, appendNote, writeNoteBody, readNote, listNotes, reindexNotesDir } from "@penguin/knowledge-indexer";
import { resolveProvider, aiComplete } from "./ai.js";
import { runClaudeHook } from "./claude-hook.js";
import { createIndexRenderer } from "./render-progress.js";
import { discoverSubRepos, isGitRepo, type RepoCandidate } from "./multi-repo.js";

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
}

const READ_VERBS = new Set([
  "search", "node", "callers", "calls", "impact", "backlinks",
  "path", "recent", "compare", "status", "suggestions", "snapshots", "doctor",
  "files", "filesymbols", "graph", "repograph", "services", "tags", "context", "explore", "locate", "flow", "affected", "architecture", "communities", "timeline", "samples", "deadcode",
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

const HELP = `penguin — Penguin Knowledge CLI

  penguin init [path]           register + first-index a repo (folder of repos → interactive picker)
  penguin index [path]          one-shot incremental index
  penguin rebuild [path]        full re-index (parser-derived data)
  penguin watch [path]          long-running auto-index (debounced, stays running until killed)
  penguin remove <repo> [br]    remove a repo (or one branch) from the index
  penguin pin <repo> <branch>   toggle pin (pinned branches are never auto-pruned)
  penguin status                repos / branches / staleness
  penguin search <query>        unified search
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
  penguin link <src> <dst> [t]  manually link two nodes (Ledger)
  penguin snapshots             list snapshot manifests
  penguin doctor                DB / ledger health check
  penguin hook <event>          bounded, read-only agent context hook
  penguin install               symlink penguin onto PATH
  penguin help                  this help

Global: --json (machine-readable), --branch <b>`;

// The CLI is a thin shell: parse → call knowledge-core query layer / indexer →
// format (§8.3). No independent search/index logic. Returns an exit code.
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const verb = argv[0];
  const flags = argv.filter((a) => a.startsWith("--"));
  const valueFlags = new Set(["--branch", "--depth", "--limit", "--repo"]);
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
  const numberOption = (name: string): number | undefined => {
    const raw = optionValue(name);
    if (raw == null) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const json = flags.includes("--json");

  if (!verb || verb === "help") {
    deps.out(HELP);
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
    const store = deps.openStore();
    try {
      // --progress-events: emit structured progress (for the app/Rust bridge to
      // parse into Tauri events). Otherwise the live stage-tree renderer on
      // stderr (TTY only — bin.ts gates the sink on isTTY).
      const emitEvents = flags.includes("--progress-events") && !!deps.progressEvent;
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
            ? (p) => deps.progressEvent!({ ...p, rootPath: target })
            : renderer
            ? (p) => renderer.handle(p)
            : undefined,
        });
        renderer?.finish(report);
        if (emitEvents) {
          deps.progressEvent!({ phase: "complete", rootPath: target, report });
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
    const emitEvents = flags.includes("--progress-events") && !!deps.progressEvent;
    const handle = startWatcher({
      store,
      rootPath,
      onRun: (report) => {
        if (emitEvents) deps.progressEvent!({ phase: "watch-run", rootPath, report });
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
    if (emitEvents) deps.progressEvent!({ phase: "watch-started", rootPath });
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
        emit(deps, json, `reindexed ${r.indexed} notes`, r);
        return 0;
      }
      if (sub === "list" || sub === undefined) {
        const notes = listNotes(notesDir);
        emit(deps, json, notes.join("\n") || "(no notes)", notes);
        return 0;
      }
      deps.err("usage: penguin note <new|append|list|reindex> …");
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
          const table = hits
            .map((h) => `${h.nodeType}\t${h.identityKey}\t${h.filePath ?? "-"}\t${h.branch ?? "-"}\t${h.rank ?? "-"}`)
            .join("\n");
          emit(deps, json, table || "(no results)", hits);
          return 0;
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
          const pack = buildContextPack(store, pos.join(" "));
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
            depth: numberOption("depth"),
            limit: numberOption("limit"),
          });
          emit(deps, json, JSON.stringify(pack, null, 2), pack);
          return pack.focus || pack.callPath.length > 0 ? 0 : 1;
        }
        case "flow": {
          // Flow Explorer: linear execution chain from an endpoint/symbol.
          const flow = buildFlow(store, pos.join(" "));
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
          const a = affectedByFiles(store, pos);
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
          const t = timeline(store, { limit: pos[0] ? Number(pos[0]) || 50 : 50 });
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
          const diff = compareBranches(store, pos[0] ?? "", pos[1] ?? "", pos[2] ?? "");
          if (!diff) { deps.err("symbol not found"); return 1; }
          emit(deps, json, diff.identical ? "identical (no diff)" : "differs", diff);
          return 0;
        }
        case "status": {
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

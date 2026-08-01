import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function loadClient() {
  const source = await readFile(new URL("../src/lib/knowledge-client.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  // strip the @tauri-apps/api/core import — parseSearchFilters is pure and we
  // don't exercise invoke here.
  const stripped = outputText.replace(/import\s*\{[^}]*\}\s*from\s*["']@tauri-apps\/api\/core["'];?/, "const invoke = async () => '';");
  const encoded = Buffer.from(stripped).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

test("parseSearchFilters splits type:/repo:/tag:/entity: from free text", async () => {
  const { parseSearchFilters } = await loadClient();
  const r = parseSearchFilters("gameurl type:note repo:fpms tag:brazil rest words");
  assert.equal(r.query, "gameurl rest words");
  assert.deepEqual(r.filters, { type: "note", repo: "fpms", tag: "brazil" });

  const plain = parseSearchFilters("just a query");
  assert.equal(plain.query, "just a query");
  assert.deepEqual(plain.filters, {});
});

test("WikiPage is browse-only: no in-UI search, no why-layer rail", async () => {
  const source = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  // Wired data paths (browse: file symbols, context pack, graph, flow, timeline).
  for (const fn of ["knowledgeContext", "knowledgeDbStatus", "knowledgeServiceGraph", "knowledgeIndexStatus"]) {
    assert.match(source, new RegExp(fn), `WikiPage should use ${fn}`);
  }
  assert.match(source, /Copy for AI/); // context pack export for AI stays
  assert.match(source, /Indexed repositories/); // home = repo datatable, nothing else
  assert.ok(!/Flow<\/TabBtn>|Timeline<\/TabBtn>/.test(source), "only Context/Graph tabs");
  assert.match(source, /GraphStatsOverlay/);
  // Search is CLI/MCP-only — no UI search path remains.
  assert.ok(!source.includes("knowledgeSearch"), "no UI search call");
  assert.ok(!/searchQuery|runSearch|SEARCH_HINTS|SearchResultRow/.test(source), "no search state/UI");
  // Right rail (why layer) removed: two-column grid, no WikiWhyPanel.
  assert.ok(!source.includes("WikiWhyPanel"), "why-layer rail removed");
  assert.ok(!source.includes("gridTemplateColumns"), "single-pane centre, no sidebar grid");
});

test("knowledge-client routes through the Rust bridge commands", async () => {
  const source = await readFile(new URL("../src/lib/knowledge-client.ts", import.meta.url), "utf8");
  assert.match(source, /invoke<string>\("knowledge_query"/);
  assert.match(source, /invoke<KnowledgeDbStatus>\("knowledge_db_status"\)/);
  assert.match(source, /invoke<string>\("knowledge_reindex"/);
});

test("knowledge-client exposes index-browse + graph wrappers over the CLI verbs", async () => {
  const source = await readFile(new URL("../src/lib/knowledge-client.ts", import.meta.url), "utf8");
  // each wrapper maps to its CLI verb through the generic query() passthrough
  assert.match(source, /query<KnowledgeIndexStatus>\(\["status"\]/);
  assert.match(source, /query<KnowledgeFileRow\[\]>\(\["files", repoId, branchId\]/);
  assert.match(source, /query<KnowledgeFileSymbol\[\]>\(\["filesymbols", branchId, filePath\]/);
  assert.match(source, /query<KnowledgeGraphView>\(\["graph", node, String\(depth\)\]/);
  assert.match(source, /query<KnowledgeGraphView>\(\["repograph", repoId, branchId\]/);
});

test("WikiPage: single-pane centre (no explorer sidebar, no why rail)", async () => {
  const source = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  assert.match(source, /type CenterTab = "context" \| "graph"/);
  assert.ok(!source.includes("WikiBrowseTree"), "explorer sidebar removed");
  assert.ok(!source.includes("gridTemplateColumns"), "no multi-column grid");
  assert.match(source, /<WikiGraph/);
  assert.match(source, /layout=\{graphLayout\}/);
  assert.match(source, /knowledgeRepoGraph/);
  assert.match(source, /knowledgeGraph/);
  assert.match(source, /knowledgeRemoveRepo/, "repo delete wired in the datatable");
});

test("WikiBrowseTree lazy-loads repo→branch→file and can open a repo graph", async () => {
  const source = await readFile(new URL("../src/components/wiki/WikiBrowseTree.tsx", import.meta.url), "utf8");
  assert.match(source, /knowledgeIndexStatus/); // repos + branches
  assert.match(source, /knowledgeFiles\(repoId, branchId\)/); // files lazy per branch
  assert.match(source, /onSelectFile/);
  assert.match(source, /onOpenRepoGraph/);
  assert.match(source, /Filter repos, branches, files/);
  assert.match(source, /Explorer unavailable/);
});

test("WikiGraph renders via a dynamically-imported force-graph (code-split, defensive)", async () => {
  const source = await readFile(new URL("../src/components/wiki/WikiGraph.tsx", import.meta.url), "utf8");
  assert.match(source, /import\("force-graph"\)/); // dynamic → own chunk + graceful failure
  assert.match(source, /new ForceGraph\(el\)/);
  assert.match(source, /onNodeClick/);
  assert.match(source, /\.catch\(/); // load failure must not break the rest of the Wiki
});

test("WikiNoteEditor is a CodeMirror editor with search-backed [[ wikilink autocomplete", async () => {
  const source = await readFile(new URL("../src/components/wiki/WikiNoteEditor.tsx", import.meta.url), "utf8");
  assert.match(source, /@codemirror\/view/);
  assert.match(source, /autocompletion/);
  assert.match(source, /noteCompletionTrigger/); // uses the unit-tested trigger
  assert.match(source, /knowledgeSearch/); // wikilink candidates come from search
  assert.match(source, /apply: `\$\{h\.title\}\]\]`/); // completes to [[Title]]
  assert.match(source, /knowledgeTags/); // # tag candidates come from the tags endpoint
  assert.match(source, /trig\.kind === "wikilink"/); // both trigger kinds handled
});

test("note editing left the UI: notes are CLI/MCP-only now", async () => {
  const source = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  assert.ok(!source.includes("knowledgeNoteWrite"), "no note write in UI");
  assert.ok(!source.includes("WikiWhyPanel"), "why panel gone");
});

test("knowledge-client exposes note new/write/read/list wrappers", async () => {
  const source = await readFile(new URL("../src/lib/knowledge-client.ts", import.meta.url), "utf8");
  assert.match(source, /\["note", "new", title\]/);
  assert.match(source, /\["note", "write", slug, body\]/);
  assert.match(source, /\["note", "read", slug\]/);
  assert.match(source, /\["note", "list"\]/);
  assert.match(source, /\["tags"\]/);
});

test("isNoDatabaseError: fresh no-db state is recognized, real failures are not", async () => {
  const { isNoDatabaseError } = await loadClient();
  assert.equal(isNoDatabaseError("penguin CLI exit 3: no knowledge database — run `penguin init` or open Penguin app first"), true);
  assert.equal(isNoDatabaseError("no knowledge database — run `penguin init` first"), true);
  assert.equal(isNoDatabaseError("penguin CLI exit 1: SyntaxError: Invalid or unexpected token"), false);
  assert.equal(isNoDatabaseError("database is locked"), false);
});

test("empty index renders onboarding, not an error card (Explorer + page banner)", async () => {
  const tree = await readFile(new URL("../src/components/wiki/WikiBrowseTree.tsx", import.meta.url), "utf8");
  assert.match(tree, /isNoDatabaseError/, "Explorer distinguishes the no-db state");
  assert.match(tree, /penguin init/, "Explorer empty state teaches the init command");

  const page = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  assert.match(page, /isNoDatabaseError\(error\)/, "page banner distinguishes the no-db state");
});

test("fresh (no repos) renders a full-screen onboarding page instead of the wiki chrome", async () => {
  const page = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  assert.match(page, /WikiOnboarding/, "dedicated onboarding component exists");
  assert.match(page, /!status\.exists \|\| status\.repos === 0/, "fresh state = missing db or zero repos");
  assert.match(page, /penguin init/, "onboarding teaches the init command");
  assert.match(page, /setInterval\(refreshStatus/, "auto-detects when the first index lands");
});

test("onboarding offers one-click indexing (folder picker → in-app reindex → live progress)", async () => {
  const page = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  assert.match(page, /plugin-dialog/, "uses the official dialog plugin for folder pick");
  assert.match(page, /directory:\s*true/, "picks a directory, not a file");
  assert.match(page, /knowledgeReindex\(/, "runs the index through the app bridge");
  assert.match(page, /onIndexProgress/, "streams live progress into the onboarding card");
  assert.match(page, /选择仓库并索引/, "primary one-click CTA");
});

test("Wiki home shows live indexing progress outside onboarding", async () => {
  const page = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  assert.match(page, /function IndexProgressBanner\(/);
  assert.match(page, /onIndexProgress/);
  assert.match(page, /phase === "complete"/);
  assert.match(page, /IndexProgressBanner/);
});

test("onboarding one-click AI setup: penguin command + MCP clients + global agent guidance", async () => {
  const client = await readFile(new URL("../src/lib/knowledge-client.ts", import.meta.url), "utf8");
  assert.match(client, /knowledge_cli_status/, "cli status wrapper");
  assert.match(client, /knowledge_cli_setup/, "cli setup wrapper");
  assert.match(client, /mcp_install_to_local_clients/, "mcp install wrapper");
  assert.match(client, /knowledge_agent_guidance_setup/, "global guidance wrapper");

  const page = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  assert.match(page, /knowledgeCliStatus\(/, "onboarding checks CLI availability");
  assert.match(page, /knowledgeCliSetup\(/, "cli setup wired");
  assert.match(page, /mcpInstallToLocalClients\(/, "mcp setup wired");
  assert.match(page, /knowledgeAgentGuidanceSetup\(/, "guidance setup wired");
  assert.match(page, /一键配置 AI 集成/, "single aggregated CTA");
  assert.match(page, /新开一个终端/, "explains rc change needs a fresh terminal");
});

test("agent integration exposes opt-in Claude hooks and keeps Codex on canonical MCP guidance", async () => {
  const client = await readFile(new URL("../src/lib/knowledge-client.ts", import.meta.url), "utf8");
  assert.match(client, /knowledge_agent_hook_setup/, "typed hook setup wrapper");

  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(rust, /knowledge::knowledge_agent_hook_setup/, "hook command registered");

  const page = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  assert.match(page, /SessionStart compact status/);
  assert.match(page, /UserPromptSubmit bounded context/);
  assert.match(page, /Codex.*MCP.*AGENTS\.md/s, "Codex capability is stated honestly");
  assert.match(page, /knowledgeAgentHookSetup\(/, "selected hooks are wired");
  assert.match(page, /useState\(false\)/, "hook opt-in starts disabled");
});

test("Claude hook settings have an explicit apply/remove action", async () => {
  const page = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  assert.match(page, /应用 Hook 设置/);
  assert.match(page, /两项均关闭时移除 Penguin hooks/);
  assert.match(page, /const applyHooks = useCallback/);
  assert.match(
    page,
    /knowledgeAgentHookSetup\(hookSessionStart, hookPromptSubmit\)/,
    "false/false must reach the backend so managed hooks can be removed",
  );
});

test("filterGraphView hides unchecked node types and drops dangling edges", async () => {
  const { filterGraphView } = await loadClient();
  const view = {
    focus: "n1",
    nodes: [
      { nodeId: "n1", title: "a", nodeType: "symbol" },
      { nodeId: "n2", title: "b", nodeType: "endpoint" },
      { nodeId: "n3", title: "c", nodeType: "service" },
    ],
    edges: [
      { src: "n1", dst: "n2", edgeType: "invokes" },
      { src: "n2", dst: "n3", edgeType: "handles" },
    ],
  };
  const filtered = filterGraphView(view, new Set(["endpoint"]));
  assert.deepEqual(filtered.nodes.map((n) => n.nodeId), ["n1", "n3"]);
  assert.equal(filtered.edges.length, 0, "edges touching hidden nodes drop");
  const all = filterGraphView(view, new Set());
  assert.equal(all.nodes.length, 3);
  assert.equal(all.edges.length, 2);
});

test("graph overlay offers node-type checkboxes wired to the filter", async () => {
  const page = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  assert.match(page, /hiddenNodeTypes/, "filter state exists");
  assert.match(page, /filterGraphView\(/, "render uses the pure filter");
  assert.match(page, /type="checkbox"/, "checkbox UI");
});

test("GraphStatsOverlay is collapsible (collapsed to a pill, not fully hidden)", async () => {
  const page = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  const overlay = page.slice(page.indexOf("function GraphStatsOverlay"), page.indexOf("function WikiPage("));
  assert.match(overlay, /const \[collapsed, setCollapsed\] = useState/, "has a collapsed toggle state");
  assert.match(overlay, /if \(collapsed\)/, "renders a distinct collapsed branch");
  assert.match(overlay, /setCollapsed\(false\)/, "collapsed pill can re-expand");
  assert.match(overlay, /setCollapsed\(true\)/, "expanded header can collapse");
});

test("KnowledgeHomePanel (Indexed repositories) is collapsible and has a role-gated refresh", async () => {
  const page = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  const panel = page.slice(page.indexOf("function KnowledgeHomePanel"), page.indexOf("function GraphEmptyState"));
  // collapsible, not fully removed from the tree
  assert.match(panel, /const \[collapsed, setCollapsed\] = useState/, "has a collapsed toggle state");
  assert.match(panel, /setCollapsed\(\(c\) => !c\)/, "toggle button flips collapsed state");
  assert.match(panel, /\{!collapsed && \(/, "table body only, header always renders");
  // manual refresh: everyone gets a plain onClick button
  assert.match(panel, /onClick=\{\(\) => void manualRefresh\(\)\}/, "manual refresh via onClick — works regardless of role");
  // auto/"keep refreshing" is gated behind isSuperAdmin from the shared token-tier hook
  assert.match(panel, /useDeveloperMode\(\)/, "reuses the existing token-tier hook, not a new role system");
  assert.match(panel, /isSuperAdmin \&\& \(/, "auto-refresh control only renders for superadmin");
  assert.match(panel, /if \(!isSuperAdmin \|\| !autoRefresh\) return;/, "auto-refresh interval never runs for non-superadmin");
  // spin icon: ambient "auto-refresh is on" indicator (same convention as
  // PackageInstaller's refresh button), not just a brief in-flight spinner
  assert.match(
    panel,
    /\(refreshing \|\| \(isSuperAdmin && autoRefresh\)\) && "animate-spin"/,
    "refresh icon spins continuously while auto-refresh is on, matching PackageInstaller's existing convention",
  );
});

test("KnowledgeHomePanel: per-repo live auto-index toggle (penguin watch wire-up)", async () => {
  const page = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  const panel = page.slice(page.indexOf("function KnowledgeHomePanel"), page.indexOf("function GraphEmptyState"));
  assert.match(panel, /knowledgeWatchStatus/, "re-syncs from the Rust-side registry, not just local state");
  assert.match(panel, /knowledgeWatchToggle\(repo\.repoId, repo\.rootPath, enable\)/, "toggles by repoId + rootPath");
  assert.match(panel, /void toggleWatch\(repo\)/, "wired to a click handler on the repo row");
});

test("KnowledgeHomePanel: 自动刷新 preference survives a webview reload (persisted, not plain useState)", async () => {
  // Real bug: autoRefresh was a plain useState(false) — any webview reload
  // (right-click → Reload, or a full app restart) silently dropped the
  // toggle back to off, even though the user's whole point in turning it on
  // was to keep it running continuously in the background. Now persisted
  // the same way as the installer's registryAutoRefresh precedent.
  const page = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  const panel = page.slice(page.indexOf("function KnowledgeHomePanel"), page.indexOf("function GraphEmptyState"));
  assert.match(panel, /useAppStore\(\(s\) => s\.wikiAutoRefresh\)/, "reads from the persisted store, not a local useState");
  assert.match(panel, /useAppStore\(\(s\) => s\.setWikiAutoRefresh\)/, "writes through the persisted store setter");
  assert.doesNotMatch(panel, /const \[autoRefresh, setAutoRefresh\] = useState/, "no longer a plain unpersisted useState");

  const persistenceKeys = await readFile(new URL("../src/lib/persistence-keys.ts", import.meta.url), "utf8");
  assert.match(persistenceKeys, /wikiAutoRefresh: "penguin-wiki-auto-refresh"/, "registered under the shared APP_VALUE_KEYS registry");

  const store = await readFile(new URL("../src/lib/store.ts", import.meta.url), "utf8");
  assert.match(
    store,
    /wikiAutoRefresh: getPersistedValue\(APP_VALUE_KEYS\.wikiAutoRefresh\) === "true"/,
    "store initializes from the persisted value, not hardcoded false",
  );
});

test("KnowledgeHomePanel: bulk toggle turns watch on/off for every repo in one click", async () => {
  // Toggling watch one repo at a time doesn't scale once there are a dozen+
  // indexed repos — one button flips them all to the opposite of whatever
  // the current majority state is.
  const page = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  const panel = page.slice(page.indexOf("function KnowledgeHomePanel"), page.indexOf("function GraphEmptyState"));
  assert.match(
    panel,
    /indexRows!\.repos\.every\(\(r\) => watching\.has\(r\.repoId\)\)/,
    "allWatching reflects every currently-listed repo, not just one row",
  );
  assert.match(panel, /void bulkToggleWatch\(\)/, "wired to a click handler in the panel header");
  assert.match(
    panel,
    /indexRows\.repos\.map\(\(r\) =>\s*\n\s*knowledgeWatchToggle\(r\.repoId, r\.rootPath, enable\)/,
    "toggles every repo via the same knowledge_watch_toggle command as the per-row toggle",
  );
});

test("返回 (back) is not permanently disabled for the first symbol opened this session", async () => {
  // Bug: trail only grew via context-pane cross-reference clicks. The FIRST
  // symbol viewed (from a graph node click, or straight off the repo home
  // table) never got recorded as coming from anywhere, so trail.length was
  // always 1 for it and the back button stayed disabled no matter what.
  const page = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  assert.match(page, /\{ kind: "home" \}/, "a home nav-entry variant exists to represent the repo/branch table");
  assert.match(
    page,
    /t\.length === 0 \? \[\{ kind: "home" \}, \{ kind: "symbol", id \}\] : \[\.\.\.t, \{ kind: "symbol", id \}\]/,
    "the first-ever symbol selection seeds an implicit home entry beneath it",
  );
  assert.match(
    page,
    /if \(e\.kind === "home"\) \{ setError\(null\); setFocusId\(null\); setPack\(null\); return; \}/,
    "applyEntry resets to the home view when navigating back onto the home entry",
  );
});

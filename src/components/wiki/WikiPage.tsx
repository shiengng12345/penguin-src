import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Loader2,
  Network,
  Search,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TabBtn } from "@/components/wiki/WikiUIKit";
import { WikiGraph, type GraphLayout } from "@/components/wiki/WikiGraph";
import { WikiGraph3D } from "@/components/wiki/WikiGraph3D";
import { WikiContextPane } from "@/components/wiki/WikiContextPane";
import { ScopeBlockerPanel } from "@/components/wiki/ScopeBlockerPanel";
import { BranchPickerPopover, type BranchPickerOption } from "@/components/wiki/BranchPickerPopover";
import { WikiSearchPage } from "@/components/wiki/WikiSearchPage";
import { IndexProgressBanner } from "@/components/wiki/IndexProgressBanner";
import { WikiOnboarding } from "@/components/wiki/WikiOnboarding";
import { GraphEmptyState, GraphStatsOverlay, type GraphScope } from "@/components/wiki/GraphStatsOverlay";
import { WikiStatusFooter } from "@/components/wiki/WikiStatusFooter";
import {
  filterGraphView,
  formatKnowledgeError,
  isNoDatabaseError,
  knowledgeDbStatus,
  knowledgeGraph,
  knowledgeIndexStatus,
  knowledgeRepoGraph,
  knowledgeServiceGraph,
  knowledgeContext,
  ScopeBlockedError,
  type KnowledgeDbStatus,
  type KnowledgeGraphView,
  type ContextPack,
} from "@/lib/knowledge-client";

interface WikiPageProps { onClose: () => void }

type CenterTab = "search" | "graph";
// "home" = the repo/branch datatable (focusId null) — the implicit place
// every FIRST symbol view was reached from (a graph node click, or nothing
// yet). Without recording it, the very first symbol opened in a session had
// nothing behind it in the trail, so "返回" stayed permanently disabled no
// matter how the user got there.
type NavEntry = { kind: "symbol"; id: string } | { kind: "home" };

export function WikiPage({ onClose }: WikiPageProps) {
  const [status, setStatus] = useState<KnowledgeDbStatus | null>(null);
  const [error, setError] = useState<string | null>(null);


  const [focusId, setFocusId] = useState<string | null>(null);
  const [tab, setTab] = useState<CenterTab>("graph");

  const [pack, setPack] = useState<ContextPack | null>(null);
  const [packBusy, setPackBusy] = useState(false);
  // Phase 1B Task 8: a Context load can come back BRANCH_NOT_INDEXED/
  // SCOPE_NOT_FOUND now that the bridge no longer auto-falls-back — render
  // the actionable blocker instead of the generic yellow error banner (which
  // would otherwise just show raw JSON, since ScopeBlockedError's message is
  // the CLI's structured payload text). `scopeBlockRetrying` only covers the
  // explicit "answer anyway" retry, not the initial load (packBusy already
  // covers that).
  const [scopeBlock, setScopeBlock] = useState<ScopeBlockedError | null>(null);
  const [scopeBlockRetrying, setScopeBlockRetrying] = useState(false);
  // The last id `loadPack` was asked for — lets the blocker's retry button
  // re-issue the SAME request with --allow-fallback without the caller
  // having to thread the target through separately.
  const lastContextTarget = useRef<string | null>(null);
  const [graphData, setGraphData] = useState<KnowledgeGraphView | null>(null);
  const [graphBusy, setGraphBusy] = useState(false);
  const [graphLayout, setGraphLayout] = useState<GraphLayout>("radial");
  const [graphScope, setGraphScope] = useState<GraphScope | null>(null);
  // Node types the user has un-checked in the graph overlay. Survives graph
  // switches on purpose — a preference, not per-view state.
  const [hiddenNodeTypes, setHiddenNodeTypes] = useState<Set<string>>(new Set());
  // Per-node picks (service map: choose repos to display). Reset on every
  // graph switch — node ids from one view mean nothing in the next.
  const [hiddenNodeIds, setHiddenNodeIds] = useState<Set<string>>(new Set());

  const [trail, setTrail] = useState<NavEntry[]>([]);
  // Service-graph node click when its repo has 2+ live branches: Core refuses
  // to guess (resolveRevisionContext's "multiple live branches" ambiguity),
  // so the UI stops silently doing `find(live) ?? [0]` too — this holds the
  // popover's anchor + candidate branches until the user explicitly picks one.
  const [branchPicker, setBranchPicker] = useState<{ repoId: string; anchor: { x: number; y: number }; branches: BranchPickerOption[] } | null>(null);

  const refreshStatus = useCallback(() => { knowledgeDbStatus().then(setStatus).catch(() => setStatus(null)); }, []);
  useEffect(refreshStatus, [refreshStatus]);

  const err = (e: unknown) => setError(formatKnowledgeError(e));

  // Guard against out-of-order async responses: when the user switches symbols
  // or graphs quickly, only the most recent request is allowed to write state.
  // Without this, a slow earlier response can land after a faster later one and
  // clobber the view with stale data. Every graph-loading path shares one id so
  // "last graph requested wins" holds across local/repo/service graphs too.
  const packReqId = useRef(0);
  const graphReqId = useRef(0);

  const loadPack = useCallback(async (id: string, options: { allowFallback?: boolean } = {}) => {
    const reqId = ++packReqId.current;
    lastContextTarget.current = id;
    setPackBusy(true);
    if (!options.allowFallback) setScopeBlock(null);
    try {
      const p = await knowledgeContext(id, { allowFallback: options.allowFallback });
      if (reqId === packReqId.current) { setPack(p); setScopeBlock(null); }
    } catch (e) {
      if (reqId !== packReqId.current) return;
      if (e instanceof ScopeBlockedError) setScopeBlock(e);
      else err(e);
    }
    finally { if (reqId === packReqId.current) { setPackBusy(false); setScopeBlockRetrying(false); } }
  }, []);
  const retryContextWithFallback = useCallback(() => {
    if (!lastContextTarget.current) return;
    setScopeBlockRetrying(true);
    void loadPack(lastContextTarget.current, { allowFallback: true });
  }, [loadPack]);
  const loadGraph = useCallback(async (id: string) => {
    const reqId = ++graphReqId.current;
    setGraphBusy(true); setHiddenNodeIds(new Set());
    setGraphScope({ title: "Local graph", detail: "Focused symbol neighbourhood" });
    try {
      const g = await knowledgeGraph(id, 1);
      if (reqId === graphReqId.current) setGraphData(g);
    } catch (e) { if (reqId === graphReqId.current) err(e); }
    finally { if (reqId === graphReqId.current) setGraphBusy(false); }
  }, []);

  const selectSymbol = useCallback((id: string, record = true) => {
    setError(null); setFocusId(id); setTab("graph");
    // An empty trail means this is the FIRST symbol viewed this session (from
    // a graph node click, or straight off the repo/branch home table) — seed
    // an implicit "home" entry underneath it so "返回" has somewhere to go
    // back to, instead of starting permanently disabled.
    if (record) setTrail((t) => (t.length === 0 ? [{ kind: "home" }, { kind: "symbol", id }] : [...t, { kind: "symbol", id }]));
    void loadPack(id);
  }, [loadPack]);

  const openRepoGraph = useCallback(async (repoId: string, branchId: string) => {
    const reqId = ++graphReqId.current;
    setError(null); setFocusId(null); setTab("graph"); setGraphBusy(true); setHiddenNodeIds(new Set());
    setGraphScope({ title: "Repo graph", detail: "Top connected symbols in this branch" });
    try { const g = await knowledgeRepoGraph(repoId, branchId); if (reqId === graphReqId.current) setGraphData(g); } catch (e) { if (reqId === graphReqId.current) err(e); } finally { if (reqId === graphReqId.current) setGraphBusy(false); }
  }, []);

  const openServiceGraph = useCallback(async () => {
    const reqId = ++graphReqId.current;
    setError(null); setFocusId(null); setTab("graph"); setGraphBusy(true); setHiddenNodeIds(new Set());
    setGraphScope({ title: "Service map", detail: "Only cross-service invokes and package dependencies" });
    try { const g = await knowledgeServiceGraph(); if (reqId === graphReqId.current) setGraphData(g); } catch (e) { if (reqId === graphReqId.current) err(e); } finally { if (reqId === graphReqId.current) setGraphBusy(false); }
  }, []);

  // Graph node clicks: service-map nodes carry a repo id (not a graph node), so
  // focusing them as a symbol would fail ("node not found"). Route service nodes
  // to their repo graph; symbols/endpoints resolve normally.
  //
  // Multiple live branches on that repo is a genuine ambiguity Core itself
  // refuses to silently resolve (see resolveRevisionContext's "multiple live
  // branches; pass --branch, --commit, or --snapshot" error) — so instead of
  // `find(live) ?? [0]`, show a popover anchored at the click and require an
  // explicit pick. Exactly one live branch (the common case) still opens
  // directly, unchanged.
  const onGraphNodeClick = useCallback((id: string, event?: MouseEvent) => {
    const node = graphData?.nodes.find((n) => n.nodeId === id);
    if (node?.nodeType === "service") {
      void knowledgeIndexStatus()
        .then((s) => {
          const repo = s.repos.find((r) => r.repoId === id);
          if (!repo) return;
          const live = repo.branches.filter((b) => b.status === "live");
          if (live.length > 1) {
            setBranchPicker({
              repoId: id,
              anchor: { x: event?.clientX ?? window.innerWidth / 2, y: event?.clientY ?? window.innerHeight / 2 },
              branches: repo.branches.map((b) => ({ branchId: b.branchId, name: b.name, status: b.status, lastIndexedAt: b.lastIndexedAt })),
            });
            return;
          }
          const branch = live[0] ?? repo.branches[0];
          if (branch) return openRepoGraph(id, branch.branchId);
        })
        .catch(err);
      return;
    }
    selectSymbol(id);
  }, [graphData, openRepoGraph, selectSymbol]);

  const pickBranch = useCallback((branchId: string) => {
    if (!branchPicker) return;
    const { repoId } = branchPicker;
    setBranchPicker(null);
    void openRepoGraph(repoId, branchId);
  }, [branchPicker, openRepoGraph]);

  useEffect(() => {
    if (!focusId) return;
    if (tab === "graph" && graphData?.focus !== focusId) void loadGraph(focusId);
  }, [focusId, tab, graphData?.focus, loadGraph]);

  // Graph tab with nothing selected: load the service map instead of showing
  // a "needs a focus" empty card — the map is the natural whole-fleet default.
  useEffect(() => {
    if (tab === "graph" && !focusId && !graphData && !graphBusy) void openServiceGraph();
  }, [tab, focusId, graphData, graphBusy, openServiceGraph]);

  const applyEntry = useCallback((e: NavEntry) => {
    if (e.kind === "home") { setError(null); setFocusId(null); setPack(null); setScopeBlock(null); return; }
    selectSymbol(e.id, false);
  }, [selectSymbol]);
  const back = useCallback(() => {
    setTrail((t) => { if (t.length <= 1) return []; const next = t.slice(0, -1); applyEntry(next[next.length - 1]); return next; });
  }, [applyEntry]);

  // Fresh install / index deleted: no DB yet, or a DB with zero repos.
  const fresh = status != null && (!status.exists || status.repos === 0);
  useEffect(() => {
    if (!fresh) return;
    const t = setInterval(refreshStatus, 5000);
    return () => clearInterval(t);
  }, [fresh, refreshStatus]);
  // Warm the two expensive top-level tabs after the first paint. Both queries
  // share the client cache, so opening a tab while this is running reuses the
  // same promise instead of spawning another CLI/SQLite process.
  useEffect(() => {
    if (fresh) return;
    const timer = window.setTimeout(() => {
      void import("force-graph").catch(() => undefined);
      void knowledgeServiceGraph().catch(() => undefined);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [fresh]);
  if (fresh) {
    return <WikiOnboarding onRefresh={refreshStatus} onClose={onClose} />;
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {error && !isNoDatabaseError(error) && <div className="mx-6 mt-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-200">{error}</div>}
      <IndexProgressBanner />

      <div className="flex min-h-0 flex-1 flex-col">
        <section className="flex min-h-0 min-w-0 flex-col bg-background">
          <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-card px-3">
            <TabBtn on={tab === "search"} onClick={() => setTab("search")} icon={<Search className="h-3.5 w-3.5" />}>Focus</TabBtn>
            <TabBtn on={tab === "graph"} onClick={() => setTab("graph")} icon={<Network className="h-3.5 w-3.5" />}>Graph</TabBtn>
            <div className="ml-auto flex items-center gap-2">
              {tab === "graph" && graphData && (
                <div className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background/40 p-0.5 text-xs">
                  <button type="button" onClick={() => setGraphLayout("radial")} className={cn("whitespace-nowrap rounded px-2 py-0.5", graphLayout === "radial" ? "bg-cyan-500/15 text-cyan-200" : "text-muted-foreground hover:bg-accent")}>整洁</button>
                  <button type="button" onClick={() => setGraphLayout("force")} className={cn("whitespace-nowrap rounded px-2 py-0.5", graphLayout === "force" ? "bg-cyan-500/15 text-cyan-200" : "text-muted-foreground hover:bg-accent")}>力导向</button>
                  <button type="button" onClick={() => setGraphLayout("3d")} className={cn("whitespace-nowrap rounded px-2 py-0.5", graphLayout === "3d" ? "bg-cyan-500/15 text-cyan-200" : "text-muted-foreground hover:bg-accent")}>3D</button>
                </div>
              )}
              <button type="button" onClick={back} disabled={trail.length <= 1} title="返回上一步"
                className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-foreground hover:bg-accent disabled:opacity-30">
                <ArrowLeft className="h-3.5 w-3.5" /> 返回
              </button>
              <button type="button" onClick={onClose} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="关闭"><X className="h-4 w-4" /></button>
            </div>
          </div>

          {tab === "search" ? <WikiSearchPage /> : (
            <div className="relative flex min-h-0 flex-1">
              <div className="relative flex min-w-0 flex-1">
                {graphBusy ? <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> 加载图谱…</div>
                  : graphData && graphData.nodes.length > 0
                    ? (() => {
                        const shown = filterGraphView(graphData, hiddenNodeTypes, hiddenNodeIds);
                        const toggleNode = (id: string) =>
                          setHiddenNodeIds((cur) => {
                            const next = new Set(cur);
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                            return next;
                          });
                        const toggleType = (t: string) =>
                          setHiddenNodeTypes((cur) => {
                            const next = new Set(cur);
                            if (next.has(t)) next.delete(t);
                            else next.add(t);
                            return next;
                          });
                        return (
                          <>
                            {graphLayout === "3d"
                              ? <WikiGraph3D data={shown} onNodeClick={onGraphNodeClick} />
                              : <WikiGraph data={shown} layout={graphLayout} onNodeClick={onGraphNodeClick} />}
                            <GraphStatsOverlay scope={graphScope} raw={graphData} shown={shown} hidden={hiddenNodeTypes} hiddenIds={hiddenNodeIds} onToggleType={toggleType} onToggleNode={toggleNode} />
                          </>
                        );
                      })()
                    : <GraphEmptyState onOpenServiceGraph={() => void openServiceGraph()} />}
              </div>
              {focusId && (
                <aside aria-label="Relations" className="hidden w-[22rem] shrink-0 border-l border-border bg-background/80 xl:block">
                  {scopeBlock
                    ? <ScopeBlockerPanel error={scopeBlock} onRetry={retryContextWithFallback} retrying={scopeBlockRetrying} />
                    : <WikiContextPane packBusy={packBusy} pack={pack} onSelectSymbol={selectSymbol} />}
                </aside>
              )}
            </div>
          )}
        </section>

      </div>

      <WikiStatusFooter />
      {branchPicker && (
        <BranchPickerPopover
          branches={branchPicker.branches}
          anchor={branchPicker.anchor}
          onPick={pickBranch}
          onClose={() => setBranchPicker(null)}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ClipboardList,
  Loader2,
  Network,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TabBtn } from "@/components/wiki/WikiUIKit";
import { WikiGraph, type GraphLayout } from "@/components/wiki/WikiGraph";
import { WikiGraph3D } from "@/components/wiki/WikiGraph3D";
import { WikiContextPane } from "@/components/wiki/WikiContextPane";
import { EvidenceInbox } from "@/components/wiki/EvidenceInbox";
import { WikiSearchPage } from "@/components/wiki/WikiSearchPage";
import { IndexProgressBanner } from "@/components/wiki/IndexProgressBanner";
import { WikiOnboarding } from "@/components/wiki/WikiOnboarding";
import { KnowledgeHomePanel } from "@/components/wiki/KnowledgeHomePanel";
import { GraphEmptyState, GraphStatsOverlay, type GraphScope } from "@/components/wiki/GraphStatsOverlay";
import { WikiStatusFooter } from "@/components/wiki/WikiStatusFooter";
import {
  filterGraphView,
  formatKnowledgeError,
  isNoDatabaseError,
  knowledgeDbStatus,
  knowledgeEvidenceList,
  knowledgeGraph,
  knowledgeIndexStatus,
  knowledgeRepoGraph,
  knowledgeServiceGraph,
  knowledgeContext,
  type KnowledgeDbStatus,
  type KnowledgeGraphView,
  type ContextPack,
} from "@/lib/knowledge-client";

interface WikiPageProps { onClose: () => void }

type CenterTab = "search" | "context" | "graph" | "evidence";
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
  const [tab, setTab] = useState<CenterTab>("search");

  const [pack, setPack] = useState<ContextPack | null>(null);
  const [packBusy, setPackBusy] = useState(false);
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

  const loadPack = useCallback(async (id: string) => {
    const reqId = ++packReqId.current;
    setPackBusy(true);
    try {
      const p = await knowledgeContext(id);
      if (reqId === packReqId.current) setPack(p);
    } catch (e) { if (reqId === packReqId.current) err(e); }
    finally { if (reqId === packReqId.current) setPackBusy(false); }
  }, []);
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
    setError(null); setFocusId(id);
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
  const onGraphNodeClick = useCallback((id: string) => {
    const node = graphData?.nodes.find((n) => n.nodeId === id);
    if (node?.nodeType === "service") {
      void knowledgeIndexStatus()
        .then((s) => {
          const repo = s.repos.find((r) => r.repoId === id);
          const branch = repo?.branches.find((b) => b.status === "live") ?? repo?.branches[0];
          if (branch) return openRepoGraph(id, branch.branchId);
        })
        .catch(err);
      return;
    }
    selectSymbol(id);
  }, [graphData, openRepoGraph, selectSymbol]);

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
    if (e.kind === "home") { setError(null); setFocusId(null); setPack(null); return; }
    selectSymbol(e.id, false);
  }, [selectSymbol]);
  const back = useCallback(() => {
    setTrail((t) => { if (t.length <= 1) return []; const next = t.slice(0, -1); applyEntry(next[next.length - 1]); return next; });
  }, [applyEntry]);

  const copyPack = () => {
    if (!pack?.focus) return;
    const L = [`# ${pack.focus.title} (${pack.focus.kind ?? pack.focus.nodeType})`, `file: ${pack.focus.filePath ?? "?"}`,
      `branch: ${pack.focus.branches.map((b) => `${b.branch} (${b.status})`).join(", ")}`, ""];
    if (pack.signals.length) L.push("## Signals", ...pack.signals.map((s) => `- ${s}`), "");
    if (pack.focus.source) L.push("## Source", "```", pack.focus.source, "```", "");
    const sec = (t: string, a: { title: string }[]) => { if (a.length) L.push(`## ${t}`, ...a.map((x) => `- ${x.title}`), ""); };
    sec("Called by", pack.callers); sec("Calls", pack.calls); sec("Used by (type)", pack.referencedBy);
    sec("Tested by", pack.tests); sec("Imported by", pack.importers);
    if (pack.routes.length) L.push("## Routes", ...pack.routes.map((r) => `- ${r.route}`), "");
    if (pack.errors.length) L.push("## Throws", ...pack.errors.map((e) => `- ${e}`), "");
    void navigator.clipboard?.writeText(L.join("\n"));
  };

  const f = pack?.focus;
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
      void knowledgeEvidenceList({ limit: 100 }).catch(() => undefined);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [fresh]);
  if (fresh) {
    return <WikiOnboarding onRefresh={refreshStatus} onClose={onClose} />;
  }

  return (
    <div className="flex h-full flex-col bg-[#070b11] text-slate-100">
      {error && !isNoDatabaseError(error) && <div className="mx-6 mt-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-200">{error}</div>}
      <IndexProgressBanner />

      <div className="flex min-h-0 flex-1 flex-col">
        <section className="flex min-h-0 min-w-0 flex-col bg-[#080d14]">
          <div className="flex h-12 shrink-0 items-center gap-1 border-b border-slate-800 bg-[#0d1420] px-3">
            <TabBtn on={tab === "search"} onClick={() => setTab("search")} icon={<Search className="h-3.5 w-3.5" />}>Search</TabBtn>
            <TabBtn on={tab === "context"} onClick={() => setTab("context")} icon={<Sparkles className="h-3.5 w-3.5" />}>Context</TabBtn>
            <TabBtn on={tab === "graph"} onClick={() => setTab("graph")} icon={<Network className="h-3.5 w-3.5" />}>Graph</TabBtn>
            <TabBtn on={tab === "evidence"} onClick={() => setTab("evidence")} icon={<ClipboardList className="h-3.5 w-3.5" />}>SLS Evidence</TabBtn>
            <div className="ml-auto flex items-center gap-2">
              {tab === "graph" && graphData && (
                <div className="flex shrink-0 items-center gap-1 rounded-md border border-slate-800 bg-slate-950/40 p-0.5 text-xs">
                  <button type="button" onClick={() => setGraphLayout("radial")} className={cn("whitespace-nowrap rounded px-2 py-0.5", graphLayout === "radial" ? "bg-cyan-500/15 text-cyan-200" : "text-slate-400 hover:bg-white/5")}>整洁</button>
                  <button type="button" onClick={() => setGraphLayout("force")} className={cn("whitespace-nowrap rounded px-2 py-0.5", graphLayout === "force" ? "bg-cyan-500/15 text-cyan-200" : "text-slate-400 hover:bg-white/5")}>力导向</button>
                  <button type="button" onClick={() => setGraphLayout("3d")} className={cn("whitespace-nowrap rounded px-2 py-0.5", graphLayout === "3d" ? "bg-cyan-500/15 text-cyan-200" : "text-slate-400 hover:bg-white/5")}>3D</button>
                </div>
              )}
              {tab === "context" && f && (
                <button type="button" onClick={copyPack} className="flex h-8 items-center gap-1.5 rounded-lg bg-cyan-400 px-2.5 text-xs font-bold text-[#04121a] hover:bg-cyan-300"><Sparkles className="h-3.5 w-3.5" />Copy for AI</button>
              )}
              <button type="button" onClick={back} disabled={trail.length <= 1} title="返回上一步"
                className="flex h-7 items-center gap-1 rounded-md border border-slate-800 px-2 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-30">
                <ArrowLeft className="h-3.5 w-3.5" /> 返回
              </button>
              <button type="button" onClick={onClose} className="rounded p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-100" aria-label="关闭"><X className="h-4 w-4" /></button>
            </div>
          </div>

          {tab === "search" ? <WikiSearchPage /> : tab === "context" ? (
            f ? <WikiContextPane packBusy={packBusy} pack={pack} onSelectSymbol={selectSymbol} /> : (
              <KnowledgeHomePanel
                onOpenRepoGraph={(r, b) => void openRepoGraph(r, b)}
              />
            )
          ) : tab === "graph" ? (
            <div className="relative flex min-h-0 flex-1">
              {graphBusy ? <div className="flex flex-1 items-center justify-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> 加载图谱…</div>
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
          ) : (
            <div className="min-h-0 flex-1 overflow-auto p-6">
              <EvidenceInbox />
            </div>
          )}
        </section>

      </div>

      <WikiStatusFooter />
    </div>
  );
}

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Box,
  Clock,
  Database,
  FileCode,
  FileText,
  GitBranch,
  Loader2,
  Network,
  Search,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Dot, TabBtn } from "@/components/wiki/WikiUIKit";
import { WikiBrowseTree } from "@/components/wiki/WikiBrowseTree";
import { WikiGraph, type GraphLayout } from "@/components/wiki/WikiGraph";
import { WikiGraph3D } from "@/components/wiki/WikiGraph3D";
import { WikiContextPane } from "@/components/wiki/WikiContextPane";
import { WikiFlowPane } from "@/components/wiki/WikiFlowPane";
import { WikiTimelinePane } from "@/components/wiki/WikiTimelinePane";
import { WikiWhyPanel } from "@/components/wiki/WikiWhyPanel";
import {
  formatKnowledgeError,
  knowledgeDbStatus,
  knowledgeExplore,
  knowledgeFileSymbols,
  knowledgeGraph,
  knowledgeIndexStatus,
  knowledgeRepoGraph,
  knowledgeServiceGraph,
  knowledgeContext,
  knowledgeFlow,
  knowledgeSearch,
  knowledgeTimeline,
  type KnowledgeTimelineEntry,
  knowledgeNoteWrite,
  knowledgeNoteRead,
  knowledgeNoteNewTyped,
  type KnowledgeNoteType,
  type KnowledgeDbStatus,
  type KnowledgeFileSymbol,
  type KnowledgeGraphView,
  type KnowledgeSearchHit,
  type ContextPack,
  type FlowResult,
} from "@/lib/knowledge-client";

interface WikiPageProps { onClose: () => void }

type CenterTab = "context" | "graph" | "flow" | "timeline";
type NavEntry = { kind: "symbol"; id: string } | { kind: "file"; branchId: string; filePath: string };
type GraphScope = { title: string; detail: string };

const SEARCH_HINTS = ["GetLoginURL", "providerId", "type:incident", "repo:FPMS-NT"];

function MetricPill({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-950/50 px-2.5 py-1 text-[11px] text-slate-400">
      <b className="font-mono text-slate-100">{value}</b>{label}
    </span>
  );
}

function SearchResultRow({
  hit,
  onSelect,
}: {
  hit: KnowledgeSearchHit;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(hit.nodeId)}
      className="group flex w-full items-start gap-3 rounded-lg border border-slate-800 bg-[#0f1722]/80 px-3 py-2.5 text-left hover:border-cyan-500/40 hover:bg-cyan-500/[0.06]"
    >
      <div className="mt-1"><Dot t={hit.nodeType} /></div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm font-semibold text-slate-100">{hit.title}</span>
          <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[9px] uppercase text-slate-500">{hit.nodeType}</span>
        </div>
        {hit.snippet && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-500">{hit.snippet}</p>}
      </div>
      <ArrowRight className="mt-1 h-3.5 w-3.5 shrink-0 text-slate-600 group-hover:text-cyan-300" />
    </button>
  );
}

function QuickAction({
  icon,
  title,
  text,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border border-slate-800 bg-[#0f1722]/75 p-4 text-left transition hover:border-cyan-500/40 hover:bg-cyan-500/[0.06]"
    >
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 text-cyan-200">
        {icon}
      </div>
      <div className="text-sm font-semibold text-slate-100">{title}</div>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">{text}</p>
    </button>
  );
}

function KnowledgeHomePanel({
  status,
  searchQuery,
  searchResults,
  searchBusy,
  selectedFile,
  fileSymbols,
  onRunSearch,
  onSelectSymbol,
  onOpenServiceGraph,
  onOpenTimeline,
  onCreateIncident,
}: {
  status: KnowledgeDbStatus | null;
  searchQuery: string;
  searchResults: KnowledgeSearchHit[] | null;
  searchBusy: boolean;
  selectedFile: { branchId: string; filePath: string } | null;
  fileSymbols: KnowledgeFileSymbol[];
  onRunSearch: (query: string) => void;
  onSelectSymbol: (id: string) => void;
  onOpenServiceGraph: () => void;
  onOpenTimeline: () => void;
  onCreateIncident: () => void;
}) {
  const hasResults = searchResults && searchResults.length > 0;

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_20%_0%,rgba(34,211,238,0.08),transparent_34%),linear-gradient(180deg,#070c13_0%,#0a0f17_100%)] p-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <section className="rounded-2xl border border-slate-800 bg-[#0d1420]/85 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.24)]">
          <div className="flex flex-wrap items-start gap-4">
            <div className="min-w-0 flex-1">
              <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-cyan-300">
                <Sparkles className="h-3.5 w-3.5" />Knowledge command center
              </div>
              <h2 className="text-xl font-semibold tracking-normal text-slate-50">先搜，再看上下文、图谱和 why 记录。</h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">
                用 symbol、API、config、case 或实体开始。结果打开后会进入 Context Pack，右侧显示关联笔记和新鲜度。
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <MetricPill label="repos" value={status?.repos ?? "-"} />
              <MetricPill label="symbols" value={status?.symbols ?? "-"} />
              <MetricPill label="notes" value={status?.notes ?? "-"} />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {SEARCH_HINTS.map((hint) => (
              <button
                key={hint}
                type="button"
                onClick={() => onRunSearch(hint)}
                className="rounded-md border border-slate-800 bg-slate-950/45 px-2.5 py-1 font-mono text-[11px] text-slate-400 hover:border-cyan-500/30 hover:text-cyan-200"
              >
                {hint}
              </button>
            ))}
          </div>
        </section>

        {searchBusy && (
          <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-[#0f1722]/70 px-4 py-3 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin text-cyan-300" /> 正在搜索知识图谱…
          </div>
        )}

        {searchResults && !searchBusy && (
          <section className="rounded-2xl border border-slate-800 bg-[#0d1420]/85 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-slate-100">Search results</div>
                <div className="text-xs text-slate-500">{searchQuery || "current query"} · {searchResults.length} matches</div>
              </div>
            </div>
            {hasResults ? (
              <div className="space-y-2">
                {searchResults.slice(0, 12).map((hit) => (
                  <SearchResultRow key={hit.nodeId} hit={hit} onSelect={onSelectSymbol} />
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-800 px-4 py-8 text-center text-sm text-slate-500">
                没找到结果。试试只搜 method 名、config key，或加上 <span className="font-mono text-slate-300">repo:</span> 缩小范围。
              </div>
            )}
          </section>
        )}

        {selectedFile && fileSymbols.length > 0 && !searchResults && (
          <section className="rounded-2xl border border-slate-800 bg-[#0d1420]/85 p-4">
            <div className="mb-3 flex items-center gap-2">
              <FileCode className="h-4 w-4 text-cyan-300" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-sm font-semibold text-slate-100">{selectedFile.filePath}</div>
                <div className="text-xs text-slate-500">{fileSymbols.length} indexed symbols</div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {fileSymbols.slice(0, 18).map((symbol) => (
                <button
                  key={symbol.nodeId}
                  type="button"
                  onClick={() => onSelectSymbol(symbol.nodeId)}
                  className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/35 px-3 py-2 text-left font-mono text-xs text-slate-300 hover:border-cyan-500/30 hover:text-cyan-100"
                >
                  <Box className="h-3.5 w-3.5 shrink-0 text-cyan-300/70" />
                  <span className="min-w-0 flex-1 truncate">{symbol.title}</span>
                  <span className="text-[9px] uppercase text-slate-600">{symbol.kind}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="grid grid-cols-3 gap-3">
          <QuickAction
            icon={<Search className="h-4 w-4" />}
            title="Find a symbol"
            text="从 method、service、DTO、config key 进入上下文。"
            onClick={() => onRunSearch(searchQuery || "GetLoginURL")}
          />
          <QuickAction
            icon={<Network className="h-4 w-4" />}
            title="Open service map"
            text="查看跨 repo / microservice 的主要连接。"
            onClick={onOpenServiceGraph}
          />
          <QuickAction
            icon={<FileText className="h-4 w-4" />}
            title="Create incident note"
            text="把当前调查沉淀成下一次 AI 可召回的 case。"
            onClick={onCreateIncident}
          />
        </div>

        <button
          type="button"
          onClick={onOpenTimeline}
          className="flex items-center gap-3 rounded-xl border border-slate-800 bg-[#0f1722]/75 px-4 py-3 text-left hover:border-cyan-500/40 hover:bg-cyan-500/[0.06]"
        >
          <Clock className="h-4 w-4 text-cyan-300" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-slate-100">Recent changes timeline</div>
            <div className="text-xs text-slate-500">跨仓库提交和近期变更，用来排查「昨天好、今天坏」。</div>
          </div>
          <ArrowRight className="h-4 w-4 text-slate-600" />
        </button>
      </div>
    </div>
  );
}

function FileOverviewPanel({
  selectedFile,
  fileSymbols,
  busy,
  onSelectSymbol,
}: {
  selectedFile: { branchId: string; filePath: string };
  fileSymbols: KnowledgeFileSymbol[];
  busy: boolean;
  onSelectSymbol: (id: string) => void;
}) {
  const fileName = selectedFile.filePath.split("/").pop() || selectedFile.filePath;
  const kindStats = Object.entries(
    fileSymbols.reduce<Record<string, number>>((acc, symbol) => {
      const key = symbol.kind || "symbol";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);
  const indexedCount = fileSymbols.filter((symbol) => symbol.status === "indexed").length;

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[linear-gradient(180deg,#070c13_0%,#0a0f17_100%)] p-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <section className="rounded-2xl border border-slate-800 bg-[#0d1420]/85 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.24)]">
          <div className="flex flex-wrap items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 text-cyan-200">
              <FileCode className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-cyan-300">File overview</div>
              <h2 className="truncate font-mono text-lg font-semibold tracking-normal text-slate-50">{fileName}</h2>
              <p className="mt-1 break-all font-mono text-xs leading-relaxed text-slate-500">{selectedFile.filePath}</p>
            </div>
            <div className="min-w-[180px] rounded-xl border border-slate-800 bg-slate-950/45 px-3 py-2">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                <GitBranch className="h-3 w-3" /> Branch
              </div>
              <div className="truncate font-mono text-xs text-slate-300">{selectedFile.branchId}</div>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-600">Symbols</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-slate-100">{busy ? "-" : fileSymbols.length}</div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-600">Indexed</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-emerald-200">{busy ? "-" : indexedCount}</div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-600">Kinds</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {busy ? (
                  <span className="font-mono text-xs text-slate-500">loading</span>
                ) : kindStats.length ? (
                  kindStats.slice(0, 5).map(([kind, count]) => (
                    <span key={kind} className="rounded-md border border-slate-800 bg-[#101826] px-2 py-0.5 font-mono text-[11px] text-slate-300">
                      {kind} {count}
                    </span>
                  ))
                ) : (
                  <span className="font-mono text-xs text-slate-500">none</span>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-[#0d1420]/85 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-100">Indexed symbols</div>
              <div className="text-xs text-slate-500">Open one symbol to build a Context Pack.</div>
            </div>
            {busy && <Loader2 className="h-4 w-4 animate-spin text-cyan-300" />}
          </div>

          {busy ? (
            <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/35 px-4 py-5 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin text-cyan-300" />
              Loading file symbols...
            </div>
          ) : fileSymbols.length ? (
            <div className="grid gap-2 md:grid-cols-2">
              {fileSymbols.map((symbol) => (
                <button
                  key={symbol.nodeId}
                  type="button"
                  onClick={() => onSelectSymbol(symbol.nodeId)}
                  className="group flex min-h-11 items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/35 px-3 py-2 text-left font-mono text-xs text-slate-300 hover:border-cyan-500/30 hover:bg-cyan-500/[0.05] hover:text-cyan-100"
                >
                  <Box className="h-3.5 w-3.5 shrink-0 text-cyan-300/70" />
                  <span className="min-w-0 flex-1 truncate">{symbol.title}</span>
                  <span className="shrink-0 rounded bg-slate-900 px-1.5 py-0.5 text-[9px] uppercase text-slate-600">{symbol.kind}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-700 group-hover:text-cyan-300" />
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-800 px-4 py-8 text-center text-sm text-slate-500">
              这个文件目前没有可打开的 indexed symbol。
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function GraphEmptyState({
  onOpenServiceGraph,
}: {
  onOpenServiceGraph: () => void;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md rounded-2xl border border-slate-800 bg-[#0d1420]/85 p-6 text-center">
        <Network className="mx-auto mb-4 h-8 w-8 text-cyan-300" />
        <div className="text-base font-semibold text-slate-100">图谱需要一个焦点。</div>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          搜索并打开一个符号，或先看服务图了解 repo 之间的连接。
        </p>
        <button
          type="button"
          onClick={onOpenServiceGraph}
          className="mt-4 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/15"
        >
          打开服务图
        </button>
      </div>
    </div>
  );
}

function GraphStatsOverlay({
  scope,
  data,
}: {
  scope: GraphScope | null;
  data: KnowledgeGraphView;
}) {
  const edgeTypes = Object.entries(
    data.edges.reduce<Record<string, number>>((acc, edge) => {
      acc[edge.edgeType] = (acc[edge.edgeType] ?? 0) + 1;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);

  return (
    <div className="pointer-events-none absolute right-3 top-3 max-w-[360px] rounded-xl border border-slate-800 bg-[#0d1420]/90 p-3 text-xs shadow-[0_18px_50px_rgba(0,0,0,0.28)] backdrop-blur">
      <div className="mb-2 flex items-center gap-2">
        <Network className="h-3.5 w-3.5 text-cyan-300" />
        <div className="min-w-0">
          <div className="truncate font-semibold text-slate-100">{scope?.title ?? "Graph view"}</div>
          <div className="truncate text-[11px] text-slate-500">{scope?.detail ?? "Current graph data"}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-slate-800 bg-slate-950/45 px-2 py-1.5">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-600">Nodes</div>
          <div className="font-mono text-base font-semibold text-slate-100">{data.nodes.length}</div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-950/45 px-2 py-1.5">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-600">Links</div>
          <div className="font-mono text-base font-semibold text-cyan-100">{data.edges.length}</div>
        </div>
      </div>
      {edgeTypes.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {edgeTypes.map(([type, count]) => (
            <span key={type} className="rounded-md border border-slate-800 bg-slate-950/45 px-2 py-0.5 font-mono text-[10px] text-slate-300">
              {type} {count}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function WikiPage({ onClose }: WikiPageProps) {
  const [status, setStatus] = useState<KnowledgeDbStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selectedFile, setSelectedFile] = useState<{ branchId: string; filePath: string } | null>(null);
  const [fileSymbols, setFileSymbols] = useState<KnowledgeFileSymbol[]>([]);
  const [fileSymbolsBusy, setFileSymbolsBusy] = useState(false);

  const [focusId, setFocusId] = useState<string | null>(null);
  const [tab, setTab] = useState<CenterTab>("context");

  const [pack, setPack] = useState<ContextPack | null>(null);
  const [packBusy, setPackBusy] = useState(false);
  const [flow, setFlow] = useState<FlowResult | null>(null);
  const [flowBusy, setFlowBusy] = useState(false);
  const [graphData, setGraphData] = useState<KnowledgeGraphView | null>(null);
  const [graphBusy, setGraphBusy] = useState(false);
  const [graphLayout, setGraphLayout] = useState<GraphLayout>("radial");
  const [graphScope, setGraphScope] = useState<GraphScope | null>(null);
  const [backlinks, setBacklinks] = useState<{ nodeId: string; title: string; nodeType: string }[]>([]);
  const [timelineData, setTimelineData] = useState<KnowledgeTimelineEntry[] | null>(null);
  const [timelineBusy, setTimelineBusy] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<KnowledgeSearchHit[] | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);

  const [editing, setEditing] = useState<{ slug: string; body: string } | null>(null);
  const [savingNote, setSavingNote] = useState(false);
  const [creating, setCreating] = useState<{ type: KnowledgeNoteType; title: string } | null>(null);
  const [creatingBusy, setCreatingBusy] = useState(false);

  const [trail, setTrail] = useState<NavEntry[]>([]);

  const refreshStatus = useCallback(() => { knowledgeDbStatus().then(setStatus).catch(() => setStatus(null)); }, []);
  useEffect(refreshStatus, [refreshStatus]);

  const err = (e: unknown) => setError(formatKnowledgeError(e));

  const loadPack = useCallback(async (id: string) => {
    setPackBusy(true);
    try {
      const [p, bl] = await Promise.all([knowledgeContext(id), knowledgeExplore("backlinks", id)]);
      setPack(p); setBacklinks(bl.nodes);
    } catch (e) { err(e); } finally { setPackBusy(false); }
  }, []);
  const loadGraph = useCallback(async (id: string) => {
    setGraphBusy(true);
    setGraphScope({ title: "Local graph", detail: "Focused symbol neighbourhood" });
    try { setGraphData(await knowledgeGraph(id, 1)); } catch (e) { err(e); } finally { setGraphBusy(false); }
  }, []);
  const loadFlow = useCallback(async (id: string) => {
    setFlowBusy(true);
    try { setFlow(await knowledgeFlow(id)); } catch (e) { err(e); } finally { setFlowBusy(false); }
  }, []);

  const runSearch = useCallback(async (query = searchQuery) => {
    const q = query.trim();
    setSearchQuery(query);
    setTab("context");
    setError(null);
    if (!q) {
      setSearchResults(null);
      return;
    }
    setSearchBusy(true);
    try {
      setSearchResults(await knowledgeSearch(q));
    } catch (e) { err(e); } finally { setSearchBusy(false); }
  }, [searchQuery]);

  const addSearchToken = useCallback((token: string) => {
    setSearchQuery((q) => (q.includes(token) ? q : `${q ? `${q} ` : ""}${token}`));
  }, []);

  const openTimeline = useCallback(async () => {
    setTab("timeline");
    if (timelineData) return;
    setTimelineBusy(true);
    try { setTimelineData((await knowledgeTimeline(60)).entries); } catch (e) { err(e); } finally { setTimelineBusy(false); }
  }, [timelineData]);

  const selectSymbol = useCallback((id: string, record = true) => {
    setError(null); setEditing(null); setFocusId(id);
    if (record) setTrail((t) => [...t, { kind: "symbol", id }]);
    void loadPack(id);
  }, [loadPack]);

  const selectFile = useCallback((branchId: string, filePath: string, record = true) => {
    setError(null); setEditing(null); setFocusId(null); setPack(null); setTab("context");
    setSearchResults(null); setSearchBusy(false); setSelectedFile({ branchId, filePath }); setFileSymbols([]);
    if (record) setTrail((t) => [...t, { kind: "file", branchId, filePath }]);
    setFileSymbolsBusy(true);
    knowledgeFileSymbols(branchId, filePath)
      .then(setFileSymbols)
      .catch((e) => { err(e); setFileSymbols([]); })
      .finally(() => setFileSymbolsBusy(false));
  }, []);

  const openRepoGraph = useCallback(async (repoId: string, branchId: string) => {
    setError(null); setFocusId(null); setTab("graph"); setGraphBusy(true);
    setGraphScope({ title: "Repo graph", detail: "Top connected symbols in this branch" });
    try { setGraphData(await knowledgeRepoGraph(repoId, branchId)); } catch (e) { err(e); } finally { setGraphBusy(false); }
  }, []);

  const openServiceGraph = useCallback(async () => {
    setError(null); setFocusId(null); setTab("graph"); setGraphBusy(true);
    setGraphScope({ title: "Service map", detail: "Only cross-service invokes and package dependencies" });
    try { setGraphData(await knowledgeServiceGraph()); } catch (e) { err(e); } finally { setGraphBusy(false); }
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
    if (tab === "flow" && flow?.root?.nodeId !== focusId) void loadFlow(focusId);
  }, [focusId, tab, graphData?.focus, flow, loadGraph, loadFlow]);

  const applyEntry = useCallback((e: NavEntry) => {
    if (e.kind === "symbol") selectSymbol(e.id, false);
    else selectFile(e.branchId, e.filePath, false);
  }, [selectSymbol, selectFile]);
  const back = useCallback(() => {
    setTrail((t) => { if (t.length <= 1) return []; const next = t.slice(0, -1); applyEntry(next[next.length - 1]); return next; });
  }, [applyEntry]);

  const noteBodyOf = (source: string): string => {
    if (!source.startsWith("---")) return source;
    const end = source.indexOf("\n---", 3);
    return end === -1 ? source : source.slice(end + 4).replace(/^\r?\n+/, "");
  };
  const editNote = useCallback(async (slug: string) => {
    setError(null);
    try { const r = await knowledgeNoteRead(slug); setEditing({ slug, body: noteBodyOf(r.source) }); } catch (e) { err(e); }
  }, []);
  const saveNote = useCallback(async () => {
    if (!editing) return; setSavingNote(true);
    try { await knowledgeNoteWrite(editing.slug, editing.body); refreshStatus(); setEditing(null); } catch (e) { err(e); } finally { setSavingNote(false); }
  }, [editing, refreshStatus]);
  const submitCreate = useCallback(async () => {
    if (!creating || !creating.title.trim()) return;
    setCreatingBusy(true);
    try {
      const r = await knowledgeNoteNewTyped(creating.title.trim(), creating.type);
      setCreating(null);
      refreshStatus();
      const rd = await knowledgeNoteRead(r.slug);
      setEditing({ slug: r.slug, body: noteBodyOf(rd.source) });
    } catch (e) { err(e); } finally { setCreatingBusy(false); }
  }, [creating, refreshStatus]);

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
  const activeScope = useMemo(() => {
    if (tab === "graph" && graphScope) return graphScope.title;
    if (f?.filePath) return f.filePath;
    if (selectedFile) return selectedFile.filePath;
    return "Search across indexed repos";
  }, [f?.filePath, graphScope, selectedFile, tab]);

  return (
    <div className="flex h-full flex-col bg-[#070b11] text-slate-100">
      <header className="shrink-0 border-b border-slate-800 bg-[#0b111a] px-6 py-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Database className="h-5 w-5 shrink-0 text-cyan-300" />
          <h1 className="shrink-0 text-lg font-semibold tracking-normal">知识 Wiki</h1>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs text-slate-400">
            <MetricPill label="repos" value={status?.repos ?? "-"} />
            <MetricPill label="symbols" value={status?.symbols ?? "-"} />
            <MetricPill label="notes" value={status?.notes ?? "-"} />
          </div>
          <button type="button" onClick={back} disabled={trail.length <= 1} title="返回上一步"
            className="flex h-8 items-center gap-1 rounded-md border border-slate-800 px-2 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-30">
            <ArrowLeft className="h-3.5 w-3.5" /> 返回
          </button>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-100" aria-label="关闭"><X className="h-4 w-4" /></button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="flex min-w-[420px] flex-1 items-center rounded-xl border border-slate-800 bg-slate-950/55 px-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] focus-within:border-cyan-500/50">
            <Search className="h-4 w-4 shrink-0 text-cyan-300" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
              placeholder="Search symbol, API, config, case, trace..."
              className="h-10 min-w-0 flex-1 bg-transparent px-3 font-mono text-sm text-slate-100 outline-none placeholder:text-slate-600"
            />
            {searchBusy && <Loader2 className="mr-2 h-4 w-4 shrink-0 animate-spin text-cyan-300" />}
            <button
              type="button"
              onClick={() => void runSearch()}
              className="rounded-lg bg-cyan-400 px-3 py-1.5 text-xs font-bold text-[#04121a] hover:bg-cyan-300"
            >
              Search
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {["repo:", "type:", "tag:", "entity:"].map((token) => (
              <button
                key={token}
                type="button"
                onClick={() => addSearchToken(token)}
                className="rounded-md border border-slate-800 bg-slate-950/40 px-2 py-1 font-mono text-[11px] text-slate-500 hover:border-cyan-500/30 hover:text-cyan-200"
              >
                {token}
              </button>
            ))}
          </div>
        </div>
      </header>

      {error && <div className="mx-6 mt-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-200">{error}</div>}

      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: "320px minmax(0,1fr) 360px" }}>
        <aside className="flex min-h-0 min-w-0 flex-col border-r border-slate-800 bg-[#0c121b]">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-slate-800 px-3 text-xs font-bold text-slate-200">
            <FileCode className="h-3.5 w-3.5 text-cyan-300" />Explorer
            <button type="button" onClick={() => void openServiceGraph()} title="服务关系图"
              className="ml-auto flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-300 hover:bg-white/5">
              <Network className="h-3 w-3 text-cyan-300" />服务图
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <WikiBrowseTree onSelectFile={(b, fp) => selectFile(b, fp)} onOpenRepoGraph={(r, b) => openRepoGraph(r, b)} selected={selectedFile} />
          </div>
          {selectedFile && (
            <div className="max-h-[42%] shrink-0 overflow-auto border-t border-slate-800 bg-[#101826] p-2">
              <div className="mb-2 flex items-center gap-2 px-1 text-[10px] font-bold uppercase text-slate-500">
                <span className="min-w-0 flex-1 truncate font-mono normal-case text-slate-300">{selectedFile.filePath.split("/").pop()}</span>
                <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px]">{fileSymbolsBusy ? "..." : fileSymbols.length}</span>
              </div>
              {fileSymbolsBusy ? (
                <div className="flex items-center gap-2 rounded-md px-2 py-2 text-xs text-slate-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-300" /> Loading symbols
                </div>
              ) : (
                fileSymbols.map((s) => (
                  <button key={s.nodeId} type="button" onClick={() => selectSymbol(s.nodeId)}
                    className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs hover:bg-white/5", focusId === s.nodeId ? "bg-cyan-500/12 text-cyan-100" : "text-slate-300")}>
                    <Box className="h-3 w-3 shrink-0 text-cyan-300/70" /><span className="min-w-0 flex-1 truncate">{s.title}</span>
                    <span className="text-[9px] uppercase text-slate-600">{s.kind}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col bg-[#080d14]">
          <div className="flex h-12 shrink-0 items-center gap-1 border-b border-slate-800 bg-[#0d1420] px-3">
            <div className="mr-2 flex min-w-0 max-w-[34%] items-center gap-2">
              {f ? <Dot t={f.nodeType} /> : <GitBranch className="h-3.5 w-3.5 shrink-0 text-slate-500" />}
              <span className="truncate font-mono text-xs font-semibold text-slate-400">{f?.title ?? activeScope}</span>
              {f?.kind && <span className="hidden shrink-0 rounded-md bg-slate-800 px-2 py-0.5 text-[10px] uppercase text-slate-300 xl:inline">{f.kind}</span>}
            </div>
            <TabBtn on={tab === "context"} onClick={() => setTab("context")} icon={<Sparkles className="h-3.5 w-3.5" />}>Context</TabBtn>
            <TabBtn on={tab === "graph"} onClick={() => setTab("graph")} icon={<Network className="h-3.5 w-3.5" />}>Graph</TabBtn>
            <TabBtn on={tab === "flow"} onClick={() => setTab("flow")} icon={<Workflow className="h-3.5 w-3.5" />}>Flow</TabBtn>
            <TabBtn on={tab === "timeline"} onClick={() => void openTimeline()} icon={<Clock className="h-3.5 w-3.5" />}>Timeline</TabBtn>
            <div className="ml-auto flex items-center gap-2">
              {tab === "graph" && graphData && (
                <div className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950/40 p-0.5 text-xs">
                  <button type="button" onClick={() => setGraphLayout("radial")} className={cn("rounded px-2 py-0.5", graphLayout === "radial" ? "bg-cyan-500/15 text-cyan-200" : "text-slate-400 hover:bg-white/5")}>整洁</button>
                  <button type="button" onClick={() => setGraphLayout("force")} className={cn("rounded px-2 py-0.5", graphLayout === "force" ? "bg-cyan-500/15 text-cyan-200" : "text-slate-400 hover:bg-white/5")}>力导向</button>
                  <button type="button" onClick={() => setGraphLayout("3d")} className={cn("rounded px-2 py-0.5", graphLayout === "3d" ? "bg-cyan-500/15 text-cyan-200" : "text-slate-400 hover:bg-white/5")}>3D</button>
                </div>
              )}
              {tab === "context" && f && (
                <button type="button" onClick={copyPack} className="flex h-8 items-center gap-1.5 rounded-lg bg-cyan-400 px-2.5 text-xs font-bold text-[#04121a] hover:bg-cyan-300"><Sparkles className="h-3.5 w-3.5" />Copy for AI</button>
              )}
            </div>
          </div>

          {tab === "context" ? (
            f ? <WikiContextPane packBusy={packBusy} pack={pack} onSelectSymbol={selectSymbol} /> : selectedFile ? (
              <FileOverviewPanel
                selectedFile={selectedFile}
                fileSymbols={fileSymbols}
                busy={fileSymbolsBusy}
                onSelectSymbol={selectSymbol}
              />
            ) : (
              <KnowledgeHomePanel
                status={status}
                searchQuery={searchQuery}
                searchResults={searchResults}
                searchBusy={searchBusy}
                selectedFile={selectedFile}
                fileSymbols={fileSymbols}
                onRunSearch={(q) => void runSearch(q)}
                onSelectSymbol={selectSymbol}
                onOpenServiceGraph={() => void openServiceGraph()}
                onOpenTimeline={() => void openTimeline()}
                onCreateIncident={() => setCreating({ type: "incident", title: searchQuery.trim() || "New incident" })}
              />
            )
          ) : tab === "graph" ? (
            <div className="relative flex min-h-0 flex-1">
              {graphBusy ? <div className="flex flex-1 items-center justify-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> 加载图谱…</div>
                : graphData && graphData.nodes.length > 0
                  ? (
                    <>
                      {graphLayout === "3d"
                        ? <WikiGraph3D data={graphData} onNodeClick={onGraphNodeClick} />
                        : <WikiGraph data={graphData} layout={graphLayout} onNodeClick={onGraphNodeClick} />}
                      <GraphStatsOverlay scope={graphScope} data={graphData} />
                    </>
                  )
                  : <GraphEmptyState onOpenServiceGraph={() => void openServiceGraph()} />}
            </div>
          ) : tab === "timeline" ? <WikiTimelinePane timelineBusy={timelineBusy} timelineData={timelineData} />
          : <WikiFlowPane flowBusy={flowBusy} flow={flow} onSelectSymbol={selectSymbol} />}
        </section>

        <aside className="flex min-h-0 min-w-0 flex-col overflow-auto border-l border-slate-800 bg-[#0c121b]">
          <WikiWhyPanel
            f={f ?? null}
            pack={pack}
            backlinks={backlinks}
            editing={editing}
            creating={creating}
            creatingBusy={creatingBusy}
            savingNote={savingNote}
            onEditNote={editNote}
            onSaveNote={saveNote}
            onCancelEdit={() => setEditing(null)}
            onSubmitCreate={submitCreate}
            onSetCreating={setCreating}
            onSetEditing={setEditing}
          />
        </aside>
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-slate-800 bg-[#101826] px-3 text-[11px] text-slate-400">
        <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Connected</span>
        <span className="text-slate-600">SQLite</span>
        <span className="ml-auto text-slate-600">Workspace <b className="text-slate-300">Penguin</b></span>
      </footer>
    </div>
  );
}

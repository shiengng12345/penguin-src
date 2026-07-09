import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Database, FileText, Box, Loader2, X, Network, FileCode, Save, Pencil, ArrowLeft, Sparkles, Workflow, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { WikiBrowseTree } from "@/components/wiki/WikiBrowseTree";
import { WikiGraph, type GraphLayout } from "@/components/wiki/WikiGraph";
import { WikiGraph3D } from "@/components/wiki/WikiGraph3D";
import { WikiNoteEditor } from "@/components/wiki/WikiNoteEditor";
import {
  knowledgeDbStatus,
  knowledgeExplore,
  knowledgeFileSymbols,
  knowledgeGraph,
  knowledgeRepoGraph,
  knowledgeContext,
  knowledgeFlow,
  knowledgeNoteWrite,
  knowledgeNoteRead,
  type KnowledgeDbStatus,
  type KnowledgeFileSymbol,
  type KnowledgeGraphView,
  type ContextPack,
  type FlowResult,
} from "@/lib/knowledge-client";

interface WikiPageProps { onClose: () => void }

type CenterTab = "context" | "graph" | "flow";
type NavEntry = { kind: "symbol"; id: string } | { kind: "file"; branchId: string; filePath: string };

const KIND_COLOR: Record<string, string> = {
  note: "#34d399", file: "#f59e0b", endpoint: "#fb7185", entity: "#e879f9", symbol: "#7c8db5",
};
const VIA_COLOR: Record<string, string> = {
  calls: "#60a5fa", references: "#a78bfa", imports: "#94a3b8", defines: "#f59e0b",
  tests: "#34d399", handles: "#fb7185", invokes: "#38bdf8", throws: "#f87171", uses: "#e879f9", root: "#22d3ee",
};

// NestJS built-in exceptions → the HTTP status they produce, so "会抛出" reads as
// the possible error responses of an endpoint.
const EXC_STATUS: Record<string, string> = {
  BadRequestException: "400", UnauthorizedException: "401", ForbiddenException: "403",
  NotFoundException: "404", MethodNotAllowedException: "405", NotAcceptableException: "406",
  RequestTimeoutException: "408", ConflictException: "409", GoneException: "410",
  PayloadTooLargeException: "413", UnsupportedMediaTypeException: "415", UnprocessableEntityException: "422",
  InternalServerErrorException: "500", NotImplementedException: "501", BadGatewayException: "502",
  ServiceUnavailableException: "503", GatewayTimeoutException: "504", RpcException: "gRPC",
};
const withStatus = (exc: string) => (EXC_STATUS[exc] ? `${EXC_STATUS[exc]} · ${exc}` : exc);

// Penguin Knowledge Wiki — a 4-pane code-intelligence surface:
//   left Explorer (repo→branch→file→symbol) · centre Context/Graph/Flow for the
//   selected symbol · right "why" panel (linked notes + relations + freshness).
export function WikiPage({ onClose }: WikiPageProps) {
  const [status, setStatus] = useState<KnowledgeDbStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selectedFile, setSelectedFile] = useState<{ branchId: string; filePath: string } | null>(null);
  const [fileSymbols, setFileSymbols] = useState<KnowledgeFileSymbol[]>([]);

  const [focusId, setFocusId] = useState<string | null>(null);
  const [tab, setTab] = useState<CenterTab>("context");

  const [pack, setPack] = useState<ContextPack | null>(null);
  const [packBusy, setPackBusy] = useState(false);
  const [flow, setFlow] = useState<FlowResult | null>(null);
  const [flowBusy, setFlowBusy] = useState(false);
  const [graphData, setGraphData] = useState<KnowledgeGraphView | null>(null);
  const [graphBusy, setGraphBusy] = useState(false);
  const [graphLayout, setGraphLayout] = useState<GraphLayout>("radial");
  const [backlinks, setBacklinks] = useState<{ nodeId: string; title: string; nodeType: string }[]>([]);

  const [editing, setEditing] = useState<{ slug: string; body: string } | null>(null);
  const [savingNote, setSavingNote] = useState(false);

  const [trail, setTrail] = useState<NavEntry[]>([]);

  const refreshStatus = useCallback(() => { knowledgeDbStatus().then(setStatus).catch(() => setStatus(null)); }, []);
  useEffect(refreshStatus, [refreshStatus]);

  const err = (e: unknown) => setError(String((e as Error).message ?? e));

  const loadPack = useCallback(async (id: string) => {
    setPackBusy(true);
    try {
      const [p, bl] = await Promise.all([knowledgeContext(id), knowledgeExplore("backlinks", id)]);
      setPack(p); setBacklinks(bl.nodes);
    } catch (e) { err(e); } finally { setPackBusy(false); }
  }, []);
  const loadGraph = useCallback(async (id: string) => {
    setGraphBusy(true);
    try { setGraphData(await knowledgeGraph(id, 1)); } catch (e) { err(e); } finally { setGraphBusy(false); }
  }, []);
  const loadFlow = useCallback(async (id: string) => {
    setFlowBusy(true);
    try { setFlow(await knowledgeFlow(id)); } catch (e) { err(e); } finally { setFlowBusy(false); }
  }, []);

  // Selecting a symbol drives all three panes (context loads eagerly for the
  // right panel; graph/flow load lazily when their tab is active).
  const selectSymbol = useCallback((id: string, record = true) => {
    setError(null); setEditing(null); setFocusId(id);
    if (record) setTrail((t) => [...t, { kind: "symbol", id }]);
    void loadPack(id);
  }, [loadPack]);

  const selectFile = useCallback((branchId: string, filePath: string, record = true) => {
    setError(null); setEditing(null); setFocusId(null); setSelectedFile({ branchId, filePath });
    if (record) setTrail((t) => [...t, { kind: "file", branchId, filePath }]);
    knowledgeFileSymbols(branchId, filePath).then(setFileSymbols).catch((e) => { err(e); setFileSymbols([]); });
  }, []);

  const openRepoGraph = useCallback(async (repoId: string, branchId: string) => {
    setError(null); setFocusId(null); setTab("graph"); setGraphBusy(true);
    try { setGraphData(await knowledgeRepoGraph(repoId, branchId)); } catch (e) { err(e); } finally { setGraphBusy(false); }
  }, []);

  // lazily fetch the active tab's data for the focused symbol
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

  const Dot = ({ t }: { t: string }) => <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: KIND_COLOR[t] ?? KIND_COLOR.symbol }} />;

  const briefCard = (label: string, items: { nodeId: string; title: string; nodeType: string }[]) =>
    items.length === 0 ? null : (
      <div className="rounded-xl border border-slate-800 bg-slate-900/40">
        <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">
          {label}<span className="ml-auto rounded-full bg-slate-800 px-1.5 font-mono text-[10px] text-slate-500">{items.length}</span>
        </div>
        <div className="p-2">
          {items.slice(0, 14).map((n) => (
            <button key={n.nodeId} type="button" onClick={() => selectSymbol(n.nodeId)}
              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left font-mono text-xs text-slate-200 hover:bg-white/5">
              <Dot t={n.nodeType} /><span className="min-w-0 flex-1 truncate">{n.title}</span>
            </button>
          ))}
        </div>
      </div>
    );
  const chipList = (label: string, items: string[], color: string) =>
    items.length === 0 ? null : (
      <div className="rounded-xl border border-slate-800 bg-slate-900/40">
        <div className="border-b border-slate-800 px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
        <div className="flex flex-wrap gap-1.5 p-2.5">
          {items.map((s) => <span key={s} className="rounded-md border border-slate-700 bg-slate-800/50 px-2 py-1 font-mono text-[11px]" style={{ color }}>{s}</span>)}
        </div>
      </div>
    );

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
  const focusFresh = f?.branches[0];

  // ── centre panes ──────────────────────────────────────────────
  const contextPane = (
    packBusy ? <Center><Loader2 className="h-4 w-4 animate-spin" /> 生成 Context Pack…</Center>
    : !f ? <Center>选中左侧一个符号</Center>
    : (
      <div className="flex-1 space-y-4 overflow-auto p-5">
        {f.filePath && <div className="font-mono text-xs text-slate-500">{f.filePath}</div>}
        {pack!.signals.length > 0 && (
          <div className="space-y-1.5 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3">
            {pack!.signals.map((s, i) => <div key={i} className="flex items-start gap-2 text-xs text-slate-300"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />{s}</div>)}
          </div>
        )}
        {f.source && (
          <div className="overflow-hidden rounded-xl border border-slate-800">
            <div className="border-b border-slate-800 bg-slate-900/60 px-3 py-1.5 text-[10px] font-bold uppercase text-slate-400">源码 · {(f.filePath?.split(".").pop() ?? "ts")}</div>
            <pre className="max-h-80 overflow-auto bg-slate-950/70 p-3 text-xs leading-relaxed text-slate-200"><code className="font-mono">{f.source}</code></pre>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          {briefCard("被调用 · 被引用", [...pack!.callers, ...pack!.referencedBy])}
          {briefCard("调用 · 用到类型", [...pack!.calls, ...pack!.usesTypes])}
          {briefCard("测试覆盖", pack!.tests)}
          {briefCard("被这些文件 import", pack!.importers)}
          {pack!.routes.length > 0 && chipList("HTTP / gRPC 入口", pack!.routes.map((r) => r.route), "#22d3ee")}
          {pack!.errors.length > 0 && chipList("可能错误响应", pack!.errors.map(withStatus), "#f87171")}
          {pack!.envs.length > 0 && chipList("用到 env", pack!.envs, "#e879f9")}
        </div>
      </div>
    )
  );

  const graphPane = (
    <div className="relative flex-1">
      {graphBusy ? <Center><Loader2 className="h-4 w-4 animate-spin" /> 加载图谱…</Center>
        : graphData && graphData.nodes.length > 0
          ? (graphLayout === "3d"
              ? <WikiGraph3D data={graphData} onNodeClick={(id) => selectSymbol(id)} />
              : <WikiGraph data={graphData} layout={graphLayout} onNodeClick={(id) => selectSymbol(id)} />)
          : <Center>选中一个符号看它的关系图</Center>}
    </div>
  );

  const flowPane = (
    flowBusy ? <Center><Loader2 className="h-4 w-4 animate-spin" /> 追踪执行链…</Center>
    : !flow?.root ? <Center>选中一个符号 / endpoint 看执行链</Center>
    : (
      <div className="flex-1 overflow-auto p-6">
        <div className="mb-1 font-mono text-base font-bold">{flow.root.title}</div>
        <div className="mb-5 text-xs text-slate-500">执行链 — 由静态边推导(handles → calls → reads/writes/throws/uses)</div>
        <div className="space-y-1">
          {flow.steps.map((s, i) => (
            <div key={i} className="flex items-center" style={{ paddingLeft: s.depth * 24 }}>
              {s.via !== "root" && <span className="px-2 font-mono text-[10px] text-slate-500">↳ {s.via} →</span>}
              <button type="button" onClick={() => selectSymbol(s.nodeId)}
                className={cn("flex items-center gap-2 rounded-lg border px-3 py-2 font-mono text-xs",
                  s.depth === 0 ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-100" : "border-slate-700 bg-slate-900/50 text-slate-200 hover:bg-white/5")}>
                <span className="h-2 w-2 rounded-full" style={{ background: VIA_COLOR[s.via] ?? KIND_COLOR[s.nodeType] ?? KIND_COLOR.symbol }} />
                {s.title}<span className="text-[9px] uppercase text-slate-500">{s.nodeType}</span>
              </button>
            </div>
          ))}
        </div>
      </div>
    )
  );

  return (
    <div className="flex h-full flex-col bg-[#0b111a] text-slate-100">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-800 px-6 py-4">
        <Database className="h-5 w-5 shrink-0 text-cyan-300" />
        <h1 className="shrink-0 text-lg font-semibold">知识 Wiki</h1>
        <span className="ml-2 min-w-0 flex-1 truncate text-xs text-slate-400">
          {status?.exists ? `${status.repos} repos · ${status.symbols} symbols · ${status.notes} notes` : "未初始化 — 运行 penguin init"}
        </span>
        <button type="button" onClick={back} disabled={trail.length <= 1} title="返回上一步"
          className="flex h-8 items-center gap-1 rounded-md border border-slate-800 px-2 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-30">
          <ArrowLeft className="h-3.5 w-3.5" /> 返回
        </button>
        <button type="button" onClick={onClose} className="rounded p-1.5 hover:bg-white/5" aria-label="关闭"><X className="h-4 w-4" /></button>
      </header>

      {error && <div className="mx-6 mt-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-200">{error}</div>}

      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: "280px 1fr 320px" }}>
        {/* LEFT — Explorer */}
        <aside className="flex min-h-0 min-w-0 flex-col border-r border-slate-800 bg-[#0e131c]">
          <div className="flex h-9 items-center gap-2 border-b border-slate-800 px-3 text-xs font-bold text-slate-200"><FileCode className="h-3.5 w-3.5 text-cyan-300" />Explorer</div>
          <div className="min-h-0 flex-1 overflow-auto p-1.5">
            <WikiBrowseTree onSelectFile={(b, fp) => selectFile(b, fp)} onOpenRepoGraph={(r, b) => openRepoGraph(r, b)} selected={selectedFile} />
          </div>
          {selectedFile && (
            <div className="max-h-[42%] shrink-0 overflow-auto border-t border-slate-800 bg-[#111826] p-2">
              <div className="mb-1 flex items-center gap-2 px-1 text-[10px] font-bold uppercase text-slate-400">
                <span className="min-w-0 flex-1 truncate font-mono normal-case text-slate-300">{selectedFile.filePath.split("/").pop()}</span>{fileSymbols.length}
              </div>
              {fileSymbols.map((s) => (
                <button key={s.nodeId} type="button" onClick={() => selectSymbol(s.nodeId)}
                  className={cn("flex w-full items-center gap-2 rounded px-1.5 py-1 text-left font-mono text-xs hover:bg-white/5", focusId === s.nodeId ? "bg-cyan-500/12 text-cyan-100" : "text-slate-300")}>
                  <Box className="h-3 w-3 shrink-0 text-cyan-300/70" /><span className="min-w-0 flex-1 truncate">{s.title}</span>
                  <span className="text-[9px] text-slate-500">{s.kind}</span>
                </button>
              ))}
            </div>
          )}
        </aside>

        {/* CENTER — Context / Graph / Flow */}
        <section className="flex min-h-0 min-w-0 flex-col bg-gradient-to-b from-[#090d13] to-[#0b0f16]">
          <div className="flex h-11 shrink-0 items-center gap-1 border-b border-slate-800 bg-[#0e131c] px-3">
            {f && (
              <>
                <Dot t={f.nodeType} />
                <span className="mr-2 truncate font-mono text-sm font-bold">{f.title}</span>
                {f.kind && <span className="mr-3 rounded-full bg-slate-800 px-2 py-0.5 text-[10px] uppercase text-slate-300">{f.kind}</span>}
              </>
            )}
            <TabBtn on={tab === "context"} onClick={() => setTab("context")} icon={<Sparkles className="h-3.5 w-3.5" />}>Context</TabBtn>
            <TabBtn on={tab === "graph"} onClick={() => setTab("graph")} icon={<Network className="h-3.5 w-3.5" />}>Graph</TabBtn>
            <TabBtn on={tab === "flow"} onClick={() => setTab("flow")} icon={<Workflow className="h-3.5 w-3.5" />}>Flow</TabBtn>
            <div className="ml-auto flex items-center gap-2">
              {tab === "graph" && graphData && (
                <div className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950/40 p-0.5 text-xs">
                  <button type="button" onClick={() => setGraphLayout("radial")} className={cn("rounded px-2 py-0.5", graphLayout === "radial" ? "bg-cyan-500/15 text-cyan-200" : "text-slate-400 hover:bg-white/5")}>整洁</button>
                  <button type="button" onClick={() => setGraphLayout("force")} className={cn("rounded px-2 py-0.5", graphLayout === "force" ? "bg-cyan-500/15 text-cyan-200" : "text-slate-400 hover:bg-white/5")}>力导向</button>
                  <button type="button" onClick={() => setGraphLayout("3d")} className={cn("rounded px-2 py-0.5", graphLayout === "3d" ? "bg-cyan-500/15 text-cyan-200" : "text-slate-400 hover:bg-white/5")}>3D</button>
                </div>
              )}
              {tab === "context" && f && (
                <button type="button" onClick={copyPack} className="flex h-7 items-center gap-1.5 rounded-lg bg-gradient-to-br from-cyan-400 to-teal-400 px-2.5 text-xs font-bold text-[#04121a]"><Sparkles className="h-3.5 w-3.5" />Copy for AI</button>
              )}
            </div>
          </div>
          {tab === "context" ? contextPane : tab === "graph" ? graphPane : flowPane}
        </section>

        {/* RIGHT — why / relations */}
        <aside className="flex min-h-0 min-w-0 flex-col overflow-auto border-l border-slate-800 bg-[#0e131c]">
          {editing ? (
            <div className="flex h-full flex-col gap-2 p-3">
              <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
                <Pencil className="h-4 w-4 text-emerald-300" /><span className="min-w-0 flex-1 truncate font-mono text-sm">{editing.slug}.md</span>
                <button type="button" onClick={() => setEditing(null)} className="rounded border border-slate-700 px-2 py-1 text-xs hover:bg-white/5">取消</button>
                <button type="button" onClick={() => void saveNote()} disabled={savingNote} className="flex items-center gap-1 rounded bg-cyan-500/20 px-2 py-1 text-xs text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-50"><Save className="h-3.5 w-3.5" />{savingNote ? "保存中" : "保存"}</button>
              </div>
              <div className="min-h-0 flex-1"><WikiNoteEditor body={editing.body} onChange={(v) => setEditing((e) => (e ? { ...e, body: v } : e))} /></div>
            </div>
          ) : !f ? (
            <div className="p-5 text-sm text-slate-500">选中符号后,这里显示它的关联笔记、关系与新鲜度。</div>
          ) : (
            <>
              <div className="border-b border-slate-800 p-4">
                <div className="mb-1 text-[11px] text-slate-500">Knowledge / <b className="text-cyan-300">{f.title}</b></div>
                {focusFresh && (
                  <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-slate-700 px-2.5 py-1 font-mono text-[11px] text-slate-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{focusFresh.branch} · {focusFresh.status}
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  <RelChip n={pack!.callers.length + backlinks.length} label="被引用" />
                  <RelChip n={pack!.calls.length} label="调用" />
                  <RelChip n={pack!.tests.length} label="测试" />
                  <RelChip n={pack!.routes.length} label="入口" />
                </div>
              </div>
              <div className="p-4">
                <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">关联笔记 · why</div>
                {pack!.notes.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-700 p-4 text-center text-xs text-slate-500">
                    还没有关联笔记。<br /><span className="text-cyan-300">用 <code className="font-mono">penguin note new</code> 记录「为什么」</span>,链接代码自动生成。
                  </div>
                ) : pack!.notes.map((n) => (
                  <button key={n.nodeId} type="button" onClick={() => editNote(n.title)} className="mb-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-white/5">
                    <FileText className="h-3.5 w-3.5 text-emerald-300" /><span className="truncate">{n.title}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </aside>
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-slate-800 bg-[#111826] px-3 text-[11px] text-slate-400">
        <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Connected</span>
        <span className="text-slate-600">SQLite</span>
        <span className="ml-auto text-slate-600">Workspace <b className="text-slate-300">Penguin</b></span>
      </footer>
    </div>
  );
}

function Center({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center gap-2 text-sm text-slate-500">{children}</div>;
}
function TabBtn({ on, onClick, icon, children }: { on: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={cn("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold", on ? "bg-cyan-500/12 text-cyan-200 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.3)]" : "text-slate-400 hover:bg-white/5")}>
      {icon}{children}
    </button>
  );
}
function RelChip({ n, label }: { n: number; label: string }) {
  return <span className="rounded-md border border-slate-700 bg-slate-800/50 px-2 py-1 text-slate-300"><b className="font-mono text-slate-100">{n}</b> {label}</span>;
}

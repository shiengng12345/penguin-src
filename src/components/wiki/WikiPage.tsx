import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Database, FileText, Box, Loader2, X, FolderTree, Network, FileCode, Save, Pencil, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { WikiBrowseTree } from "@/components/wiki/WikiBrowseTree";
import { WikiGraph } from "@/components/wiki/WikiGraph";
import { WikiNoteEditor } from "@/components/wiki/WikiNoteEditor";
import {
  knowledgeDbStatus,
  knowledgeNode,
  knowledgeExplore,
  knowledgeFileSymbols,
  knowledgeGraph,
  knowledgeRepoGraph,
  knowledgeNoteWrite,
  knowledgeNoteRead,
  type KnowledgeDbStatus,
  type KnowledgeNodeDetail,
  type KnowledgeGraphResult,
  type KnowledgeFileSymbol,
  type KnowledgeGraphView,
} from "@/lib/knowledge-client";

interface WikiPageProps {
  onClose: () => void;
}

type Mode = "browse" | "graph";

// One step in the Wiki navigation history (for the ← 返回 button).
type NavEntry =
  | { kind: "node"; id: string }
  | { kind: "graph"; id: string }
  | { kind: "file"; branchId: string; filePath: string }
  | { kind: "repograph"; repoId: string; branchId: string };

// Penguin Knowledge Wiki (§7). Two views over the shared query layer:
//  - Browse: repo → branch → file → symbol navigation tree + symbol detail (default)
//  - Graph: Obsidian-style force-directed local/repo graph
// No query logic here — all data via the Rust bridge → bundled CLI.
export function WikiPage({ onClose }: WikiPageProps) {
  const [mode, setMode] = useState<Mode>("browse");
  const [status, setStatus] = useState<KnowledgeDbStatus | null>(null);
  const [detail, setDetail] = useState<KnowledgeNodeDetail | null>(null);
  const [backlinks, setBacklinks] = useState<KnowledgeGraphResult | null>(null);
  const [calls, setCalls] = useState<KnowledgeGraphResult | null>(null);
  const [siblings, setSiblings] = useState<KnowledgeFileSymbol[]>([]);
  const [selectedFile, setSelectedFile] = useState<{ branchId: string; filePath: string } | null>(null);
  const [fileSymbols, setFileSymbols] = useState<KnowledgeFileSymbol[]>([]);
  const [graphData, setGraphData] = useState<KnowledgeGraphView | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ slug: string; body: string } | null>(null);
  const [savingNote, setSavingNote] = useState(false);

  const refreshStatus = useCallback(() => {
    knowledgeDbStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(refreshStatus, [refreshStatus]);

  const openNode = useCallback(async (nodeId: string) => {
    setError(null);
    try {
      const [d, bl, cl] = await Promise.all([
        knowledgeNode(nodeId),
        knowledgeExplore("backlinks", nodeId),
        knowledgeExplore("calls", nodeId),
      ]);
      setDetail(d);
      setBacklinks(bl);
      setCalls(cl);
      // Same-file symbols (containment) — a symbol always has file-mates even
      // when it has no call edges, so the panel is never bare.
      const v = d.versions.find((x) => x.status === "fresh") ?? d.versions[0];
      if (v) {
        try {
          const syms = await knowledgeFileSymbols(v.branchId, v.filePath);
          setSiblings(syms.filter((s) => s.nodeId !== d.node.id));
        } catch {
          setSiblings([]);
        }
      } else {
        setSiblings([]);
      }
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  const selectFile = useCallback(async (branchId: string, filePath: string) => {
    setError(null);
    setDetail(null);
    setBacklinks(null);
    setCalls(null);
    setSiblings([]);
    setSelectedFile({ branchId, filePath });
    try {
      setFileSymbols(await knowledgeFileSymbols(branchId, filePath));
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setFileSymbols([]);
    }
  }, []);

  const openRepoGraph = useCallback(async (repoId: string, branchId: string) => {
    setError(null);
    setMode("graph");
    setGraphLoading(true);
    try {
      setGraphData(await knowledgeRepoGraph(repoId, branchId));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setGraphLoading(false);
    }
  }, []);

  const focusGraph = useCallback(async (nodeId: string) => {
    setError(null);
    setMode("graph");
    setGraphLoading(true);
    try {
      setGraphData(await knowledgeGraph(nodeId, 1));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setGraphLoading(false);
    }
  }, []);

  // —— Navigation history: every drill-in (symbol detail / graph recenter / file /
  // relation jump) is recorded so ← 返回 restores the previous view.
  const [trail, setTrail] = useState<NavEntry[]>([]);
  const applyEntry = useCallback((e: NavEntry) => {
    if (e.kind === "node") { setMode((m) => (m === "graph" ? "browse" : m)); void openNode(e.id); }
    else if (e.kind === "graph") void focusGraph(e.id);
    else if (e.kind === "file") void selectFile(e.branchId, e.filePath);
    else if (e.kind === "repograph") void openRepoGraph(e.repoId, e.branchId);
  }, [openNode, focusGraph, selectFile, openRepoGraph]);
  const go = useCallback((e: NavEntry) => { setTrail((t) => [...t, e]); applyEntry(e); }, [applyEntry]);
  const back = useCallback(() => {
    setTrail((t) => {
      if (t.length <= 1) return [];
      const next = t.slice(0, -1);
      applyEntry(next[next.length - 1]);
      return next;
    });
  }, [applyEntry]);

  // Strip the leading `--- … ---` frontmatter so the editor shows just the body.
  const noteBodyOf = (source: string): string => {
    if (!source.startsWith("---")) return source;
    const end = source.indexOf("\n---", 3);
    return end === -1 ? source : source.slice(end + 4).replace(/^\r?\n+/, "");
  };

  const editNote = useCallback(async (slug: string) => {
    setError(null);
    try {
      const r = await knowledgeNoteRead(slug);
      setEditing({ slug, body: noteBodyOf(r.source) });
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  const saveNote = useCallback(async () => {
    if (!editing) return;
    setSavingNote(true);
    setError(null);
    try {
      await knowledgeNoteWrite(editing.slug, editing.body);
      refreshStatus();
      setEditing(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setSavingNote(false);
    }
  }, [editing, refreshStatus]);

  const TypeIcon = ({ t }: { t: string }) =>
    t === "note" ? <FileText className="h-4 w-4 text-emerald-300" /> : <Box className="h-4 w-4 text-cyan-300" />;

  const ModeButton = ({ m, icon, label }: { m: Mode; icon: ReactNode; label: string }) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs",
        mode === m ? "bg-cyan-500/15 text-cyan-200" : "text-slate-400 hover:bg-white/5",
      )}
    >
      {icon}
      {label}
    </button>
  );

  const focusNode = graphData?.nodes.find((n) => n.nodeId === graphData.focus);

  // A clickable relation row (reused across calls / backlinks / same-file).
  const RelRow = ({ id, title, type, meta }: { id: string; title: string; type: string; meta?: string }) => (
    <button
      type="button"
      onClick={() => go({ kind: "node", id })}
      className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-white/5"
    >
      <TypeIcon t={type} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-200 group-hover:text-cyan-200">{title}</span>
      {meta && <span className="shrink-0 text-[10px] text-slate-500">{meta}</span>}
    </button>
  );

  const RelSection = ({ label, count, children }: { label: string; count: number; children: ReactNode }) =>
    count === 0 ? null : (
      <section>
        <h3 className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
          {label}
          <span className="rounded-full bg-slate-800 px-1.5 text-[10px] font-normal text-slate-400">{count}</span>
        </h3>
        <div className="-mx-1">{children}</div>
      </section>
    );

  const primary = detail?.versions.find((v) => v.status === "fresh") ?? detail?.versions[0];

  const detailPane = detail && (
    <div className="space-y-5">
      {/* Title row */}
      <div className="flex items-center gap-2">
        <TypeIcon t={detail.node.nodeType} />
        <h2 className="min-w-0 flex-1 truncate font-mono text-base font-semibold">{detail.node.title}</h2>
        {primary && (
          <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-slate-300">{primary.kind}</span>
        )}
        {detail.note && detail.note.type !== "note" && (
          <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] uppercase text-emerald-300">
            {detail.note.type}{detail.note.status ? ` · ${detail.note.status}` : ""}
          </span>
        )}
        {detail.node.nodeType === "note" && (
          <button
            type="button"
            onClick={() => void editNote(detail.node.identityKey)}
            className="flex h-7 items-center gap-1 rounded border border-slate-700 px-2 text-xs text-slate-300 hover:bg-white/5"
          >
            <Pencil className="h-3.5 w-3.5" /> 编辑
          </button>
        )}
        <button
          type="button"
          onClick={() => go({ kind: "graph", id: detail.node.id })}
          className="flex h-7 items-center gap-1 rounded border border-slate-700 px-2 text-xs text-slate-300 hover:bg-white/5"
        >
          <Network className="h-3.5 w-3.5" /> 图谱
        </button>
      </div>

      {/* Location */}
      {primary && (
        <div className="flex items-center gap-1.5 text-xs text-slate-400">
          <FileCode className="h-3.5 w-3.5 shrink-0 text-slate-500" />
          <span className="min-w-0 truncate font-mono">{primary.filePath}</span>
          {primary.startLine != null && <span className="shrink-0 text-slate-500">:{primary.startLine}</span>}
          <span className={cn("ml-1 h-1.5 w-1.5 shrink-0 rounded-full", primary.status === "fresh" ? "bg-emerald-400" : "bg-slate-600")} title={primary.status} />
        </div>
      )}

      {/* Signature */}
      {primary?.signature && (
        <div className="rounded-md border border-slate-800 bg-slate-950/50 px-3 py-2 font-mono text-xs text-cyan-100">
          {primary.signature}
        </div>
      )}

      {/* Source code (read off disk) */}
      {detail.source && (
        <section>
          <div className="flex items-center justify-between rounded-t-md border border-b-0 border-slate-800 bg-slate-900/60 px-3 py-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">源码</span>
            <span className="font-mono text-[10px] text-slate-500">{detail.source.lang}</span>
          </div>
          <pre className="max-h-[420px] overflow-auto rounded-b-md border border-slate-800 bg-slate-950/70 p-3 text-xs leading-relaxed text-slate-200">
            <code className="font-mono">{detail.source.code}</code>
          </pre>
        </section>
      )}

      {/* Note body */}
      {detail.body != null && (
        <section>
          <h3 className="mb-1 text-[11px] font-medium uppercase text-slate-400">正文</h3>
          <textarea readOnly value={detail.body} className="h-40 w-full rounded-md border border-slate-800 bg-slate-950/40 p-2 font-mono text-xs text-slate-200" />
        </section>
      )}

      {/* Relations */}
      <RelSection label="调用 →" count={calls?.nodes.length ?? 0}>
        {calls?.nodes.map((n) => <RelRow key={n.nodeId} id={n.nodeId} title={n.title} type={n.nodeType} />)}
      </RelSection>
      <RelSection label="← 被引用 / 谁调用" count={backlinks?.nodes.length ?? 0}>
        {backlinks?.nodes.map((n) => <RelRow key={n.nodeId} id={n.nodeId} title={n.title} type={n.nodeType} />)}
      </RelSection>
      <RelSection label="同文件符号" count={siblings.length}>
        {siblings.map((s) => (
          <RelRow key={s.nodeId} id={s.nodeId} title={s.title} type="symbol" meta={s.status === "stale" ? `${s.kind} · stale` : s.kind} />
        ))}
      </RelSection>

      {/* Aliases */}
      {detail.aliases.length > 0 && (
        <section>
          <h3 className="mb-1 text-[11px] font-medium uppercase text-slate-400">别名历史</h3>
          {detail.aliases.map((a, i) => (
            <div key={i} className="font-mono text-xs text-slate-400">
              {a.aliasKey} <span className="text-slate-600">({a.reason ?? "?"}{a.validTo ? ", undone" : ""})</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );

  return (
    <div className="flex h-full flex-col bg-[#0b111a] text-slate-100">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-800 px-6 py-4">
        <Database className="h-5 w-5 shrink-0 text-cyan-300" />
        <h1 className="shrink-0 text-lg font-semibold">知识 Wiki</h1>
        <span className="ml-2 min-w-0 flex-1 truncate text-xs text-slate-400">
          {status?.exists ? `${status.repos} repos · ${status.symbols} symbols · ${status.notes} notes` : "未初始化 — 运行 penguin init"}
        </span>
        <button
          type="button"
          onClick={back}
          disabled={trail.length <= 1}
          title="返回上一步"
          className="flex h-8 items-center gap-1 rounded-md border border-slate-800 px-2 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-30"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> 返回
        </button>
        <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950/40 p-0.5">
          <ModeButton m="browse" icon={<FolderTree className="h-3.5 w-3.5" />} label="浏览" />
          <ModeButton m="graph" icon={<Network className="h-3.5 w-3.5" />} label="图谱" />
        </div>
        <button type="button" onClick={onClose} className="ml-auto rounded p-1.5 hover:bg-white/5" aria-label="关闭">
          <X className="h-4 w-4" />
        </button>
      </header>

      {error && <div className="mx-6 mt-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-200">{error}</div>}

      {/* GRAPH MODE — full-width canvas */}
      {mode === "graph" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-3 border-b border-slate-800 px-6 py-2 text-xs text-slate-400">
            {graphLoading ? (
              <span className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载图谱…</span>
            ) : graphData ? (
              <>
                <span>{graphData.nodes.length} 节点 · {graphData.edges.length} 边</span>
                {focusNode && (
                  <>
                    <span className="text-slate-600">·</span>
                    <span className="font-mono text-cyan-200">焦点 {focusNode.title}</span>
                    <button type="button" onClick={() => go({ kind: "node", id: focusNode.nodeId })} className="ml-2 rounded border border-slate-700 px-2 py-0.5 hover:bg-white/5">打开详情</button>
                  </>
                )}
                <span className="ml-auto text-slate-600">点节点可重新聚焦</span>
              </>
            ) : (
              <span>从「浏览」里分支的 ⌗ 按钮,或某个符号详情的「图谱」进入</span>
            )}
          </div>
          <div className="min-h-0 flex-1">
            {graphData && graphData.nodes.length > 0 && <WikiGraph data={graphData} onNodeClick={(id) => go({ kind: "graph", id })} />}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* LEFT: browse tree */}
          <div className="min-h-0 w-1/2 overflow-y-auto border-r border-slate-800 p-2">
            <WikiBrowseTree
              onSelectFile={(branchId, filePath) => go({ kind: "file", branchId, filePath })}
              onOpenRepoGraph={(repoId, branchId) => go({ kind: "repograph", repoId, branchId })}
              selected={selectedFile}
            />
          </div>

          {/* RIGHT: node detail, or (file selected) the file's symbols, or note editor */}
          <div className="min-h-0 w-1/2 overflow-y-auto p-4">
            {editing ? (
              <div className="flex h-full flex-col gap-2">
                <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
                  <Pencil className="h-4 w-4 text-emerald-300" />
                  <span className="min-w-0 flex-1 truncate font-mono text-sm">{editing.slug}.md</span>
                  <button type="button" onClick={() => setEditing(null)} className="rounded border border-slate-700 px-2 py-1 text-xs hover:bg-white/5">取消</button>
                  <button type="button" onClick={() => void saveNote()} disabled={savingNote} className="flex items-center gap-1 rounded bg-cyan-500/20 px-2 py-1 text-xs text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-50">
                    <Save className="h-3.5 w-3.5" /> {savingNote ? "保存中" : "保存"}
                  </button>
                </div>
                <div className="min-h-0 flex-1">
                  <WikiNoteEditor body={editing.body} onChange={(v) => setEditing((e) => (e ? { ...e, body: v } : e))} />
                </div>
              </div>
            ) : detailPane ? (
              detailPane
            ) : selectedFile ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
                  <FileCode className="h-4 w-4 text-slate-400" />
                  <span className="min-w-0 flex-1 truncate font-mono text-sm">{selectedFile.filePath}</span>
                  <span className="text-[11px] text-slate-500">{fileSymbols.length} symbols</span>
                </div>
                {fileSymbols.length === 0 ? (
                  <p className="px-1 py-4 text-sm text-slate-500">该文件没有可索引的符号</p>
                ) : (
                  fileSymbols.map((s) => (
                    <button key={s.nodeId} type="button" onClick={() => go({ kind: "node", id: s.nodeId })} className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left hover:bg-white/5">
                      <Box className="h-3.5 w-3.5 text-cyan-300" />
                      <span className="min-w-0 flex-1 truncate font-mono text-sm">{s.title}</span>
                      <span className="text-[11px] text-slate-500">{s.kind}{s.status === "stale" ? " · stale" : ""}</span>
                    </button>
                  ))
                )}
              </div>
            ) : (
              <p className="px-2 py-6 text-sm text-slate-500">从左侧选择文件查看符号</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

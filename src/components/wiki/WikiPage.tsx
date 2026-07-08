import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Search, RefreshCw, Database, FileText, Box, Loader2, X, FolderTree, Network, FileCode } from "lucide-react";
import { cn } from "@/lib/utils";
import { WikiBrowseTree } from "@/components/wiki/WikiBrowseTree";
import { WikiGraph } from "@/components/wiki/WikiGraph";
import {
  knowledgeDbStatus,
  knowledgeSearch,
  knowledgeNode,
  knowledgeExplore,
  knowledgeReindex,
  knowledgeFileSymbols,
  knowledgeGraph,
  knowledgeRepoGraph,
  parseSearchFilters,
  type KnowledgeDbStatus,
  type KnowledgeSearchHit,
  type KnowledgeNodeDetail,
  type KnowledgeGraphResult,
  type KnowledgeFileSymbol,
  type KnowledgeGraphView,
} from "@/lib/knowledge-client";

interface WikiPageProps {
  onClose: () => void;
}

type Mode = "browse" | "search" | "graph";

// Penguin Knowledge Wiki (§7). Three views over the shared query layer:
//  - Browse: repo → branch → file → symbol navigation tree (default)
//  - Search: unified keyword search
//  - Graph: Obsidian-style force-directed local/repo graph
// No query logic here — all data via the Rust bridge → bundled CLI.
export function WikiPage({ onClose }: WikiPageProps) {
  const [mode, setMode] = useState<Mode>("browse");
  const [status, setStatus] = useState<KnowledgeDbStatus | null>(null);
  const [raw, setRaw] = useState("");
  const [hits, setHits] = useState<KnowledgeSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [detail, setDetail] = useState<KnowledgeNodeDetail | null>(null);
  const [backlinks, setBacklinks] = useState<KnowledgeGraphResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<{ branchId: string; filePath: string } | null>(null);
  const [fileSymbols, setFileSymbols] = useState<KnowledgeFileSymbol[]>([]);
  const [graphData, setGraphData] = useState<KnowledgeGraphView | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(() => {
    knowledgeDbStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(refreshStatus, [refreshStatus]);

  const runSearch = useCallback(async () => {
    setError(null);
    setSearching(true);
    setMode("search");
    try {
      const { query, filters } = parseSearchFilters(raw);
      let results = await knowledgeSearch(query || raw);
      if (filters.type) results = results.filter((h) => h.nodeType === filters.type);
      setHits(results);
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setHits([]);
    } finally {
      setSearching(false);
    }
  }, [raw]);

  const openNode = useCallback(async (nodeId: string) => {
    setError(null);
    try {
      const [d, bl] = await Promise.all([knowledgeNode(nodeId), knowledgeExplore("backlinks", nodeId)]);
      setDetail(d);
      setBacklinks(bl);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  const selectFile = useCallback(async (branchId: string, filePath: string) => {
    setError(null);
    setDetail(null);
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

  const reindex = useCallback(async () => {
    setReindexing(true);
    setError(null);
    try {
      await knowledgeReindex();
      refreshStatus();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setReindexing(false);
    }
  }, [refreshStatus]);

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

  const detailPane = detail && (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <TypeIcon t={detail.node.nodeType} />
        <h2 className="min-w-0 flex-1 truncate font-mono text-base font-semibold">{detail.node.title}</h2>
        <button
          type="button"
          onClick={() => void focusGraph(detail.node.id)}
          className="flex h-7 items-center gap-1 rounded border border-slate-700 px-2 text-xs text-slate-300 hover:bg-white/5"
        >
          <Network className="h-3.5 w-3.5" /> 图谱
        </button>
      </div>
      {detail.versions.length > 0 && (
        <section>
          <h3 className="mb-1 text-[11px] font-medium uppercase text-slate-400">版本（分支）</h3>
          {detail.versions.map((v, i) => (
            <div key={i} className="flex items-center gap-2 text-xs text-slate-300">
              <span className={cn("h-1.5 w-1.5 rounded-full", v.status === "fresh" ? "bg-emerald-400" : "bg-slate-600")} />
              <span className="font-mono">{v.filePath}</span>
              <span className="text-slate-500">{v.kind} · {v.status}</span>
            </div>
          ))}
        </section>
      )}
      {detail.body != null && (
        <section>
          <h3 className="mb-1 text-[11px] font-medium uppercase text-slate-400">正文</h3>
          <textarea readOnly value={detail.body} className="h-40 w-full rounded-md border border-slate-800 bg-slate-950/40 p-2 font-mono text-xs text-slate-200" />
        </section>
      )}
      {backlinks && backlinks.nodes.length > 0 && (
        <section>
          <h3 className="mb-1 text-[11px] font-medium uppercase text-slate-400">反向链接 / 谁引用</h3>
          {backlinks.nodes.map((n) => (
            <button key={n.nodeId} type="button" onClick={() => void openNode(n.nodeId)} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-white/5">
              <TypeIcon t={n.nodeType} />
              <span className="font-mono">{n.title}</span>
            </button>
          ))}
        </section>
      )}
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
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-800 px-6 py-4">
        <Database className="h-5 w-5 text-cyan-300" />
        <h1 className="text-lg font-semibold">知识 Wiki</h1>
        <span className="ml-2 text-xs text-slate-400">
          {status?.exists ? `${status.repos} repos · ${status.symbols} symbols · ${status.notes} notes` : "未初始化 — 运行 penguin init 或点重建"}
        </span>
        <div className="ml-4 flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950/40 p-0.5">
          <ModeButton m="browse" icon={<FolderTree className="h-3.5 w-3.5" />} label="浏览" />
          <ModeButton m="search" icon={<Search className="h-3.5 w-3.5" />} label="搜索" />
          <ModeButton m="graph" icon={<Network className="h-3.5 w-3.5" />} label="图谱" />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={reindex} disabled={reindexing} className="flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm hover:bg-white/5 disabled:opacity-50">
            <RefreshCw className={cn("h-4 w-4", reindexing && "animate-spin")} />
            {reindexing ? "重建中" : "重建索引"}
          </button>
          <button type="button" onClick={onClose} className="rounded p-1.5 hover:bg-white/5" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      {mode === "search" && (
        <div className="border-b border-slate-800 px-6 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void runSearch()}
              placeholder="搜索知识（支持 type: repo: tag: entity: 过滤）"
              className="h-9 w-full rounded-md border border-slate-700 bg-slate-950/40 pl-10 pr-3 text-sm outline-none focus:border-cyan-400/60"
              autoFocus
            />
            {searching && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-cyan-300" />}
          </div>
        </div>
      )}

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
                    <button type="button" onClick={() => void openNode(focusNode.nodeId)} className="ml-2 rounded border border-slate-700 px-2 py-0.5 hover:bg-white/5">打开详情</button>
                  </>
                )}
                <span className="ml-auto text-slate-600">点节点可重新聚焦</span>
              </>
            ) : (
              <span>从「浏览」里分支的 ⌗ 按钮,或某个符号详情的「图谱」进入</span>
            )}
          </div>
          <div className="min-h-0 flex-1">
            {graphData && graphData.nodes.length > 0 && <WikiGraph data={graphData} onNodeClick={(id) => void focusGraph(id)} />}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* LEFT: browse tree OR search results */}
          <div className="min-h-0 w-1/2 overflow-y-auto border-r border-slate-800 p-2">
            {mode === "browse" ? (
              <WikiBrowseTree onSelectFile={selectFile} onOpenRepoGraph={openRepoGraph} selected={selectedFile} />
            ) : hits.length === 0 ? (
              <p className="px-2 py-6 text-sm text-slate-500">输入关键字后回车搜索</p>
            ) : (
              hits.map((h) => (
                <button
                  key={h.nodeId}
                  type="button"
                  onClick={() => void openNode(h.nodeId)}
                  className={cn("flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-white/5", detail?.node.id === h.nodeId && "bg-cyan-500/10")}
                >
                  <TypeIcon t={h.nodeType} />
                  <span className="min-w-0 flex-1 truncate font-mono text-sm">{h.title}</span>
                  <span className="text-[11px] text-slate-500">{h.nodeType}</span>
                </button>
              ))
            )}
          </div>

          {/* RIGHT: node detail, or (browse + file selected) the file's symbols */}
          <div className="min-h-0 w-1/2 overflow-y-auto p-4">
            {detailPane ? (
              detailPane
            ) : mode === "browse" && selectedFile ? (
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
                    <button key={s.nodeId} type="button" onClick={() => void openNode(s.nodeId)} className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left hover:bg-white/5">
                      <Box className="h-3.5 w-3.5 text-cyan-300" />
                      <span className="min-w-0 flex-1 truncate font-mono text-sm">{s.title}</span>
                      <span className="text-[11px] text-slate-500">{s.kind}{s.status === "stale" ? " · stale" : ""}</span>
                    </button>
                  ))
                )}
              </div>
            ) : (
              <p className="px-2 py-6 text-sm text-slate-500">{mode === "browse" ? "从左侧选择文件查看符号" : "选择左侧结果查看详情"}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

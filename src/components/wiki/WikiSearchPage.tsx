import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, Network, Bookmark, ClipboardList } from "lucide-react";
import { knowledgeContext, knowledgeEvidenceList, knowledgeExplore, knowledgeGetHit, knowledgeGraph, knowledgeIndexStatus, knowledgeReindex, knowledgeSavedQueryList, knowledgeSavedQueryRun, knowledgeSavedQueryWrite, knowledgeSearchV2, type ContextPack, type KnowledgeEvidenceNote, type KnowledgeGraphResult, type KnowledgeGraphView, type KnowledgeHitDetail, type KnowledgeSavedQuery, type KnowledgeSearchV2Response } from "@/lib/knowledge-client";
import { getPersistedValue, setPersistedValue } from "@/lib/app-persistence";
import { APP_VALUE_KEYS } from "@/lib/persistence-keys";
import { ScopeBadge } from "@/components/wiki/ScopeBadge";

// Every result row is locked to this exact pixel height so the windowing math
// (which slices the list by a fixed row height) stays aligned even when a hit
// carries a multi-line code snippet. Taller content is clipped inside the row;
// the full excerpt is shown in the preview panel on click.
const ROW_HEIGHT = 154;

// Aborts are expected (a newer request superseded this one) — everything else
// is a real failure worth surfacing instead of swallowing silently.
const errText = (e: unknown) =>
  (e as Error)?.name === "AbortError" ? null : String((e as Error)?.message ?? e);

function initialSearchState() {
  if (typeof window === "undefined") return { query: "", mode: "auto", repo: "", branch: "", snapshot: "", path: "", language: "", kind: "" };
  const params = new URLSearchParams(window.location.search);
  return {
    query: params.get("q") ?? "",
    mode: params.get("mode") ?? "auto",
    repo: params.get("repo") ?? "",
    branch: params.get("branch") ?? "",
    snapshot: params.get("snapshot") ?? "",
    path: params.get("path") ?? "",
    language: params.get("language") ?? "",
    kind: params.get("kind") ?? "",
  };
}

export function WikiSearchPage() {
  const initial = initialSearchState();
  const [query, setQuery] = useState(initial.query);
  const [mode, setMode] = useState(initial.mode);
  const [response, setResponse] = useState<KnowledgeSearchV2Response | null>(null);
  const [contextPack, setContextPack] = useState<ContextPack | null>(null);
  const [hitPreview, setHitPreview] = useState<KnowledgeHitDetail | null>(null);
  const [graphView, setGraphView] = useState<KnowledgeGraphView | null>(null);
  const [selectedGraphNode, setSelectedGraphNode] = useState<KnowledgeGraphView["nodes"][number] | null>(null);
  const [noteLinks, setNoteLinks] = useState<KnowledgeGraphResult["nodes"]>([]);
  const [graphBusy, setGraphBusy] = useState(false);
  const [laneFilter, setLaneFilter] = useState("all");
  const [repoFilter, setRepoFilter] = useState(initial.repo);
  const [branchFilter, setBranchFilter] = useState(initial.branch);
  const [snapshotFilter, setSnapshotFilter] = useState(initial.snapshot);
  const [pathFilter, setPathFilter] = useState(initial.path);
  const [languageFilter, setLanguageFilter] = useState(initial.language);
  const [kindFilter, setKindFilter] = useState(initial.kind);
  const [evidenceFilter, setEvidenceFilter] = useState("all");
  const [savedName, setSavedName] = useState("");
  const [savedQueries, setSavedQueries] = useState<KnowledgeSavedQuery[]>([]);
  const [pinnedSavedQueries, setPinnedSavedQueries] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(getPersistedValue(APP_VALUE_KEYS.wikiPinnedSavedQueries) ?? "[]") as string[]; } catch { return []; }
  });
  const [evidence, setEvidence] = useState<KnowledgeEvidenceNote[]>([]);
  const [contextBusy, setContextBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reindexBusy, setReindexBusy] = useState(false);
  const [reindexVersion, setReindexVersion] = useState(0);
  const [previewLines, setPreviewLines] = useState(() => {
    if (typeof window === "undefined") return 5;
    const value = Number(getPersistedValue(APP_VALUE_KEYS.wikiPreviewLines) ?? 5);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 5;
  });
  const [recentQueries, setRecentQueries] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(getPersistedValue(APP_VALUE_KEYS.wikiRecentQueries) ?? "[]") as string[]; } catch { return []; }
  });
  const [selectedHitIndex, setSelectedHitIndex] = useState(0);
  const [resultScrollTop, setResultScrollTop] = useState(0);
  const resultViewport = useRef<HTMLDivElement | null>(null);
  const requestId = useRef(0);
  const searchAbort = useRef<AbortController | null>(null);
  const contextAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (mode !== "auto") params.set("mode", mode);
    for (const [key, value] of [["repo", repoFilter], ["branch", branchFilter], ["snapshot", snapshotFilter], ["path", pathFilter], ["language", languageFilter], ["kind", kindFilter]] as const) {
      if (value.trim()) params.set(key, value.trim());
    }
    const encoded = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${encoded ? `?${encoded}` : ""}${window.location.hash}`);
  }, [branchFilter, kindFilter, languageFilter, mode, pathFilter, query, reindexVersion, repoFilter, snapshotFilter]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>("[data-wiki-search]")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const text = query.trim();
    searchAbort.current?.abort();
    // A new search (whether the query text or any scope filter changed)
    // obsoletes whatever hit's context/preview was open — clear them here,
    // not only when the query goes empty, so the ScopeBadge and preview
    // panel never linger next to a fresh, unrelated result set. Abort any
    // in-flight openContext too, otherwise its late resolution could write
    // the stale pack/preview right back in after this clears them.
    contextAbort.current?.abort();
    setContextPack(null);
    setHitPreview(null);
    if (!text) { setResponse(null); setGraphView(null); return; }
    const id = ++requestId.current;
    const controller = new AbortController();
    searchAbort.current = controller;
    const timer = window.setTimeout(() => {
      setBusy(true);
      void knowledgeSearchV2(text, mode, { repo: repoFilter || undefined, branch: branchFilter || undefined, snapshot: snapshotFilter || undefined, path: pathFilter || undefined, language: languageFilter || undefined, kind: kindFilter || undefined, signal: controller.signal }).then((result) => {
        if (id !== requestId.current) return;
        setResponse(result);
        setRecentQueries((items) => {
          const next = [text, ...items.filter((item) => item !== text)].slice(0, 8);
          try { setPersistedValue(APP_VALUE_KEYS.wikiRecentQueries, JSON.stringify(next)); } catch { /* local-only preference is best effort */ }
          return next;
        });
      }).catch((error) => { if ((error as Error).name !== "AbortError" && id === requestId.current) setResponse(null); }).finally(() => { if (id === requestId.current) setBusy(false); });
    }, 150);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [branchFilter, kindFilter, languageFilter, mode, pathFilter, query, repoFilter, snapshotFilter]);

  useEffect(() => { void knowledgeSavedQueryList().then(setSavedQueries).catch(() => setSavedQueries([])); }, []);

  const openContext = async (hit: KnowledgeSearchV2Response["hits"][number]) => {
    contextAbort.current?.abort();
    const controller = new AbortController();
    contextAbort.current = controller;
    setContextBusy(true);
    try {
      const [preview, context] = await Promise.all([
        knowledgeGetHit(hit.locator, { signal: controller.signal }, previewLines).catch(() => null),
        knowledgeContext(hit.locator.filePath, { signal: controller.signal }),
      ]);
      // A newer openContext may have superseded this one while awaiting — never
      // let a slow earlier response clobber the current selection's context.
      if (contextAbort.current !== controller) return;
      setHitPreview(preview);
      setContextPack(context);
      void knowledgeEvidenceList({ target: hit.title, limit: 20, signal: controller.signal }).then((ev) => { if (contextAbort.current === controller) setEvidence(ev); }).catch(() => {});
      if (hit.lane === "note") void knowledgeExplore("backlinks", hit.title, { signal: controller.signal }).then((result) => { if (contextAbort.current === controller) setNoteLinks(result.nodes ?? []); }).catch(() => {});
      else setNoteLinks([]);
    } catch (error) {
      // Aborted by a newer request, or the context load failed. Don't surface an
      // unhandled rejection; only clear if this is still the active request.
      if ((error as Error).name !== "AbortError" && contextAbort.current === controller) {
        setHitPreview(null); setContextPack(null);
      }
    }
    finally { if (contextAbort.current === controller) setContextBusy(false); }
  };

  const loadMore = async () => {
    if (!response?.page.nextCursor) return;
    setBusy(true);
    const controller = new AbortController();
    searchAbort.current?.abort();
    searchAbort.current = controller;
    try {
      const next = await knowledgeSearchV2(query.trim(), mode, { cursor: response.page.nextCursor, limit: response.page.limit, repo: repoFilter || undefined, branch: branchFilter || undefined, snapshot: snapshotFilter || undefined, path: pathFilter || undefined, language: languageFilter || undefined, kind: kindFilter || undefined, signal: controller.signal });
      setResponse({ ...next, hits: [...response.hits, ...next.hits.filter((hit) => !response.hits.some((existing) => existing.hitId === hit.hitId))] });
    } catch (e) { const m = errText(e); if (m) setActionError(m); } finally { if (searchAbort.current === controller) setBusy(false); }
  };

  const openGraph = async () => {
    const target = contextPack?.focus?.nodeId;
    if (!target) return;
    setGraphBusy(true);
    const controller = new AbortController();
    contextAbort.current?.abort();
    contextAbort.current = controller;
    try { const view = await knowledgeGraph(target, 1, { signal: controller.signal }); setGraphView(view); setSelectedGraphNode(view.nodes.find((node) => node.nodeId === target) ?? null); } catch (e) { const m = errText(e); if (m) setActionError(m); } finally { if (contextAbort.current === controller) setGraphBusy(false); }
  };

  const focusGraphNode = (node: KnowledgeGraphView["nodes"][number]) => {
    setSelectedGraphNode(node);
    setQuery(node.title);
  };
  const openGraphNodeContext = async () => {
    if (!selectedGraphNode) return;
    setContextBusy(true);
    try { setContextPack(await knowledgeContext(selectedGraphNode.nodeId)); } catch (e) { const m = errText(e); if (m) setActionError(m); } finally { setContextBusy(false); }
  };
  const exportGraphSelection = () => {
    if (!graphView) return;
    const canvas = {
      nodes: graphView.nodes.map((node, index) => ({ id: node.nodeId, type: "text", text: `${node.title} (${node.nodeType})`, x: (index % 4) * 260, y: Math.floor(index / 4) * 150, width: 220, height: 90, "penguin-locator": { nodeId: node.nodeId } })),
      edges: graphView.edges.map((edge, index) => ({ id: `edge-${index + 1}`, fromNode: edge.src, toNode: edge.dst, label: edge.edgeType })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(canvas, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "penguin-graph-selection.canvas"; anchor.click(); URL.revokeObjectURL(url);
  };

  const visibleHits = response?.hits.filter((hit) => (laneFilter === "all" || hit.lane === laneFilter) && (evidenceFilter === "all" || hit.evidence[0]?.status === evidenceFilter)) ?? [];
  const virtualWindow = useMemo(() => {
    const rowEstimate = ROW_HEIGHT;
    const overscan = 6;
    const start = Math.max(0, Math.floor(resultScrollTop / rowEstimate) - overscan);
    const end = Math.min(visibleHits.length, start + 20 + overscan * 2);
    return { start, end, top: start * rowEstimate, bottom: Math.max(0, (visibleHits.length - end) * rowEstimate) };
  }, [resultScrollTop, visibleHits.length]);

  useEffect(() => {
    setSelectedHitIndex((index) => Math.min(Math.max(0, index), Math.max(0, visibleHits.length - 1)));
  }, [visibleHits.length, laneFilter, evidenceFilter]);

  const activateSelectedHit = () => {
    const hit = visibleHits[selectedHitIndex];
    if (hit) void openContext(hit);
  };
  const openCodeLocation = async (hit: KnowledgeSearchV2Response["hits"][number]) => {
    if (hit.locator.revisionKind !== "working_tree") return;
    if (hit.locator.filePath.split("/").some((part) => part === ".." || part === "")) return;
    try {
      const status = await knowledgeIndexStatus();
      const repo = status.repos.find((item) => item.name === hit.locator.repoName);
      if (!repo) return;
      const absolute = `${repo.rootPath.replace(/\/+$/, "")}/${hit.locator.filePath}`;
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(`vscode://file${encodeURI(absolute)}${hit.locator.startLine ? `:${hit.locator.startLine}` : ""}`);
    } catch (e) { const m = errText(e); if (m) setActionError(m); }
  };

  const saveCurrentQuery = async () => {
    const name = savedName.trim();
    if (!name || !query.trim()) return;
    try {
      const saved = await knowledgeSavedQueryWrite(name, { query: query.trim(), mode, scope: { paths: pathFilter ? [pathFilter] : [] }, page: { limit: 20 } });
      setSavedQueries((items) => [...items.filter((item) => item.name !== saved.name), saved]);
      setSavedName("");
    } catch (e) { const m = errText(e); if (m) setActionError(m); }
  };

  const reindexScope = async () => {
    const scope = [repoFilter && `repo=${repoFilter}`, branchFilter && `branch=${branchFilter}`, snapshotFilter && `snapshot=${snapshotFilter}`, pathFilter && `path=${pathFilter}`].filter(Boolean).join(", ") || "当前 workspace";
    if (!window.confirm(`将重新索引 ${scope}。这是写操作，是否继续？`)) return;
    setReindexBusy(true);
    try { await knowledgeReindex(pathFilter || undefined); setReindexVersion((value) => value + 1); }
    catch (e) { const m = errText(e); if (m) setActionError(m); }
    finally { setReindexBusy(false); }
  };
  const togglePinnedSavedQuery = (id: string) => {
    setPinnedSavedQueries((current) => {
      const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
      setPersistedValue(APP_VALUE_KEYS.wikiPinnedSavedQueries, JSON.stringify(next));
      return next;
    });
  };
  const orderedSavedQueries = useMemo(() => [...savedQueries].sort((left, right) => Number(pinnedSavedQueries.includes(right.id)) - Number(pinnedSavedQueries.includes(left.id))), [pinnedSavedQueries, savedQueries]);

  return <div className="flex min-h-0 flex-1 flex-col bg-[#080d14]">
    <div className="flex items-center gap-2 border-b border-slate-800 p-4">
      <Search className="h-4 w-4 text-cyan-300" />
      <input data-wiki-search autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") setQuery((value) => value.trim()); }} placeholder="搜索代码、路径、知识… (⌘K)" className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-600" />
      <select value={mode} onChange={(event) => setMode(event.target.value)} className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300">
        {(["auto", "exact", "phrase", "path", "regex", "structural", "semantic"] as const).map((value) => <option key={value}>{value}</option>)}
      </select>
      <select aria-label="筛选检索通道" value={laneFilter} onChange={(event) => setLaneFilter(event.target.value)} className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300">
        <option value="all">全部通道</option>
        {[...new Set(response?.hits.map((hit) => hit.lane) ?? [])].map((lane) => <option key={lane} value={lane}>{lane}</option>)}
      </select>
      <input aria-label="筛选仓库" value={repoFilter} onChange={(event) => setRepoFilter(event.target.value)} placeholder="repo" className="w-24 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300" />
      <input aria-label="筛选分支" value={branchFilter} onChange={(event) => setBranchFilter(event.target.value)} placeholder="branch" className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300" />
      <input aria-label="筛选 snapshot" value={snapshotFilter} onChange={(event) => setSnapshotFilter(event.target.value)} placeholder="snapshot" className="w-24 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300" />
      <input aria-label="筛选路径" value={pathFilter} onChange={(event) => setPathFilter(event.target.value)} placeholder="path" className="w-28 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300" />
      <input aria-label="筛选语言" value={languageFilter} onChange={(event) => setLanguageFilter(event.target.value)} placeholder="language" className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300" />
      <input aria-label="筛选 kind" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)} placeholder="kind" className="w-16 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300" />
      <input aria-label="预览行数" type="number" min={0} max={100} value={previewLines} onChange={(event) => { const value = Math.max(0, Math.min(100, Number(event.target.value) || 0)); setPreviewLines(value); setPersistedValue(APP_VALUE_KEYS.wikiPreviewLines, String(value)); }} className="w-14 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300" title="预览前后行数" />
      <select aria-label="筛选 evidence 状态" value={evidenceFilter} onChange={(event) => setEvidenceFilter(event.target.value)} className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300"><option value="all">evidence</option><option value="verified">verified</option><option value="observed">observed</option><option value="inference">inference</option></select>
      <input aria-label="保存查询名称" value={savedName} onChange={(event) => setSavedName(event.target.value)} placeholder="保存名" className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300" />
      <button type="button" aria-label="保存当前查询" disabled={!savedName.trim() || !query.trim()} onClick={() => void saveCurrentQuery()} className="rounded border border-slate-700 p-1 text-slate-400 disabled:opacity-40"><Bookmark className="h-3.5 w-3.5" /></button>
    </div>
    {actionError && <div className="flex items-center justify-between gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300"><span className="min-w-0 truncate">{actionError}</span><button type="button" aria-label="关闭错误" onClick={() => setActionError(null)} className="shrink-0 rounded px-1.5 py-0.5 hover:bg-white/10">✕</button></div>}
    {busy && <div className="flex items-center gap-2 px-4 py-3 text-xs text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 搜索中…</div>}
    {!busy && response && <div ref={resultViewport} tabIndex={0} onScroll={(event) => setResultScrollTop(event.currentTarget.scrollTop)} onKeyDown={(event) => {
      if (!visibleHits.length) return;
      if (event.key === "ArrowDown") { event.preventDefault(); setSelectedHitIndex((index) => Math.min(index + 1, visibleHits.length - 1)); }
      if (event.key === "ArrowUp") { event.preventDefault(); setSelectedHitIndex((index) => Math.max(index - 1, 0)); }
      if (event.key === "Enter") { event.preventDefault(); activateSelectedHit(); }
    }} className="min-h-0 flex-1 overflow-auto p-4 outline-none" aria-label="知识搜索结果">
      {orderedSavedQueries.length > 0 && <div className="mb-3 flex flex-wrap gap-1.5" aria-label="Knowledge 已保存查询">{orderedSavedQueries.map((saved) => <span key={saved.id} className="inline-flex items-center rounded border border-slate-800"><button type="button" onClick={() => { void knowledgeSavedQueryRun(saved.name).then(setResponse); }} className="px-2 py-1 text-[11px] text-slate-400 hover:text-cyan-200"><Bookmark className="mr-1 inline h-3 w-3" />{saved.name}</button><button type="button" aria-label={`${pinnedSavedQueries.includes(saved.id) ? "取消置顶" : "置顶"} ${saved.name}`} onClick={() => togglePinnedSavedQuery(saved.id)} className="border-l border-slate-800 px-1.5 py-1 text-[10px] text-slate-500 hover:text-amber-300">{pinnedSavedQueries.includes(saved.id) ? "★" : "☆"}</button></span>)}</div>}
      {recentQueries.length > 0 && <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500"><span>最近查询</span>{recentQueries.map((recent) => <button type="button" key={recent} onClick={() => setQuery(recent)} className="rounded border border-slate-800 px-2 py-1 text-slate-400 hover:border-cyan-500/40 hover:text-cyan-200">{recent}</button>)}</div>}
      <div className="mb-3 rounded border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-400">
        已搜索：{response.diagnostics.searchedLanes.join(", ")} · 覆盖 {response.diagnostics.coverage.admitted} admitted / {response.diagnostics.coverage.excluded} excluded / {response.diagnostics.coverage.failed} failed
        {response.diagnostics.resolvedScopes[0] && <span className="ml-2 rounded border border-cyan-500/20 px-1.5 py-0.5 text-cyan-300">revision: {response.diagnostics.resolvedScopes[0].branch} · {response.diagnostics.resolvedScopes[0].snapshotId}</span>}
        {/* Sourced from the opened hit's Context Pack, not the raw search response —
            KnowledgeSearchV2Response doesn't carry its own locator/alignment/warnings
            envelope yet (would need CLI-bridge verification; deferred as a follow-up).
            resolvedScopes above already covers the result set's scope. */}
        <ScopeBadge locator={contextPack?.locator} alignment={contextPack?.alignment} warnings={contextPack?.warnings} className="mt-1" />
      </div>
      {visibleHits.length === 0 ? <div className="rounded border border-yellow-500/20 bg-yellow-500/5 p-4 text-sm text-yellow-200">
        <div>没有结果。{response.diagnostics.warnings.map((warning) => warning.message).join(" ")}</div>
        <div className="mt-2 text-[11px] text-yellow-200/70">已搜索 {response.diagnostics.searchedLanes.join(", ")} · scope 覆盖 {response.diagnostics.coverage.admitted} admitted / {response.diagnostics.coverage.excluded} excluded / {response.diagnostics.coverage.failed} failed。</div>
        {response.diagnostics.exclusions.length > 0 && <div className="mt-1 text-[11px] text-amber-300/80">命中 excluded path metadata；内容因 secret policy 被隐藏。</div>}
        <button type="button" onClick={() => void reindexScope()} disabled={reindexBusy} className="mt-3 rounded border border-yellow-400/30 px-2.5 py-1 text-xs text-yellow-100 hover:bg-yellow-400/10 disabled:opacity-50">{reindexBusy ? "重新索引中…" : "确认后重新索引此范围"}</button>
      </div> : <div style={{ contain: "layout paint", minHeight: `${visibleHits.length * ROW_HEIGHT}px` }}>
        <div aria-hidden="true" style={{ height: `${virtualWindow.top}px` }} />
        {visibleHits.slice(virtualWindow.start, virtualWindow.end).map((hit, offset) => { const index = virtualWindow.start + offset; return <div key={hit.hitId} style={{ height: ROW_HEIGHT }} className="pb-2"><article role="button" tabIndex={0} aria-selected={selectedHitIndex === index} onClick={() => { setSelectedHitIndex(index); void openContext(hit); }} onFocus={() => setSelectedHitIndex(index)} onKeyDown={(event) => { if (event.key === "Enter" && event.metaKey) { event.preventDefault(); void openCodeLocation(hit); } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedHitIndex(index); void openContext(hit); } }} className={`flex h-full flex-col overflow-hidden cursor-pointer rounded-lg border bg-slate-950/35 p-3 ${selectedHitIndex === index ? "border-cyan-400/80 ring-1 ring-cyan-400/30" : hit.lane === "semantic" ? "border-violet-500/30" : "border-slate-800 hover:border-cyan-500/40"}`}>
          <div className="flex shrink-0 items-center gap-2 text-xs"><span className="truncate font-semibold text-cyan-200">{hit.title}</span><span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-slate-400">{hit.lane}</span><span className="shrink-0 text-slate-600">{hit.evidence[0]?.status}</span></div>
          <div className="mt-1 shrink-0 truncate font-mono text-[11px] text-slate-400">{hit.locator.repoName} / {hit.locator.filePath}{hit.locator.startLine ? `:${hit.locator.startLine}` : ""} · {hit.locator.revisionId}</div>
          {hit.snippet && <pre className="mt-2 min-h-0 flex-1 overflow-hidden whitespace-pre-wrap text-xs text-slate-300">{hit.snippet}</pre>}
          <div className="mt-2 shrink-0 text-[10px] text-slate-600">{hit.rankReasons.join(" · ")}</div>
        </article></div>; })}
        <div aria-hidden="true" style={{ height: `${virtualWindow.bottom}px` }} />
        </div>}
      {contextBusy && <div className="mt-4 text-xs text-slate-500">加载知识上下文…</div>}
      {hitPreview && <section className="mt-4 rounded-lg border border-slate-700 bg-slate-950/70 p-4">
        <div className="flex items-center gap-2 text-xs text-slate-400"><span className="text-slate-200">完整 excerpt</span><span>{hitPreview.evidence[0]?.status}</span><span className="rounded border border-slate-700 px-1.5 py-0.5">{hitPreview.locator.revisionKind === "working_tree" ? "working tree" : `只读 commit: ${hitPreview.locator.commitSha ?? hitPreview.locator.revisionId}`}</span></div>
        {hitPreview.snippet && <div className="mt-2 max-h-64 overflow-auto font-mono text-xs text-slate-300">{hitPreview.snippet.split("\n").map((line, index) => <div key={`${hitPreview.hitId}-line-${index}`} className="flex min-w-max"><button type="button" className="mr-3 w-10 shrink-0 select-none text-right text-slate-600 hover:text-cyan-300" onClick={() => { const hit = visibleHits.find((item) => item.hitId === hitPreview.hitId); if (hit) void openCodeLocation({ ...hit, locator: { ...hit.locator, startLine: (hitPreview.locator.startLine ?? 1) + index } }); }}>{(hitPreview.locator.startLine ?? 1) + index}</button><span className="whitespace-pre">{line}</span></div>)}</div>}
        {hitPreview.locator.revisionKind === "working_tree" && <button type="button" onClick={() => { const hit = visibleHits.find((item) => item.hitId === hitPreview.hitId); if (hit) void openCodeLocation(hit); }} className="mt-3 rounded border border-cyan-500/30 px-2 py-1 text-xs text-cyan-200">打开代码位置</button>}
      </section>}
      {contextPack && <section className="mt-4 rounded-lg border border-cyan-500/30 bg-cyan-950/10 p-4">
        <div className="text-xs uppercase tracking-wide text-cyan-300">Knowledge context</div>
        {contextPack.focus ? <>
          <div className="mt-1 text-sm font-semibold text-slate-100">{contextPack.focus.title}</div>
          <div className="mt-1 font-mono text-[11px] text-slate-400">{contextPack.focus.filePath ?? contextPack.target}</div>
          {contextPack.focus.source && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-slate-300">{contextPack.focus.source}</pre>}
        </> : <div className="mt-2 text-xs text-yellow-200">找不到结构化 focus；该结果仍可作为 source evidence。</div>}
        <div className="mt-3 grid gap-2 text-xs text-slate-300 sm:grid-cols-2">
          <div>Callers: {contextPack.callers.length}</div><div>Calls: {contextPack.calls.length}</div>
          <div>Tests: {contextPack.tests.length}</div><div>Notes: {contextPack.notes.length}</div>
        </div>
        <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
          {([["Callers", contextPack.callers], ["Callees", contextPack.calls], ["Tests", contextPack.tests], ["Routes", contextPack.routes.map((route) => ({ title: route.route, nodeId: route.via }))]] as const).map(([label, items]) => <div key={label}><div className="text-slate-500">{label}</div>{items.slice(0, 8).map((item) => <div key={`${label}-${item.nodeId}-${item.title}`} className="truncate text-slate-300">{item.title}</div>)}</div>)}
        </div>
        <button type="button" disabled={!contextPack.focus || graphBusy} onClick={() => void openGraph()} className="mt-3 inline-flex items-center gap-2 rounded border border-cyan-500/30 px-2 py-1 text-xs text-cyan-200 disabled:opacity-40"><Network className="h-3.5 w-3.5" />{graphBusy ? "加载图上下文…" : "打开局部图"}</button>
        {contextPack.errors.length > 0 && <div className="mt-2 text-xs text-yellow-200">{contextPack.errors.join(" · ")}</div>}
      </section>}
      {evidence.length > 0 && <section className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-950/10 p-4"><div className="text-xs uppercase tracking-wide text-emerald-300"><ClipboardList className="mr-1 inline h-3.5 w-3.5" />相关 Evidence</div><div className="mt-2 space-y-1 text-xs text-slate-300">{evidence.map((item) => <div key={item.slug}>{item.title} · {item.status} · {item.targetId}</div>)}</div></section>}
      {noteLinks.length > 0 && <section className="mt-4 rounded-lg border border-amber-500/30 bg-amber-950/10 p-4"><div className="text-xs uppercase tracking-wide text-amber-300">Note backlinks / mentions</div><div className="mt-2 space-y-1 text-xs text-slate-300">{noteLinks.map((item) => <div key={item.nodeId}>{item.title} · {item.nodeType}</div>)}</div></section>}
      {graphView && <section className="mt-4 rounded-lg border border-violet-500/30 bg-violet-950/10 p-4">
        <div className="text-xs uppercase tracking-wide text-violet-300">局部知识图</div>
        <div className="mt-2 text-xs text-slate-300">{graphView.nodes.length} nodes · {graphView.edges.length} edges</div>
        <div className="mt-2 flex flex-wrap gap-1.5">{graphView.nodes.slice(0, 30).map((node) => <button type="button" key={node.nodeId} onClick={() => focusGraphNode(node)} className={`rounded bg-slate-900 px-2 py-1 text-[11px] ${selectedGraphNode?.nodeId === node.nodeId ? "text-cyan-200 ring-1 ring-cyan-400/50" : "text-slate-300"}`}>{node.title} <span className="text-slate-600">{node.nodeType}</span></button>)}</div>
        {selectedGraphNode && <div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-cyan-500/20 px-2 py-2 text-xs text-slate-300"><span>已选：{selectedGraphNode.title}</span><button type="button" onClick={() => setQuery(selectedGraphNode.title)} className="rounded border border-slate-700 px-2 py-1 text-cyan-200">送到搜索</button><button type="button" onClick={() => void openGraphNodeContext()} className="rounded border border-slate-700 px-2 py-1 text-cyan-200">送到 context</button><button type="button" onClick={exportGraphSelection} className="rounded border border-slate-700 px-2 py-1 text-cyan-200">导出 Canvas</button></div>}
      </section>}
      {response.page.nextCursor && <button type="button" onClick={() => void loadMore()} className="mt-4 w-full rounded border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-cyan-500/50 hover:text-cyan-200">加载更多结果</button>}
    </div>}
  </div>;
}

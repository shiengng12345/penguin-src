import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, Network, Bookmark, ClipboardList } from "lucide-react";
import { knowledgeContext, knowledgeEvidenceList, knowledgeGetHit, knowledgeGraph, knowledgeSavedQueryList, knowledgeSavedQueryRun, knowledgeSavedQueryWrite, knowledgeSearchV2, type ContextPack, type KnowledgeEvidenceNote, type KnowledgeGraphView, type KnowledgeHitDetail, type KnowledgeSavedQuery, type KnowledgeSearchV2Response } from "@/lib/knowledge-client";

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
  const [evidence, setEvidence] = useState<KnowledgeEvidenceNote[]>([]);
  const [contextBusy, setContextBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recentQueries, setRecentQueries] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(window.localStorage.getItem("penguin.wiki.recentQueries") ?? "[]") as string[]; } catch { return []; }
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
  }, [branchFilter, kindFilter, languageFilter, mode, pathFilter, query, repoFilter, snapshotFilter]);

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
    if (!text) { setResponse(null); setContextPack(null); setHitPreview(null); setGraphView(null); return; }
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
          try { window.localStorage.setItem("penguin.wiki.recentQueries", JSON.stringify(next)); } catch { /* local-only preference is best effort */ }
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
        knowledgeGetHit(hit.locator, { signal: controller.signal }).catch(() => null),
        knowledgeContext(hit.locator.filePath, { signal: controller.signal }),
      ]);
      setHitPreview(preview);
      setContextPack(context);
      void knowledgeEvidenceList({ target: hit.title, limit: 20, signal: controller.signal }).then(setEvidence).catch(() => setEvidence([]));
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
    } finally { if (searchAbort.current === controller) setBusy(false); }
  };

  const openGraph = async () => {
    const target = contextPack?.focus?.nodeId;
    if (!target) return;
    setGraphBusy(true);
    const controller = new AbortController();
    contextAbort.current?.abort();
    contextAbort.current = controller;
    try { setGraphView(await knowledgeGraph(target, 1, { signal: controller.signal })); } finally { if (contextAbort.current === controller) setGraphBusy(false); }
  };

  const visibleHits = response?.hits.filter((hit) => (laneFilter === "all" || hit.lane === laneFilter) && (evidenceFilter === "all" || hit.evidence[0]?.status === evidenceFilter)) ?? [];
  const virtualWindow = useMemo(() => {
    const rowEstimate = 154;
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

  const saveCurrentQuery = async () => {
    const name = savedName.trim();
    if (!name || !query.trim()) return;
    const saved = await knowledgeSavedQueryWrite(name, { query: query.trim(), mode, scope: { paths: pathFilter ? [pathFilter] : [] }, page: { limit: 20 } });
    setSavedQueries((items) => [...items.filter((item) => item.name !== saved.name), saved]);
    setSavedName("");
  };

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
      <select aria-label="筛选 evidence 状态" value={evidenceFilter} onChange={(event) => setEvidenceFilter(event.target.value)} className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300"><option value="all">evidence</option><option value="verified">verified</option><option value="observed">observed</option><option value="inference">inference</option></select>
      <input aria-label="保存查询名称" value={savedName} onChange={(event) => setSavedName(event.target.value)} placeholder="保存名" className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300" />
      <button type="button" aria-label="保存当前查询" disabled={!savedName.trim() || !query.trim()} onClick={() => void saveCurrentQuery()} className="rounded border border-slate-700 p-1 text-slate-400 disabled:opacity-40"><Bookmark className="h-3.5 w-3.5" /></button>
    </div>
    {busy && <div className="flex items-center gap-2 px-4 py-3 text-xs text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 搜索中…</div>}
    {!busy && response && <div ref={resultViewport} tabIndex={0} onScroll={(event) => setResultScrollTop(event.currentTarget.scrollTop)} onKeyDown={(event) => {
      if (!visibleHits.length) return;
      if (event.key === "ArrowDown") { event.preventDefault(); setSelectedHitIndex((index) => Math.min(index + 1, visibleHits.length - 1)); }
      if (event.key === "ArrowUp") { event.preventDefault(); setSelectedHitIndex((index) => Math.max(index - 1, 0)); }
      if (event.key === "Enter") { event.preventDefault(); activateSelectedHit(); }
    }} className="min-h-0 flex-1 overflow-auto p-4 outline-none" aria-label="知识搜索结果">
      {savedQueries.length > 0 && <div className="mb-3 flex flex-wrap gap-1.5">{savedQueries.map((saved) => <button type="button" key={saved.id} onClick={() => { void knowledgeSavedQueryRun(saved.name).then(setResponse); }} className="rounded border border-slate-800 px-2 py-1 text-[11px] text-slate-400 hover:border-cyan-500/40 hover:text-cyan-200"><Bookmark className="mr-1 inline h-3 w-3" />{saved.name}</button>)}</div>}
      {recentQueries.length > 0 && <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500"><span>最近查询</span>{recentQueries.map((recent) => <button type="button" key={recent} onClick={() => setQuery(recent)} className="rounded border border-slate-800 px-2 py-1 text-slate-400 hover:border-cyan-500/40 hover:text-cyan-200">{recent}</button>)}</div>}
      <div className="mb-3 rounded border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-400">
        已搜索：{response.diagnostics.searchedLanes.join(", ")} · 覆盖 {response.diagnostics.coverage.admitted} admitted / {response.diagnostics.coverage.excluded} excluded / {response.diagnostics.coverage.failed} failed
        {response.diagnostics.resolvedScopes[0] && <span className="ml-2 rounded border border-cyan-500/20 px-1.5 py-0.5 text-cyan-300">revision: {response.diagnostics.resolvedScopes[0].branch} · {response.diagnostics.resolvedScopes[0].snapshotId}</span>}
      </div>
      {visibleHits.length === 0 ? <div className="rounded border border-yellow-500/20 bg-yellow-500/5 p-4 text-sm text-yellow-200">没有结果。{response.diagnostics.warnings.map((warning) => warning.message).join(" ")}</div> : <div className="space-y-2" style={{ contain: "layout paint", minHeight: `${visibleHits.length * 154}px` }}>
        <div aria-hidden="true" style={{ height: `${virtualWindow.top}px` }} />
        {visibleHits.slice(virtualWindow.start, virtualWindow.end).map((hit, offset) => { const index = virtualWindow.start + offset; return <article key={hit.hitId} role="button" tabIndex={0} aria-selected={selectedHitIndex === index} onClick={() => { setSelectedHitIndex(index); void openContext(hit); }} onFocus={() => setSelectedHitIndex(index)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedHitIndex(index); void openContext(hit); } }} className={`cursor-pointer rounded-lg border bg-slate-950/35 p-3 ${selectedHitIndex === index ? "border-cyan-400/80 ring-1 ring-cyan-400/30" : hit.lane === "semantic" ? "border-violet-500/30" : "border-slate-800 hover:border-cyan-500/40"}`}>
          <div className="flex items-center gap-2 text-xs"><span className="font-semibold text-cyan-200">{hit.title}</span><span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-400">{hit.lane}</span><span className="text-slate-600">{hit.evidence[0]?.status}</span></div>
          <div className="mt-1 font-mono text-[11px] text-slate-400">{hit.locator.repoName} / {hit.locator.filePath}{hit.locator.startLine ? `:${hit.locator.startLine}` : ""} · {hit.locator.revisionId}</div>
          {hit.snippet && <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-slate-300">{hit.snippet}</pre>}
          <div className="mt-2 text-[10px] text-slate-600">{hit.rankReasons.join(" · ")}</div>
        </article>; })}
        <div aria-hidden="true" style={{ height: `${virtualWindow.bottom}px` }} />
        </div>}
      {contextBusy && <div className="mt-4 text-xs text-slate-500">加载知识上下文…</div>}
      {hitPreview && <section className="mt-4 rounded-lg border border-slate-700 bg-slate-950/70 p-4">
        <div className="flex items-center gap-2 text-xs text-slate-400"><span className="text-slate-200">完整 excerpt</span><span>{hitPreview.evidence[0]?.status}</span><span className="rounded border border-slate-700 px-1.5 py-0.5">只读 revision: {hitPreview.locator.revisionId}</span></div>
        {hitPreview.snippet && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-slate-300">{hitPreview.snippet}</pre>}
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
      {graphView && <section className="mt-4 rounded-lg border border-violet-500/30 bg-violet-950/10 p-4">
        <div className="text-xs uppercase tracking-wide text-violet-300">局部知识图</div>
        <div className="mt-2 text-xs text-slate-300">{graphView.nodes.length} nodes · {graphView.edges.length} edges</div>
        <div className="mt-2 flex flex-wrap gap-1.5">{graphView.nodes.slice(0, 30).map((node) => <span key={node.nodeId} className="rounded bg-slate-900 px-2 py-1 text-[11px] text-slate-300">{node.title} <span className="text-slate-600">{node.nodeType}</span></span>)}</div>
      </section>}
      {response.page.nextCursor && <button type="button" onClick={() => void loadMore()} className="mt-4 w-full rounded border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-cyan-500/50 hover:text-cyan-200">加载更多结果</button>}
    </div>}
  </div>;
}

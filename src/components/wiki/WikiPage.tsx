import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  ChevronRight,
  ChevronDown,
  Database,
  FolderOpen,
  GitBranch,
  Loader2,
  Network,
  Pin,
  Radio,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import { useDeveloperMode } from "@/hooks/useDeveloperMode";
import { TabBtn } from "@/components/wiki/WikiUIKit";
import { WikiGraph, type GraphLayout } from "@/components/wiki/WikiGraph";
import { WikiGraph3D } from "@/components/wiki/WikiGraph3D";
import { WikiContextPane } from "@/components/wiki/WikiContextPane";
import { EvidenceInbox } from "@/components/wiki/EvidenceInbox";
import {
  filterGraphView,
  formatKnowledgeError,
  isNoDatabaseError,
  knowledgeAgentGuidanceSetup,
  knowledgeAgentHookSetup,
  knowledgeCliSetup,
  knowledgeCliStatus,
  knowledgeReindex,
  knowledgePinBranch,
  knowledgeSetMaster,
  knowledgeRemoveBranch,
  knowledgeRemoveRepo,
  knowledgeWatchToggle,
  knowledgeWatchStatus,
  mcpInstallToLocalClients,
  onIndexProgress,
  knowledgeDbStatus,
  knowledgeGraph,
  knowledgeIndexStatus,
  type KnowledgeIndexStatus,
  knowledgeRepoGraph,
  knowledgeServiceGraph,
  knowledgeContext,
  type KnowledgeDbStatus,
  type KnowledgeGraphView,
  type ContextPack,
  type IndexProgress,
} from "@/lib/knowledge-client";

interface WikiPageProps { onClose: () => void }

type CenterTab = "context" | "graph";
// "home" = the repo/branch datatable (focusId null) — the implicit place
// every FIRST symbol view was reached from (a graph node click, or nothing
// yet). Without recording it, the very first symbol opened in a session had
// nothing behind it in the trail, so "返回" stayed permanently disabled no
// matter how the user got there.
type NavEntry = { kind: "symbol"; id: string } | { kind: "home" };
type GraphScope = { title: string; detail: string };

function IndexProgressBanner() {
  const [progress, setProgress] = useState<IndexProgress | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    void onIndexProgress((payload) => {
      if (!active) return;
      if (payload.phase === "complete") {
        setProgress(null);
      } else {
        setProgress(payload);
      }
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  if (!progress) return null;
  const done = progress.done ?? 0;
  const total = progress.total ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const repo = progress.rootPath?.replace(/\/+$/, "").split("/").pop() ?? "repository";
  const phase = progress.phase === "scan" ? "Scanning" : "Indexing";
  return (
    <div className="mx-6 mt-3 rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate">{phase} {repo}</span>
        <span className="shrink-0 font-mono text-cyan-300">
          {total > 0 ? `${pct}% · ${done}/${total}` : "starting…"}
        </span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-800">
        <div className="h-full rounded-full bg-cyan-400 transition-[width] duration-200" style={{ width: `${pct}%` }} />
      </div>
      {progress.file && <div className="mt-1 truncate font-mono text-[10px] text-cyan-200/60">{progress.file}</div>}
    </div>
  );
}


// Full-screen teaching page shown while the knowledge base is empty (no DB or
// zero repos). Replaces ALL wiki chrome. Primary path is one-click: native
// folder picker → in-app index (knowledge_reindex) with live progress; the
// terminal command stays as the secondary path. Polling flips into the wiki
// automatically once repos > 0.
function WikiOnboarding({ onRefresh, onClose }: { onRefresh: () => void; onClose: () => void }) {
  const [indexing, setIndexing] = useState<{ dir: string; done: number; total: number; file: string } | null>(null);
  const [obError, setObError] = useState<string | null>(null);
  // One-click AI integration: penguin command on PATH + MCP into Claude/Codex +
  // global CLAUDE.md/AGENTS.md guidance. `done` carries the per-item summary.
  const [cliReady, setCliReady] = useState<boolean | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [hookSessionStart, setHookSessionStart] = useState(false);
  const [hookPromptSubmit, setHookPromptSubmit] = useState(false);
  const [hookBusy, setHookBusy] = useState(false);
  const [hookResult, setHookResult] = useState<{ state: "ok" | "warn" | "fail"; text: string } | null>(null);
  // Per-item outcome — machines differ (shell, which AI clients are installed,
  // node present or not), so each step runs independently and reports honestly:
  // ok / skipped / failed, never one blanket success or one blanket error.
  const [aiResults, setAiResults] = useState<Array<{ state: "ok" | "warn" | "fail"; text: string }> | null>(null);

  useEffect(() => {
    knowledgeCliStatus()
      .then((s) => setCliReady(s.installed && s.on_path))
      .catch(() => setCliReady(null));
  }, []);

  const setupAi = useCallback(async () => {
    setAiBusy(true);
    const results: Array<{ state: "ok" | "warn" | "fail"; text: string }> = [];
    try {
      const cli = await knowledgeCliSetup();
      if (cli.manual_hint) {
        results.push({ state: "warn", text: `penguin 命令已安装 — ${cli.manual_hint}` });
      } else {
        const rc = cli.shell === "fish" ? "config.fish" : cli.shell === "bash" ? "~/.bashrc" : "~/.zshrc";
        results.push({
          state: "ok",
          text: `penguin 命令 — ${cli.rc_updated ? `已写入 ${rc},新开一个终端生效` : "已可用"}`,
        });
        setCliReady(true);
      }
    } catch (e) {
      results.push({ state: "fail", text: `penguin 命令:${formatKnowledgeError(e)}` });
    }
    try {
      const msg = await mcpInstallToLocalClients();
      const skipped = msg.match(/Skipped \(not installed\): ([^.]+)\./)?.[1];
      results.push({
        state: "ok",
        text: `MCP 已接入(重启客户端生效)${skipped ? ` — 未安装已跳过:${skipped}` : ""}`,
      });
    } catch (e) {
      results.push({ state: "fail", text: `MCP:${formatKnowledgeError(e)}` });
    }
    try {
      const g = await knowledgeAgentGuidanceSetup();
      if (g.written.length > 0) {
        results.push({
          state: "ok",
          text: `AI 指引已写入 ${g.written.map((p) => p.replace(/^.*\/(\.\w+)/, "$1")).join("、")}${g.skipped.length ? ` — 未安装已跳过:${g.skipped.join("、")}` : ""}`,
        });
      } else if (g.skipped.length > 0) {
        results.push({ state: "warn", text: `AI 指引:未检测到 Claude Code / Codex,已全部跳过` });
      } else {
        results.push({ state: "ok", text: "AI 指引已是最新" });
      }
    } catch (e) {
      results.push({ state: "fail", text: `AI 指引:${formatKnowledgeError(e)}` });
    }
    setAiResults(results);
    setAiBusy(false);
  }, []);

  const applyHooks = useCallback(async () => {
    setHookBusy(true);
    setHookResult(null);
    try {
      const hooks = await knowledgeAgentHookSetup(hookSessionStart, hookPromptSubmit);
      if (!hooks.supported) {
        setHookResult({ state: "warn", text: "Claude Code hooks:未检测到客户端,已跳过" });
      } else if (hooks.enabled.length === 0) {
        setHookResult({
          state: "ok",
          text: hooks.written ? "Penguin hooks 已移除" : "Penguin hooks 已是关闭状态",
        });
      } else {
        setHookResult({
          state: "ok",
          text: `Claude Code hooks ${hooks.written ? "已更新" : "已是最新"}:${hooks.enabled.join("、")}`,
        });
      }
    } catch (e) {
      setHookResult({ state: "fail", text: `Claude Code hooks:${formatKnowledgeError(e)}` });
    } finally {
      setHookBusy(false);
    }
  }, [hookPromptSubmit, hookSessionStart]);

  const pickAndIndex = useCallback(async () => {
    setObError(null);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, multiple: false, title: "选择要索引的代码仓库" });
    if (typeof dir !== "string") return; // cancelled
    setIndexing({ dir, done: 0, total: 0, file: "" });
    const unlisten = await onIndexProgress((p) => {
      if (p.phase !== "scan" && p.phase !== "index") return;
      setIndexing((cur) => (cur ? { ...cur, done: p.done ?? 0, total: p.total ?? 0, file: p.file ?? "" } : cur));
    });
    try {
      await knowledgeReindex(dir);
      onRefresh(); // repos > 0 now — parent flips into the wiki
    } catch (e) {
      setObError(formatKnowledgeError(e));
    } finally {
      unlisten();
      setIndexing(null);
    }
  }, [onRefresh]);

  const step = "flex gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4";
  const num = "flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-xs font-bold text-cyan-300";
  const pct = indexing && indexing.total > 0 ? Math.round((indexing.done / indexing.total) * 100) : 0;
  return (
    <div className="relative flex h-full flex-col items-center justify-center bg-[#070b11] px-8 text-slate-100">
      <button type="button" onClick={onClose} aria-label="关闭"
        className="absolute right-4 top-4 rounded p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-100">
        <X className="h-4 w-4" />
      </button>
      <div className="w-full max-w-xl">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-500/10">
            <Database className="h-5 w-5 text-cyan-300" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">建立你的知识库</h1>
            <p className="mt-0.5 text-sm text-slate-400">Penguin 会把代码仓库解析成可搜索的知识图谱。</p>
          </div>
        </div>

        <div className="mt-8 space-y-3">
          <div className={cn(step, "border-cyan-500/25")}>
            <span className={num}>1</span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">选择第一个仓库</div>
              {indexing ? (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span className="min-w-0 truncate font-mono">{indexing.dir.split("/").pop()}</span>
                    <span className="ml-2 shrink-0 font-bold text-cyan-300">
                      {indexing.total > 0 ? `${pct}% · ${indexing.done}/${indexing.total}` : "扫描中…"}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
                    <div className="h-full rounded-full bg-cyan-400 transition-[width] duration-200" style={{ width: `${pct}%` }} />
                  </div>
                  {indexing.file && <p className="mt-2 truncate font-mono text-[11px] text-slate-600">{indexing.file}</p>}
                </div>
              ) : (
                <>
                  <button type="button" onClick={() => void pickAndIndex()}
                    className="mt-3 flex items-center gap-2 rounded-lg bg-cyan-400 px-4 py-2 text-sm font-bold text-[#04121a] hover:bg-cyan-300">
                    <FolderOpen className="h-4 w-4" /> 选择仓库并索引
                  </button>
                  <p className="mt-2 text-xs leading-relaxed text-slate-500">
                    也可以在终端运行 <code className="rounded bg-slate-950 px-1.5 py-0.5 font-mono text-[11px] text-cyan-200/80">penguin init /path/to/repo</code>,每个仓库一次。
                  </p>
                </>
              )}
              {obError && <p className="mt-2 text-xs leading-relaxed text-amber-300">{obError}</p>}
            </div>
          </div>
          <div className={step}>
            <span className={num}>2</span>
            <div>
              <div className="text-sm font-semibold">等待索引完成</div>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">解析符号、调用关系、API 端点和跨服务连接;大仓库需要几分钟。</p>
            </div>
          </div>
          <div className={step}>
            <span className={num}>3</span>
            <div>
              <div className="text-sm font-semibold">自动进入 Wiki</div>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">索引就绪后本页自动切换:符号搜索、跨服务地图、调用链、事故笔记。</p>
            </div>
          </div>
        </div>

        {/* AI integration: one click sets up the terminal command, the MCP
            server for Claude Desktop/Claude Code/Codex, and the global
            CLAUDE.md / AGENTS.md guidance blocks. */}
        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">AI 集成</div>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                penguin 终端命令 · Claude / Codex 的 MCP 接入 · 全局 CLAUDE.md / AGENTS.md 指引
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
                Claude Code 可选原生 hooks；Codex 使用 canonical MCP + AGENTS.md，不伪装成相同的事件 hook。
              </p>
            </div>
            <button type="button" disabled={aiBusy} onClick={() => void setupAi()}
              className="flex shrink-0 items-center gap-2 rounded-lg border border-cyan-500/40 px-3 py-1.5 text-xs font-bold text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-50">
              {aiBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {aiResults ? "重新配置" : "一键配置 AI 集成"}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-400">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={hookSessionStart}
                onChange={(event) => setHookSessionStart(event.target.checked)}
              />
              SessionStart compact status
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={hookPromptSubmit}
                onChange={(event) => setHookPromptSubmit(event.target.checked)}
              />
              UserPromptSubmit bounded context
            </label>
            <button type="button" disabled={hookBusy} onClick={() => void applyHooks()}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1 text-xs font-semibold text-slate-300 hover:bg-white/5 disabled:opacity-50">
              {hookBusy && <Loader2 className="h-3 w-3 animate-spin" />}
              应用 Hook 设置
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-600">两项均关闭时移除 Penguin hooks；其他工具管理的 hooks 不受影响。</p>
          {hookResult && (
            <p className={cn("mt-2 text-xs", hookResult.state === "ok" ? "text-emerald-300/90" : hookResult.state === "warn" ? "text-amber-300/90" : "text-red-300/90")}>
              {hookResult.state === "ok" ? "✓" : hookResult.state === "warn" ? "⚠" : "✗"} {hookResult.text}
            </p>
          )}
          {cliReady === false && !aiResults && !aiBusy && (
            <p className="mt-2 text-xs text-amber-300/90">检测到终端里还没有 penguin 命令 — 点右侧一键配置。</p>
          )}
          {aiResults && (
            <ul className="mt-3 space-y-1 text-xs">
              {aiResults.map((r, i) => (
                <li key={i} className={r.state === "ok" ? "text-emerald-300/90" : r.state === "warn" ? "text-amber-300/90" : "text-red-300/90"}>
                  {r.state === "ok" ? "✓" : r.state === "warn" ? "⚠" : "✗"} {r.text}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button type="button" onClick={onRefresh}
            className="rounded-lg border border-slate-700 px-4 py-1.5 text-xs font-semibold text-slate-300 hover:bg-white/5">
            立即检测
          </button>
          <span className="text-xs text-slate-600">每 5 秒自动检测一次</span>
        </div>
      </div>
    </div>
  );
}

function KnowledgeHomePanel({
  onOpenRepoGraph,
}: {
  onOpenRepoGraph: (repoId: string, branchId: string) => void;
}) {
  // Nothing selected → a repo datatable IS the home content. Repo row expands
  // to its branches; a branch row opens that branch's graph.
  const [indexRows, setIndexRows] = useState<KnowledgeIndexStatus | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Keep-refreshing (auto poll) is a superadmin-only capability — everyone
  // else can only trigger a single refresh per click. hasValidToken alone
  // (the "admin" tier) does NOT unlock it.
  const { isSuperAdmin } = useDeveloperMode();
  // Persisted (APP_VALUE_KEYS.wikiAutoRefresh), not a plain useState — a
  // webview reload must not silently drop the user's "keep polling" choice
  // back to off (same precedent as the installer's registry auto-refresh).
  const autoRefresh = useAppStore((s) => s.wikiAutoRefresh);
  const setAutoRefresh = useAppStore((s) => s.setWikiAutoRefresh);
  const toggleRepo = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Which repos have a live `penguin watch` child process — the Rust-side
  // WatchRegistry is the source of truth (survives this component
  // unmounting), so re-sync from it on every reload rather than trusting
  // local state alone.
  const [watching, setWatching] = useState<Set<string>>(new Set());
  const syncWatchStatus = useCallback((repos: KnowledgeIndexStatus["repos"]) => {
    if (repos.length === 0) { setWatching(new Set()); return; }
    knowledgeWatchStatus(repos.map((r) => r.repoId))
      .then((rows) => setWatching(new Set(rows.filter((r) => r.watching).map((r) => r.repoId))))
      .catch(() => {});
  }, []);
  const reload = useCallback(() => {
    knowledgeIndexStatus()
      .then((s) => { setIndexRows(s); syncWatchStatus(s.repos); })
      .catch(() => setIndexRows(null));
  }, [syncWatchStatus]);
  useEffect(reload, [reload]);
  const toggleWatch = useCallback(async (repo: KnowledgeIndexStatus["repos"][number]) => {
    const enable = !watching.has(repo.repoId);
    try {
      const result = await knowledgeWatchToggle(repo.repoId, repo.rootPath, enable);
      setWatching((cur) => {
        const next = new Set(cur);
        if (result) next.add(repo.repoId); else next.delete(repo.repoId);
        return next;
      });
    } catch {
      // best-effort — leave the toggle showing its prior state on failure
    }
  }, [watching]);
  // One click for every repo instead of clicking each row — flips ALL repos
  // to the opposite of their current majority state: if every repo is
  // already watching, turn them all off; otherwise turn them all on
  // (including any already on, which is a harmless no-op per repo since
  // knowledge_watch_toggle's enable path is itself idempotent).
  const allWatching = (indexRows?.repos.length ?? 0) > 0
    && indexRows!.repos.every((r) => watching.has(r.repoId));
  const bulkToggleWatch = useCallback(async () => {
    if (!indexRows) return;
    const enable = !indexRows.repos.every((r) => watching.has(r.repoId));
    const results = await Promise.all(
      indexRows.repos.map((r) =>
        knowledgeWatchToggle(r.repoId, r.rootPath, enable)
          .then((result) => ({ repoId: r.repoId, result }))
          .catch(() => ({ repoId: r.repoId, result: false })),
      ),
    );
    setWatching((cur) => {
      const next = new Set(cur);
      for (const { repoId, result } of results) {
        if (result) next.add(repoId); else next.delete(repoId);
      }
      return next;
    });
  }, [indexRows, watching]);
  // Auto-refresh only ever runs for a superadmin who has turned it on; if
  // their tier drops (token cleared) mid-session, the effect cleanup below
  // tears the interval down since isSuperAdmin becomes a dependency.
  useEffect(() => {
    if (!isSuperAdmin || !autoRefresh) return;
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, [isSuperAdmin, autoRefresh, reload]);
  const manualRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await knowledgeIndexStatus().then(setIndexRows);
    } catch {
      setIndexRows(null);
    } finally {
      setRefreshing(false);
    }
  }, []);
  const removeRepo = useCallback(async (name: string) => {
    if (!window.confirm(`从索引中删除 ${name}?\n(只删索引数据,不动仓库文件;重新 index 即可恢复)`)) return;
    try {
      await knowledgeRemoveRepo(name);
    } finally {
      reload();
    }
  }, [reload]);
  const removeBranch = useCallback(async (repoName: string, branch: string) => {
    if (!window.confirm(`从索引中删除分支 ${repoName}/${branch}?\n(只删索引数据;重新 index 即可恢复)`)) return;
    try {
      await knowledgeRemoveBranch(repoName, branch);
    } finally {
      reload();
    }
  }, [reload]);
  const pinBranch = useCallback(async (repoName: string, branch: string) => {
    try {
      await knowledgePinBranch(repoName, branch);
    } finally {
      reload();
    }
  }, [reload]);
  const setMaster = useCallback(async (repoName: string, branch: string) => {
    if (!window.confirm(`将 ${repoName}/${branch} 设为 canonical master?\n只修改索引 metadata，不会 checkout 或重新 index。`)) return;
    try {
      await knowledgeSetMaster(repoName, branch);
    } finally {
      reload();
    }
  }, [reload]);
  const fmtWhen = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-[radial-gradient(circle_at_20%_0%,rgba(34,211,238,0.08),transparent_34%),linear-gradient(180deg,#070c13_0%,#0a0f17_100%)] p-6">
      {indexRows && indexRows.repos.length > 0 && (
        <>
        <section className={cn("flex flex-col overflow-hidden rounded-2xl border border-slate-800 bg-[#0d1420]/85", collapsed ? "shrink-0" : "min-h-0 flex-1")}>
          <div className="flex shrink-0 items-center gap-2 border-b border-slate-800 px-4 py-3">
            <Boxes className="h-4 w-4 text-cyan-300" />
            <span className="text-sm font-semibold text-slate-100">Indexed repositories</span>
            <span className="text-xs text-slate-500">点仓库展开分支,点分支进图谱</span>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                title={allWatching ? "关闭全部仓库的自动同步" : "开启全部仓库的自动同步"}
                onClick={() => void bulkToggleWatch()}
                className={cn(
                  "flex items-center gap-1 rounded px-1.5 py-1 text-[11px]",
                  allWatching ? "text-cyan-300" : "text-slate-500 hover:text-cyan-200",
                )}
              >
                <Radio className={cn("h-3.5 w-3.5", allWatching && "animate-pulse")} />
                全部同步
              </button>
              {isSuperAdmin && (
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-200">
                  <input
                    type="checkbox"
                    checked={autoRefresh}
                    onChange={(e) => setAutoRefresh(e.target.checked)}
                    className="h-3 w-3 accent-cyan-400"
                  />
                  自动刷新
                </label>
              )}
              <button
                type="button"
                title={isSuperAdmin && autoRefresh ? "自动刷新中(点击立即刷新一次)" : "刷新"}
                onClick={() => void manualRefresh()}
                disabled={refreshing}
                className="rounded p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-200 disabled:opacity-50"
              >
                {/* Same convention as PackageInstaller's refresh icon: spinning
                    ambiently means "auto-refresh is active", not just "a fetch
                    is in flight right now" — matches the app's existing pattern
                    for this exact toggle-a-poll-loop UI shape. */}
                <RefreshCw className={cn("h-3.5 w-3.5", (refreshing || (isSuperAdmin && autoRefresh)) && "animate-spin")} />
              </button>
              <button
                type="button"
                title={collapsed ? "展开" : "收起"}
                onClick={() => setCollapsed((c) => !c)}
                className="rounded p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-200"
              >
                {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
          {!collapsed && (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-800/70 text-[10px] uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2 font-semibold">Repo</th>
                  <th className="px-3 py-2 font-semibold">Branches</th>
                  <th className="px-3 py-2 font-semibold">状态</th>
                  <th className="px-3 py-2 font-semibold">Last indexed</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {indexRows.repos.map((repo) => {
                  const open = expanded.has(repo.repoId);
                  const live = repo.branches.filter((b) => b.status === "live").length;
                  const latest = repo.branches.reduce<string | null>(
                    (acc, b) => (b.lastIndexedAt && (!acc || b.lastIndexedAt > acc) ? b.lastIndexedAt : acc),
                    null,
                  );
                  return [
                    <tr
                      key={repo.repoId}
                      onClick={() => toggleRepo(repo.repoId)}
                      className="cursor-pointer border-b border-slate-800/40 hover:bg-white/[0.03]"
                    >
                      <td className="px-4 py-3 font-mono font-semibold text-slate-200">
                        <span className="flex items-center gap-2">
                          {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500" />}
                          {repo.name}
                          {repo.defaultBranch && <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[9px] text-cyan-300">master: {repo.defaultBranch}</span>}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-slate-400">{repo.branches.length}</td>
                      <td className="px-3 py-3">
                        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">{live} live</span>
                      </td>
                      <td className="px-3 py-3 text-slate-500">{fmtWhen(latest)}</td>
                      <td className="px-3 py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            title={watching.has(repo.repoId) ? "自动同步已开启(改动即自动增量索引) — 点击关闭" : "开启自动同步(改动后自动增量索引,不用手动 penguin index)"}
                            onClick={(e) => { e.stopPropagation(); void toggleWatch(repo); }}
                            className={cn(
                              "rounded p-1",
                              watching.has(repo.repoId) ? "text-cyan-300" : "text-slate-600 hover:text-cyan-200",
                            )}
                          >
                            <Radio className={cn("h-3.5 w-3.5", watching.has(repo.repoId) && "animate-pulse")} />
                          </button>
                          <button
                            type="button"
                            title={`删除 ${repo.name} 的索引`}
                            onClick={(e) => { e.stopPropagation(); void removeRepo(repo.name); }}
                            className="rounded p-1 text-slate-600 hover:bg-red-500/10 hover:text-red-300"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>,
                    ...(open
                      ? repo.branches.map((br) => (
                          <tr
                            key={`${repo.repoId}:${br.branchId}`}
                            onClick={() => onOpenRepoGraph(repo.repoId, br.branchId)}
                            className="cursor-pointer border-b border-slate-800/30 bg-slate-950/30 hover:bg-cyan-500/[0.07]"
                          >
                            <td className="py-2.5 pl-12 pr-4 font-mono text-xs text-slate-300">
                              <span className="flex items-center gap-2">
                                <GitBranch className="h-3 w-3 shrink-0 text-slate-600" />
                                {br.name}{br.defaultBranch && <span className="rounded bg-cyan-500/10 px-1 py-0.5 text-[9px] text-cyan-300">master</span>}
                              </span>
                            </td>
                            <td className="px-3 py-2.5" />
                            <td className="px-3 py-2.5">
                              {br.staleSymbols > 0 ? (
                                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">stale {br.staleSymbols}</span>
                              ) : br.status === "live" ? (
                                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">live</span>
                              ) : (
                                <span className="rounded bg-slate-700/40 px-1.5 py-0.5 text-[10px] font-bold text-slate-400">{br.status}</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-xs text-slate-500">
                              <div>{fmtWhen(br.lastIndexedAt)}</div>
                              {br.trust?.snapshotId && <div className="mt-0.5 text-[10px] text-cyan-300/70">snapshot {br.trust.snapshotId.slice(0, 12)} · {br.trust.cacheState ?? "legacy"}</div>}
                              {br.trust?.reusePercent != null && <div className="text-[10px] text-slate-600">base {br.trust.baseCommit?.slice(0, 8) ?? "—"} · head {br.trust.headCommit?.slice(0, 8) ?? "—"} · {Math.round(br.trust.reusePercent)}% reused</div>}
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex items-center justify-end gap-1.5">
                                {!br.defaultBranch && br.name !== "(detached)" && br.name !== "(workdir)" && (
                                  <button
                                    type="button"
                                    title="设为 canonical master"
                                    onClick={(e) => { e.stopPropagation(); void setMaster(repo.name, br.name); }}
                                    className="rounded p-1 text-slate-600 hover:text-cyan-200"
                                  >
                                    master
                                  </button>
                                )}
                                <button
                                  type="button"
                                  title={br.pinned ? "取消固定" : "固定(不被自动清理)"}
                                  onClick={(e) => { e.stopPropagation(); void pinBranch(repo.name, br.name); }}
                                  className={cn("rounded p-1", br.pinned ? "text-cyan-300" : "text-slate-600 hover:text-cyan-200")}
                                >
                                  <Pin className={cn("h-3.5 w-3.5", br.pinned && "fill-current")} />
                                </button>
                                <button
                                  type="button"
                                  title={br.pinned ? "已固定 — 先取消固定" : `删除分支 ${br.name} 的索引`}
                                  disabled={br.pinned}
                                  onClick={(e) => { e.stopPropagation(); void removeBranch(repo.name, br.name); }}
                                  className="rounded p-1 text-slate-600 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-600"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                                <ArrowRight className="h-3.5 w-3.5 text-slate-600" />
                              </div>
                            </td>
                          </tr>
                        ))
                      : []),
                  ];
                })}
              </tbody>
            </table>
          </div>
          )}
        </section>
        <EvidenceInbox />
        </>
      )}
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

// Per-node picking only makes sense while the list is scannable (service map:
// one node per repo). Bigger graphs keep the type checkboxes only.
const NODE_PICK_LIMIT = 40;

function GraphStatsOverlay({
  scope,
  raw,
  shown,
  hidden,
  hiddenIds,
  onToggleType,
  onToggleNode,
}: {
  scope: GraphScope | null;
  // Raw view drives the checklists (a hidden entry must stay listed or it
  // could never be re-checked); shown view drives the counts.
  raw: KnowledgeGraphView;
  shown: KnowledgeGraphView;
  hidden: Set<string>;
  hiddenIds: Set<string>;
  onToggleType: (t: string) => void;
  onToggleNode: (id: string) => void;
}) {
  const nodeTypes = Object.entries(
    raw.nodes.reduce<Record<string, number>>((acc, n) => {
      acc[n.nodeType] = (acc[n.nodeType] ?? 0) + 1;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);
  // Badge SET comes from the raw view (fixed while browsing this graph, so
  // the panel never grows/shrinks rows as types are toggled); the COUNT shown
  // is the filtered one. Same reason the node-type checklist uses raw.
  const shownEdgeCounts = shown.edges.reduce<Record<string, number>>((acc, edge) => {
    acc[edge.edgeType] = (acc[edge.edgeType] ?? 0) + 1;
    return acc;
  }, {});
  const edgeTypes = Object.entries(
    raw.edges.reduce<Record<string, number>>((acc, edge) => {
      acc[edge.edgeType] = (acc[edge.edgeType] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .sort((a, b) => b[1] - a[1])
    .map(([type]) => [type, shownEdgeCounts[type] ?? 0] as const);

  const [collapsed, setCollapsed] = useState(false);
  if (collapsed) {
    // Collapsed pill — stays visible (not fully hidden) so the panel is easy
    // to find again, but gives the graph almost all the space back.
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        title="展开图谱统计面板"
        className="absolute right-3 top-3 flex items-center gap-2 rounded-xl border border-slate-800 bg-[#0d1420]/90 px-3 py-2 text-xs shadow-[0_18px_50px_rgba(0,0,0,0.28)] backdrop-blur hover:border-cyan-500/40"
      >
        <Network className="h-3.5 w-3.5 text-cyan-300" />
        <span className="max-w-[140px] truncate font-semibold text-slate-100">{scope?.title ?? "Graph view"}</span>
        <ChevronRight className="h-3.5 w-3.5 text-slate-500" />
      </button>
    );
  }
  return (
    // Fixed width + tabular digits: toggling types must not resize the panel.
    <div className="absolute right-3 top-3 w-[320px] rounded-xl border border-slate-800 bg-[#0d1420]/90 p-3 text-xs tabular-nums shadow-[0_18px_50px_rgba(0,0,0,0.28)] backdrop-blur">
      <div className="mb-2 flex items-center gap-2">
        <Network className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-slate-100">{scope?.title ?? "Graph view"}</div>
          <div className="truncate text-[11px] text-slate-500">{scope?.detail ?? "Current graph data"}</div>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title="收起面板"
          className="shrink-0 rounded p-1 text-slate-500 hover:bg-white/5 hover:text-slate-200"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-slate-800 bg-slate-950/45 px-2 py-1.5">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-600">Nodes</div>
          <div className="font-mono text-base font-semibold text-slate-100">{shown.nodes.length}</div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-950/45 px-2 py-1.5">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-600">Links</div>
          <div className="font-mono text-base font-semibold text-cyan-100">{shown.edges.length}</div>
        </div>
      </div>
      {raw.nodes.length > 0 && raw.nodes.length <= NODE_PICK_LIMIT && (
        <div className="mt-2">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-slate-600">
            {scope?.title === "Service map" ? "Repos" : "Nodes"}
          </div>
          <div className="max-h-44 overflow-auto pr-1">
            {[...raw.nodes].sort((a, b) => a.title.localeCompare(b.title)).map((n) => (
              <label key={n.nodeId} className="flex cursor-pointer items-center gap-1.5 py-0.5 font-mono text-[11px] text-slate-300 hover:text-cyan-200">
                <input
                  type="checkbox"
                  checked={!hiddenIds.has(n.nodeId)}
                  onChange={() => onToggleNode(n.nodeId)}
                  className="h-3 w-3 shrink-0 accent-cyan-400"
                />
                <span className="min-w-0 truncate">{n.title}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {nodeTypes.length > 1 && (
        <div className="mt-2">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-slate-600">Node types</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {nodeTypes.map(([type, count]) => (
              <label key={type} className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-slate-300 hover:text-cyan-200">
                <input
                  type="checkbox"
                  checked={!hidden.has(type)}
                  onChange={() => onToggleType(type)}
                  className="h-3 w-3 accent-cyan-400"
                />
                {type} <span className="text-slate-600">{count}</span>
              </label>
            ))}
          </div>
        </div>
      )}
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


  const [focusId, setFocusId] = useState<string | null>(null);
  const [tab, setTab] = useState<CenterTab>("context");

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

  const loadPack = useCallback(async (id: string) => {
    setPackBusy(true);
    try {
      setPack(await knowledgeContext(id));
    } catch (e) { err(e); } finally { setPackBusy(false); }
  }, []);
  const loadGraph = useCallback(async (id: string) => {
    setGraphBusy(true); setHiddenNodeIds(new Set());
    setGraphScope({ title: "Local graph", detail: "Focused symbol neighbourhood" });
    try { setGraphData(await knowledgeGraph(id, 1)); } catch (e) { err(e); } finally { setGraphBusy(false); }
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
    setError(null); setFocusId(null); setTab("graph"); setGraphBusy(true); setHiddenNodeIds(new Set());
    setGraphScope({ title: "Repo graph", detail: "Top connected symbols in this branch" });
    try { setGraphData(await knowledgeRepoGraph(repoId, branchId)); } catch (e) { err(e); } finally { setGraphBusy(false); }
  }, []);

  const openServiceGraph = useCallback(async () => {
    setError(null); setFocusId(null); setTab("graph"); setGraphBusy(true); setHiddenNodeIds(new Set());
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
            <TabBtn on={tab === "context"} onClick={() => setTab("context")} icon={<Sparkles className="h-3.5 w-3.5" />}>Context</TabBtn>
            <TabBtn on={tab === "graph"} onClick={() => setTab("graph")} icon={<Network className="h-3.5 w-3.5" />}>Graph</TabBtn>
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

          {tab === "context" ? (
            f ? <WikiContextPane packBusy={packBusy} pack={pack} onSelectSymbol={selectSymbol} /> : (
              <KnowledgeHomePanel
                onOpenRepoGraph={(r, b) => void openRepoGraph(r, b)}
              />
            )
          ) : (
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
          )}
        </section>

      </div>

      <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-slate-800 bg-[#101826] px-3 text-[11px] text-slate-400">
        <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Connected</span>
        <span className="text-slate-600">SQLite</span>
        <span className="ml-auto text-slate-600">Workspace <b className="text-slate-300">Penguin</b></span>
      </footer>
    </div>
  );
}

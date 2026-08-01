import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Boxes,
  ChevronRight,
  ChevronDown,
  GitBranch,
  Loader2,
  Pin,
  Radio,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import { useDeveloperMode } from "@/hooks/useDeveloperMode";
import {
  knowledgePinBranch,
  knowledgeSetMaster,
  knowledgeRemoveBranch,
  knowledgeRemoveRepo,
  knowledgeWatchToggle,
  knowledgeWatchStatus,
  knowledgeIndexStatus,
  type KnowledgeIndexStatus,
} from "@/lib/knowledge-client";

export function KnowledgeHomePanel({
  onOpenRepoGraph,
}: {
  onOpenRepoGraph: (repoId: string, branchId: string) => void;
}) {
  // Nothing selected → a repo datatable IS the home content. Repo row expands
  // to its branches; a branch row opens that branch's graph.
  const [indexRows, setIndexRows] = useState<KnowledgeIndexStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
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
    setStatusLoading(true);
    knowledgeIndexStatus()
      .then((s) => { setIndexRows(s); syncWatchStatus(s.repos); })
      .catch(() => setIndexRows(null))
      .finally(() => setStatusLoading(false));
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
      await knowledgeIndexStatus().then((s) => { setIndexRows(s); syncWatchStatus(s.repos); });
    } catch {
      setIndexRows(null);
    } finally {
      setRefreshing(false);
    }
  }, [syncWatchStatus]);
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
      {statusLoading && !indexRows && (
        <section className="flex min-h-[220px] flex-1 items-center justify-center rounded-2xl border border-slate-800 bg-[#0d1420]/85">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin text-cyan-300" />
            Loading Knowledge status…
          </div>
        </section>
      )}
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
        </>
      )}
    </div>
  );
}

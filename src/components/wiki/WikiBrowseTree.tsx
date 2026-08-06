import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, ChevronDown, ChevronRight, FileCode, GitBranch, Loader2, Network, Search, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatKnowledgeError,
  isNoDatabaseError,
  knowledgeIndexStatus,
  knowledgeRemoveRepo,
  knowledgeFiles,
  type KnowledgeIndexStatus,
  type KnowledgeFileRow,
} from "@/lib/knowledge-client";

// Fresh install / index intentionally deleted: knowledge.db doesn't exist yet.
// This is onboarding, not a failure — teach the first command instead of alarming.
function ExplorerEmpty({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="m-2 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.05] p-3">
      <div className="text-sm font-semibold text-cyan-100">还没有索引任何仓库</div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        在终端对每个想加入知识库的仓库运行一次:
      </p>
      <code className="mt-2 block truncate rounded-md border border-cyan-500/15 bg-background/60 px-2 py-1.5 text-[11px] text-cyan-200">
        penguin init /path/to/repo
      </code>
      <div className="mt-3">
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-md bg-cyan-200 px-2.5 py-1 text-xs font-bold text-slate-950 hover:bg-cyan-100"
        >
          刷新
        </button>
      </div>
    </div>
  );
}

function ExplorerError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="m-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3">
      <div className="text-sm font-semibold text-amber-200">Explorer unavailable</div>
      <p className="mt-1 text-xs leading-relaxed text-amber-100/80">{message}</p>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md bg-amber-200 px-2.5 py-1 text-xs font-bold text-slate-950 hover:bg-amber-100"
        >
          Retry
        </button>
        {message.includes("pnpm rebuild") && (
          <code className="min-w-0 flex-1 truncate rounded-md border border-amber-500/20 bg-background/50 px-2 py-1.5 text-[11px] text-amber-100">
            pnpm rebuild better-sqlite3
          </code>
        )}
      </div>
    </div>
  );
}

export function WikiBrowseTree({
  onSelectFile,
  onOpenRepoGraph,
  selected,
}: {
  onSelectFile: (branchId: string, filePath: string) => void;
  onOpenRepoGraph: (repoId: string, branchId: string) => void;
  selected?: { branchId: string; filePath: string } | null;
}) {
  const [status, setStatus] = useState<KnowledgeIndexStatus | null>(null);
  const [openRepos, setOpenRepos] = useState<Set<string>>(new Set());
  const [openBranches, setOpenBranches] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<Record<string, KnowledgeFileRow[]>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Record<string, string>>({});
  const [repoFilter, setRepoFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(() => {
    setError(null);
    knowledgeIndexStatus()
      .then(setStatus)
      .catch((e) => setError(formatKnowledgeError(e)));
  }, []);
  const removeRepo = useCallback(async (name: string) => {
    if (!window.confirm(`从索引中删除 ${name}?\n(只删索引数据,不动仓库文件;重新 index 即可恢复)`)) return;
    try {
      await knowledgeRemoveRepo(name);
    } finally {
      loadStatus();
    }
  }, [loadStatus]);
  useEffect(loadStatus, [loadStatus]);

  const toggle = (setter: typeof setOpenRepos, id: string) =>
    setter((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const openBranch = useCallback(
    async (repoId: string, branchId: string) => {
      toggle(setOpenBranches, branchId);
      if (files[branchId] || loading.has(branchId)) return;
      setLoading((s) => new Set(s).add(branchId));
      try {
        const rows = await knowledgeFiles(repoId, branchId);
        setFiles((f) => ({ ...f, [branchId]: rows }));
      } catch (e) {
        setError(formatKnowledgeError(e));
      } finally {
        setLoading((s) => {
          const n = new Set(s);
          n.delete(branchId);
          return n;
        });
      }
    },
    [files, loading],
  );

  const visibleRepos = useMemo(() => {
    if (!status) return [];
    const q = repoFilter.trim().toLowerCase();
    if (!q) return status.repos;
    return status.repos.filter((repo) =>
      repo.name.toLowerCase().includes(q) ||
      repo.rootPath.toLowerCase().includes(q) ||
      repo.branches.some((br) => br.name.toLowerCase().includes(q)),
    );
  }, [repoFilter, status]);

  if (error) {
    return isNoDatabaseError(error)
      ? <ExplorerEmpty onRefresh={loadStatus} />
      : <ExplorerError message={error} onRetry={loadStatus} />;
  }
  if (!status) {
    return (
      <p className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> 加载索引…
      </p>
    );
  }
  if (status.repos.length === 0) {
    return <p className="px-3 py-6 text-sm text-muted-foreground">还没有索引任何 repo。运行 penguin init 后这里会显示工程地图。</p>;
  }

  return (
    <div className="space-y-2 text-sm">
      <div className="sticky top-0 z-10 border-b border-border bg-card pb-2">
        <div className="flex items-center rounded-lg border border-border bg-background/45 px-2 focus-within:border-cyan-500/40">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={repoFilter}
            onChange={(e) => setRepoFilter(e.target.value)}
            placeholder="Filter repos, branches, files"
            className="h-8 min-w-0 flex-1 bg-transparent px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
          <span>{visibleRepos.length} repos</span>
          <span>{status.repos.reduce((n, repo) => n + repo.branches.length, 0)} branches</span>
        </div>
      </div>

      {visibleRepos.map((repo) => {
        const open = openRepos.has(repo.repoId);
        return (
          <div key={repo.repoId} className="rounded-lg border border-border/70 bg-background/20">
            {/* div, not button: the delete control nests inside the click row */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => toggle(setOpenRepos, repo.repoId)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggle(setOpenRepos, repo.repoId); }}
              className="group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-accent"
            >
              {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
              <Boxes className="h-4 w-4 shrink-0 text-cyan-300" />
              <span className="min-w-0 flex-1 truncate font-semibold text-foreground">{repo.name}</span>
              <button
                type="button"
                title={`删除 ${repo.name} 的索引`}
                onClick={(e) => { e.stopPropagation(); void removeRepo(repo.name); }}
                className="rounded p-1 text-muted-foreground opacity-0 hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <span className="rounded bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{repo.branches.length} br</span>
            </div>

            {open &&
              repo.branches.map((br) => {
                const branchFiles = files[br.branchId];
                const fileFilter = filter[br.branchId] ?? "";
                const shown = branchFiles?.filter((f) => !fileFilter || f.filePath.toLowerCase().includes(fileFilter.toLowerCase())) ?? [];
                return (
                  <div key={br.branchId} className="border-t border-border/70">
                    <div className="flex items-center gap-1 px-2 py-1">
                      <button
                        type="button"
                        onClick={() => void openBranch(repo.repoId, br.branchId)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-accent"
                      >
                        {openBranches.has(br.branchId) ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                        <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">{br.name}</span>
                        <span className={cn("h-1.5 w-1.5 rounded-full", br.status === "live" || br.status === "fresh" ? "bg-emerald-400" : "bg-muted-foreground")} />
                        {loading.has(br.branchId) && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-cyan-300" />}
                      </button>
                      <button
                        type="button"
                        title="打开该分支的图谱"
                        onClick={() => onOpenRepoGraph(repo.repoId, br.branchId)}
                        className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-cyan-300"
                      >
                        <Network className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {br.staleSymbols > 0 && (
                      <div className="px-9 pb-1 font-mono text-[10px] text-amber-300/80">{br.staleSymbols} stale symbols</div>
                    )}

                    {openBranches.has(br.branchId) && branchFiles && (
                      <div className="px-2 pb-2 pl-7">
                        {branchFiles.length > 20 && (
                          <input
                            value={fileFilter}
                            onChange={(e) => setFilter((f) => ({ ...f, [br.branchId]: e.target.value }))}
                            placeholder={`Filter ${branchFiles.length} files`}
                            className="mb-1 h-7 w-full rounded-md border border-border bg-background/45 px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-cyan-400/50"
                          />
                        )}
                        <div className="space-y-0.5">
                          {shown.slice(0, 500).map((f) => {
                            const isSel = selected?.branchId === br.branchId && selected?.filePath === f.filePath;
                            const dim = f.status !== "indexed";
                            return (
                              <button
                                key={f.filePath}
                                type="button"
                                disabled={f.status === "skipped"}
                                onClick={() => onSelectFile(br.branchId, f.filePath)}
                                title={f.error ?? f.status}
                                className={cn(
                                  "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-accent",
                                  isSel && "bg-cyan-500/12 text-cyan-100",
                                  dim && "opacity-50",
                                )}
                              >
                                <FileCode className={cn("h-3.5 w-3.5 shrink-0", f.status === "error" ? "text-yellow-400" : "text-muted-foreground")} />
                                <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.filePath}</span>
                                {f.lang && <span className="shrink-0 rounded bg-card px-1 py-0.5 text-[9px] text-muted-foreground">{f.lang}</span>}
                              </button>
                            );
                          })}
                        </div>
                        {shown.length > 500 && <p className="px-2 py-1 text-[11px] text-muted-foreground">还有 {shown.length - 500} 个，输入过滤词缩小范围</p>}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

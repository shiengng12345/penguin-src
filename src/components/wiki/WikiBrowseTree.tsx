import { useCallback, useEffect, useState } from "react";
import { ChevronRight, ChevronDown, Boxes, GitBranch, FileCode, Network, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  knowledgeIndexStatus,
  knowledgeFiles,
  type KnowledgeIndexStatus,
  type KnowledgeFileRow,
} from "@/lib/knowledge-client";

// The "what did I index" navigation tree: repo → branch → file. Levels load
// lazily (a repo can hold thousands of files) so opening the Wiki is instant.
// Clicking a file hands (branchId, filePath) up; the branch's ⌗ button opens
// its repo-scoped graph.
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    knowledgeIndexStatus()
      .then(setStatus)
      .catch((e) => setError(String((e as Error).message ?? e)));
  }, []);

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
        setError(String((e as Error).message ?? e));
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

  if (error) {
    return <p className="px-3 py-6 text-sm text-yellow-200">{error}</p>;
  }
  if (!status) {
    return (
      <p className="flex items-center gap-2 px-3 py-6 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> 加载索引…
      </p>
    );
  }
  if (status.repos.length === 0) {
    return <p className="px-3 py-6 text-sm text-slate-500">还没有索引任何 repo — 运行 penguin init 或点「重建索引」</p>;
  }

  return (
    <div className="py-1 text-sm">
      {status.repos.map((repo) => (
        <div key={repo.repoId}>
          <button
            type="button"
            onClick={() => toggle(setOpenRepos, repo.repoId)}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left hover:bg-white/5"
          >
            {openRepos.has(repo.repoId) ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500" />}
            <Boxes className="h-4 w-4 shrink-0 text-cyan-300" />
            <span className="min-w-0 flex-1 truncate font-medium">{repo.name}</span>
            <span className="text-[11px] text-slate-500">{repo.branches.length} br</span>
          </button>

          {openRepos.has(repo.repoId) &&
            repo.branches.map((br) => (
              <div key={br.branchId}>
                <div className="flex items-center gap-1 pl-5">
                  <button
                    type="button"
                    onClick={() => void openBranch(repo.repoId, br.branchId)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-white/5"
                  >
                    {openBranches.has(br.branchId) ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500" />}
                    <GitBranch className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{br.name}</span>
                    {loading.has(br.branchId) && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-cyan-300" />}
                  </button>
                  <button
                    type="button"
                    title="打开该分支的图谱"
                    onClick={() => onOpenRepoGraph(repo.repoId, br.branchId)}
                    className="mr-1 rounded p-1 text-slate-500 hover:bg-white/5 hover:text-cyan-300"
                  >
                    <Network className="h-3.5 w-3.5" />
                  </button>
                </div>

                {openBranches.has(br.branchId) && files[br.branchId] && (
                  <div className="pl-6">
                    {files[br.branchId].length > 40 && (
                      <input
                        value={filter[br.branchId] ?? ""}
                        onChange={(e) => setFilter((f) => ({ ...f, [br.branchId]: e.target.value }))}
                        placeholder={`过滤 ${files[br.branchId].length} 个文件…`}
                        className="my-1 ml-1 h-7 w-[calc(100%-0.5rem)] rounded border border-slate-800 bg-slate-950/40 px-2 text-xs outline-none focus:border-cyan-400/50"
                      />
                    )}
                    {files[br.branchId]
                      .filter((f) => !filter[br.branchId] || f.filePath.toLowerCase().includes(filter[br.branchId].toLowerCase()))
                      .slice(0, 500)
                      .map((f) => {
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
                              "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-white/5",
                              isSel && "bg-cyan-500/10",
                              dim && "opacity-50",
                            )}
                          >
                            <FileCode className={cn("h-3.5 w-3.5 shrink-0", f.status === "error" ? "text-yellow-400" : "text-slate-500")} />
                            <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.filePath}</span>
                            {f.lang && <span className="shrink-0 text-[10px] text-slate-600">{f.lang}</span>}
                          </button>
                        );
                      })}
                    {(() => {
                      const shown = files[br.branchId].filter((f) => !filter[br.branchId] || f.filePath.toLowerCase().includes(filter[br.branchId].toLowerCase()));
                      return shown.length > 500 ? <p className="px-2 py-1 text-[11px] text-slate-600">… 还有 {shown.length - 500} 个,输入过滤词缩小范围</p> : null;
                    })()}
                  </div>
                )}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

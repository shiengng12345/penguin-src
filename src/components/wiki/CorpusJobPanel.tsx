import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderOpen, Loader2, Pause, Play, RefreshCw, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { getPersistedValue, setPersistedValue } from "@/lib/app-persistence";
import { APP_VALUE_KEYS } from "@/lib/persistence-keys";
import {
  formatKnowledgeError,
  knowledgeCorpusControl,
  knowledgeCorpusStart,
  knowledgeCorpusStatus,
  onCorpusProgress,
  onCorpusStatusChanged,
  type KnowledgeCorpusControlAction,
  type KnowledgeCorpusJob,
} from "@/lib/knowledge-client";

const STATUS_STORAGE_KEY = APP_VALUE_KEYS.fullCorpusStatusPath;

function phaseLabel(phase: KnowledgeCorpusJob["phase"]): string {
  return phase === "index" ? "代码索引" : phase === "rebuild" ? "完整重建" : phase === "semantic" ? "语义队列" : "校验收尾";
}

function stateLabel(state: KnowledgeCorpusJob["state"]): string {
  return state === "running" ? "运行中" : state === "paused" ? "已暂停" : state === "completed" ? "已完成" : state === "cancelled" ? "已取消" : "失败";
}

function progressPercent(job: KnowledgeCorpusJob): number {
  if (job.state === "completed") return 100;
  const fraction = job.totalRepos > 0 ? Math.min(1, job.completedRepos / job.totalRepos) : 0;
  if (job.mode !== "both") return Math.round(fraction * 100);
  if (job.phase === "rebuild") return Math.round(50 + fraction * 50);
  if (job.phase === "semantic" || job.phase === "verify") return 100;
  return Math.round(fraction * 50);
}

export function CorpusJobPanel() {
  const [statusPath, setStatusPath] = useState(() => getPersistedValue(STATUS_STORAGE_KEY) ?? "");
  const [job, setJob] = useState<KnowledgeCorpusJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (path = statusPath) => {
    if (!path) return;
    try {
      const next = await knowledgeCorpusStatus(path);
      setJob(next);
      setError(null);
    } catch (cause) {
      // A freshly spawned child may not have published its first atomic status
      // file yet. Keep that short race quiet; later failures remain visible.
      if (job != null) setError(formatKnowledgeError(cause));
    }
  }, [job, statusPath]);

  useEffect(() => {
    if (!statusPath) return;
    void refresh(statusPath);
    const interval = window.setInterval(
      () => void refresh(statusPath),
      job?.state === "running" || job?.state === "paused" ? 1000 : 10_000,
    );
    return () => window.clearInterval(interval);
  }, [job?.state, refresh, statusPath]);

  useEffect(() => {
    let mounted = true;
    let stopProgress: (() => void) | undefined;
    let stopStatus: (() => void) | undefined;
    void onCorpusProgress((payload) => {
      if (!mounted || (payload.rootPath && job && payload.rootPath !== job.rootPath)) return;
      if (payload.job) setJob(payload.job);
    }).then((stop) => {
      if (mounted) stopProgress = stop;
      else stop();
    });
    void onCorpusStatusChanged((payload) => {
      if (!mounted) return;
      const path = (payload as { statusPath?: unknown })?.statusPath;
      if (typeof path !== "string" || !statusPath || path === statusPath) void refresh(statusPath);
    }).then((stop) => {
      if (mounted) stopStatus = stop;
      else stop();
    });
    return () => { mounted = false; stopProgress?.(); stopStatus?.(); };
  }, [job, refresh, statusPath]);

  const start = useCallback(async () => {
    setError(null);
    setNotice(null);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false, title: "选择要完整索引的代码目录" });
    if (typeof selected !== "string") return;
    setBusy(true);
    try {
      const launch = await knowledgeCorpusStart(selected, "both");
      setPersistedValue(STATUS_STORAGE_KEY, launch.statusPath);
      setStatusPath(launch.statusPath);
      setJob(null);
      setNotice(`已启动 ${selected.split("/").pop() ?? selected}；可以关闭 Penguin，任务会继续运行`);
    } catch (cause) {
      setError(formatKnowledgeError(cause));
    } finally { setBusy(false); }
  }, []);

  const control = useCallback(async (action: KnowledgeCorpusControlAction) => {
    if (!statusPath) return;
    if (action === "cancel" && !window.confirm("确定取消整个全量索引任务吗？已完成的 repo 收据会保留。")) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await knowledgeCorpusControl(action, statusPath);
      setNotice(action === "pause" ? "已请求暂停，将在当前 repo 安全边界停下" : action === "resume" ? "已请求继续" : action === "cancel" ? "已请求取消" : "已请求重试失败分片");
      await refresh(statusPath);
    } catch (cause) {
      setError(formatKnowledgeError(cause));
    } finally { setBusy(false); }
  }, [refresh, statusPath]);

  const pct = useMemo(() => job ? progressPercent(job) : 0, [job]);
  const active = job?.state === "running" || job?.state === "paused";

  return (
    <section aria-label="Full corpus indexing status" className="mx-4 mt-3 rounded-lg border border-cyan-500/25 bg-cyan-500/5 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <RefreshCw className={cn("h-3.5 w-3.5 text-cyan-300", active && "animate-spin")} />
            全量索引 / 重建
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground">按 repo 分片 · 可关闭窗口 · 状态持久保存</p>
        </div>
        {!active && <button type="button" onClick={() => void start()} disabled={busy} className="flex items-center gap-1 rounded border border-cyan-500/30 px-2 py-1 text-[10px] text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-40"><FolderOpen className="h-3 w-3" />开始全量索引</button>}
      </div>

      {job && (
        <div className="mt-2 rounded-md border border-border/60 bg-background/40 p-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <span className="min-w-0 truncate text-foreground" title={job.rootPath}>{job.rootPath}</span>
            <span className={cn(job.state === "failed" ? "text-red-300" : job.state === "completed" ? "text-emerald-300" : "text-cyan-300")}>{stateLabel(job.state)} · {phaseLabel(job.phase)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span>{job.completedRepos}/{job.totalRepos} repos · {job.parsed.toLocaleString()} parsed · {job.errors} errors</span>
            <span className="font-mono text-cyan-200">{pct}%</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"><div className={cn("h-full transition-[width] duration-300", job.state === "failed" ? "bg-red-400" : job.state === "completed" ? "bg-emerald-400" : "bg-cyan-400")} style={{ width: `${pct}%` }} /></div>
          {job.lastFile && <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{job.lastFile}</div>}
          {job.lastError && <div className="mt-1 text-[10px] text-amber-300">{job.lastError}</div>}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {job.state === "running" && <button type="button" disabled={busy} onClick={() => void control("pause")} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] hover:bg-accent disabled:opacity-40"><Pause className="h-3 w-3" />暂停</button>}
            {job.state === "paused" && <button type="button" disabled={busy} onClick={() => void control("resume")} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] hover:bg-accent disabled:opacity-40"><Play className="h-3 w-3" />继续</button>}
            {active && <button type="button" disabled={busy} onClick={() => void control("cancel")} className="flex items-center gap-1 rounded border border-red-500/30 px-2 py-1 text-[10px] text-red-300 hover:bg-red-500/10 disabled:opacity-40"><XCircle className="h-3 w-3" />取消</button>}
            {busy && <Loader2 className="ml-1 h-3 w-3 animate-spin text-muted-foreground" />}
          </div>
        </div>
      )}
      {notice && <p className="mt-1.5 text-[10px] text-emerald-300">{notice}</p>}
      {error && <p className="mt-1.5 text-[10px] text-red-300">{error}</p>}
    </section>
  );
}

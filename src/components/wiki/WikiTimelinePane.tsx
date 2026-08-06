import { Loader2, GitMerge } from "lucide-react";
import { Center } from "@/components/wiki/WikiUIKit";
import type { KnowledgeTimelineEntry } from "@/lib/knowledge-client";

export function WikiTimelinePane({
  timelineBusy,
  timelineData,
}: {
  timelineBusy: boolean;
  timelineData: KnowledgeTimelineEntry[] | null;
}) {
  if (timelineBusy) return <Center><Loader2 className="h-4 w-4 animate-spin" /> 加载时间线…</Center>;
  if (!timelineData || timelineData.length === 0) return <Center>暂无提交记录 — 索引一个 git 仓库后可见</Center>;

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mb-4 text-xs text-muted-foreground">最近变更 — 跨仓库提交(按作者日期)</div>
      <div className="space-y-0.5">
        {timelineData.map((e, i) => (
          <div key={i} className="flex items-baseline gap-3 rounded px-2 py-1.5 hover:bg-accent">
            <span className="w-20 shrink-0 font-mono text-[10px] text-muted-foreground">{(e.date ?? "").slice(0, 10)}</span>
            {e.merge && <GitMerge className="h-3 w-3 shrink-0 text-violet-300" />}
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">{e.subject}</span>
            {e.repo && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{e.repo}</span>}
            {e.tags.map((t) => <span key={t} className="shrink-0 rounded bg-cyan-500/15 px-1.5 py-0.5 text-[9px] text-cyan-200">{t}</span>)}
          </div>
        ))}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  knowledgeMaintenance,
  knowledgeStorageReport,
  type StorageReport,
  type StorageTableCategory,
} from "@/lib/knowledge-client";

const POLL_INTERVAL_MS = 30_000;

const CATEGORY_LABEL: Record<StorageTableCategory, string> = {
  graph_edges: "关系图边",
  source_content: "文件内容（去重后）",
  fts: "全文搜索索引",
  vectors: "语义向量",
  symbols: "符号与快照",
  other: "其他",
};

const HEALTH_LABEL = { ok: "健康", warn: "注意", critical: "异常" } as const;
const HEALTH_DOT = { ok: "bg-emerald-400", warn: "bg-amber-400", critical: "bg-red-400" } as const;
const HEALTH_TEXT = { ok: "text-emerald-300", warn: "text-amber-300", critical: "text-red-300" } as const;

const REASON_LABEL: Record<string, string> = {
  wal_ratio: "WAL 日志相对主库偏大",
  growth_rate: "本周增长过快",
  reclaimable: "有可回收空间,点「压实数据库」拿回",
};

const MAINTENANCE_ERROR_LABEL: Record<string, string> = {
  INDEX_IN_PROGRESS: "索引进行中，请稍后再试",
  MAINTENANCE_IN_PROGRESS: "已有维护任务在运行",
  ACTIVE_READERS: "有活动读者占用数据库，请稍后再试",
};

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatDelta(bytes: number | null): string | null {
  if (bytes == null) return null;
  const sign = bytes >= 0 ? "+" : "−";
  return `${sign}${formatBytes(Math.abs(bytes))} 本周`;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "从未";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "刚刚";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-lg border border-border bg-card p-4", className)}>
      <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

export function WikiStoragePage() {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"collect" | "vacuum" | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const generationRef = useRef(0);

  const refresh = useCallback(() => {
    const generation = ++generationRef.current;
    knowledgeStorageReport()
      .then((next) => {
        if (generation !== generationRef.current) return;
        setReport(next);
        setError(null);
      })
      .catch((fetchError) => {
        if (generation !== generationRef.current) return;
        setError(String((fetchError as Error).message ?? fetchError));
      });
  }, []);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const runAction = useCallback(
    (action: "collect" | "vacuum") => {
      setBusyAction(action);
      setActionNotice(null);
      knowledgeMaintenance(action)
        .then((result) => {
          if (action === "collect" && result.collected) {
            setActionNotice(`回收完成：清掉 ${result.collected.snapshots} 个快照、${result.collected.resolutionSets} 个解析集、${result.collected.sourceBlobs} 个内容块`);
          } else if (action === "vacuum") {
            setActionNotice(`压实完成：释放了 ${formatBytes(result.reclaimedBytes ?? 0)}`);
          }
        })
        .catch((actionError) => {
          const message = String((actionError as Error).message ?? actionError);
          const known = Object.keys(MAINTENANCE_ERROR_LABEL).find((code) => message.includes(code));
          setActionNotice(known ? MAINTENANCE_ERROR_LABEL[known] : `操作失败：${message}`);
        })
        .finally(() => {
          setBusyAction(null);
          refresh();
        });
    },
    [refresh],
  );

  if (!report && !error) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> 读取存储信息…
      </div>
    );
  }

  if (!report) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
        存储信息不可用：{error}
      </div>
    );
  }

  const { files, health, growth, tables, gc, maintenance, repos } = report;
  const deltaText = formatDelta(growth.weeklyDeltaBytes);
  const totalTableBytes = tables ? tables.categories.reduce((sum, category) => sum + category.bytes, 0) : 0;
  const running = busyAction != null || maintenance.running;
  const maxSnapshots = repos.reduce((max, repo) => Math.max(max, repo.snapshots), 0);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="text-4xl font-semibold tabular-nums text-foreground">{formatBytes(files.totalBytes)}</div>
            <div className="mt-1 text-xs text-muted-foreground">~/.penguin/knowledge</div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className={cn("flex items-center gap-1.5 text-sm", HEALTH_TEXT[health.level])}>
              <span className={cn("h-2 w-2 rounded-full", HEALTH_DOT[health.level])} />
              {HEALTH_LABEL[health.level]}
            </span>
            {health.reasons.map((reason) => (
              <span key={reason} className="text-xs text-muted-foreground">{REASON_LABEL[reason] ?? reason}</span>
            ))}
            {deltaText && <span className="text-xs text-muted-foreground">{deltaText}</span>}
          </div>
        </div>

        <Card title="组成">
          <div className="flex flex-col gap-2 text-sm">
            {[
              { label: "主库", bytes: files.dbBytes },
              { label: "WAL 日志", bytes: files.walBytes },
              { label: "共享内存映射", bytes: files.shmBytes },
            ].map(({ label, bytes }) => (
              <div key={label} className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-cyan-500/70"
                    style={{ width: `${files.totalBytes > 0 ? Math.max(1, ((bytes ?? 0) / files.totalBytes) * 100) : 0}%` }}
                  />
                </div>
                <span className="w-20 shrink-0 text-right tabular-nums text-foreground">{formatBytes(bytes)}</span>
              </div>
            ))}
          </div>
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <Card title="大头在哪">
            {tables ? (
              <div className="flex flex-col gap-1.5 text-sm">
                {tables.categories.map((category) => (
                  <div key={category.key} className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{CATEGORY_LABEL[category.key]}</span>
                    <span className="flex items-center gap-2 tabular-nums text-foreground">
                      {formatBytes(category.bytes)}
                      <span className="w-10 text-right text-xs text-muted-foreground">
                        {totalTableBytes > 0 ? `${Math.round((category.bytes / totalTableBytes) * 100)}%` : ""}
                      </span>
                    </span>
                  </div>
                ))}
                <div className="mt-1 text-[11px] text-muted-foreground">数据截至 {formatRelativeTime(tables.computedAt)}</div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">表级统计不可用</div>
            )}
          </Card>

          <Card title="回收状态">
            <div className="flex flex-col gap-1.5 text-sm">
              {gc.lastRun ? (
                <>
                  <div className="flex justify-between"><span className="text-muted-foreground">上次回收</span><span className="text-foreground">{formatRelativeTime(gc.lastRun.finishedAt)}</span></div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">清理内容</span>
                    <span className="text-foreground">{gc.lastRun.error ? "失败" : `${gc.lastRun.collectedSnapshots} 快照 · ${gc.lastRun.collectedResolutionSets} 解析集`}</span>
                  </div>
                </>
              ) : (
                <div className="text-muted-foreground">还没有回收记录（每次索引后自动运行）</div>
              )}
              <div className="flex justify-between"><span className="text-muted-foreground">热快照上限</span><span className="text-foreground">每仓 {gc.hotFeatureLimit} 份（当前最多 {maxSnapshots} 份）</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Trigram 加速</span><span className="text-foreground">{gc.trigramEnabled ? "开启" : "关闭（省 ~1GB）"}</span></div>
              {maintenance.lastResult?.action === "vacuum" && maintenance.lastResult.error == null && (
                <div className="flex justify-between"><span className="text-muted-foreground">上次压实</span><span className="text-foreground">{formatRelativeTime(maintenance.lastResult.finishedAt)} · 释放 {formatBytes(maintenance.lastResult.reclaimedBytes ?? 0)}</span></div>
              )}
            </div>
          </Card>
        </div>

        <Card title="每仓明细">
          {repos.length === 0 ? (
            <div className="text-sm text-muted-foreground">还没有已索引的仓库</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="pb-2 font-normal">仓库</th>
                    <th className="pb-2 text-right font-normal">快照</th>
                    <th className="pb-2 text-right font-normal">文件</th>
                    <th className="pb-2 text-right font-normal">最后索引</th>
                  </tr>
                </thead>
                <tbody>
                  {repos.map((repo) => (
                    <tr key={repo.repoId} className="border-t border-border/60">
                      <td className="py-1.5 text-foreground">{repo.repoName}</td>
                      <td className="py-1.5 text-right tabular-nums text-foreground">{repo.snapshots}</td>
                      <td className="py-1.5 text-right tabular-nums text-foreground">{repo.files}</td>
                      <td className="py-1.5 text-right text-muted-foreground">{formatRelativeTime(repo.lastIndexedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={running}
            onClick={() => runAction("collect")}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-foreground hover:bg-accent disabled:opacity-40"
          >
            {busyAction === "collect" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            立即回收
          </button>
          <button
            type="button"
            disabled={running}
            onClick={() => runAction("vacuum")}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-foreground hover:bg-accent disabled:opacity-40"
          >
            {busyAction === "vacuum" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            压实数据库
          </button>
          {busyAction === "vacuum" && <span className="text-xs text-muted-foreground">压实期间查询会短暂停顿…</span>}
          {maintenance.running && busyAction == null && <span className="text-xs text-muted-foreground">另一个维护任务运行中（{maintenance.action === "vacuum" ? "压实" : "回收"}）</span>}
          {actionNotice && <span className="text-xs text-muted-foreground">{actionNotice}</span>}
        </div>
      </div>
    </div>
  );
}

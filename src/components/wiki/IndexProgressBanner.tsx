import { useEffect, useState } from "react";
import { onIndexProgress, type IndexProgress } from "@/lib/knowledge-client";

export function IndexProgressBanner() {
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

import { useEffect, useState } from "react";
import { knowledgeEvidenceList, type KnowledgeEvidenceNote } from "@/lib/knowledge-client";

export function EvidenceInbox() {
  const [rows, setRows] = useState<KnowledgeEvidenceNote[]>([]);
  const [status, setStatus] = useState("");
  const [target, setTarget] = useState("");
  useEffect(() => { void knowledgeEvidenceList({ status: status || undefined, target: target || undefined, limit: 100 }).then(setRows).catch(() => setRows([])); }, [status, target]);
  return (
    <section className="rounded-xl border border-border bg-background/40 p-4" aria-label="Evidence Inbox">
      <div className="mb-3 flex items-center gap-3">
        <div className="min-w-0 flex-1"><div className="text-sm font-semibold text-foreground">SLS Evidence Inbox</div><div className="text-xs text-muted-foreground">target、environment、project、logstore、lifecycle 和索引状态</div></div>
        <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="target" className="w-32 rounded border border-border bg-card px-2 py-1 text-xs text-foreground" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded border border-border bg-card px-2 py-1 text-xs text-foreground"><option value="">all status</option>{["draft", "reviewed", "verified", "resolved", "archived"].map((item) => <option key={item}>{item}</option>)}</select>
      </div>
      {rows.length === 0 ? <div className="text-xs text-muted-foreground">暂无 evidence notes；完成 SLS capture 后会自动出现。</div> : <div className="space-y-2">{rows.map((row) => <div key={row.slug} className="rounded border border-border/80 px-3 py-2 text-xs"><div className="flex gap-2"><span className="font-semibold text-foreground">{row.title}</span><span className="text-cyan-300/80">{row.status}</span><span className={row.indexed ? "text-emerald-300/80" : "text-amber-300/80"}>{row.indexed ? "indexed" : "not indexed"}</span></div><div className="mt-1 text-muted-foreground">{row.environment} · {row.region} · {row.project}/{row.logstore} · {row.targetId} · observations={row.observationCount}</div></div>)}</div>}
    </section>
  );
}

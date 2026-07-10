import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Center, KIND_COLOR } from "@/components/wiki/WikiUIKit";
import type { FlowResult } from "@/lib/knowledge-client";

const VIA_COLOR: Record<string, string> = {
  calls: "#60a5fa", references: "#a78bfa", imports: "#94a3b8", defines: "#f59e0b",
  tests: "#34d399", handles: "#fb7185", invokes: "#38bdf8", throws: "#f87171", uses: "#e879f9", root: "#22d3ee",
};

export function WikiFlowPane({
  flowBusy,
  flow,
  onSelectSymbol,
}: {
  flowBusy: boolean;
  flow: FlowResult | null;
  onSelectSymbol: (id: string) => void;
}) {
  if (flowBusy) return <Center><Loader2 className="h-4 w-4 animate-spin" /> 追踪执行链…</Center>;
  if (!flow?.root) return <Center>选中一个符号 / endpoint 看执行链</Center>;

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mb-1 font-mono text-base font-bold">{flow.root.title}</div>
      <div className="mb-5 text-xs text-slate-500">执行链 — 由静态边推导(handles → calls → reads/writes/throws/uses)</div>
      <div className="space-y-1">
        {flow.steps.map((s, i) => (
          <div key={i} className="flex items-center" style={{ paddingLeft: s.depth * 24 }}>
            {s.via !== "root" && <span className="px-2 font-mono text-[10px] text-slate-500">↳ {s.via} →</span>}
            <button type="button" onClick={() => onSelectSymbol(s.nodeId)}
              className={cn("flex items-center gap-2 rounded-lg border px-3 py-2 font-mono text-xs",
                s.depth === 0 ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-100" : "border-slate-700 bg-slate-900/50 text-slate-200 hover:bg-white/5")}>
              <span className="h-2 w-2 rounded-full" style={{ background: VIA_COLOR[s.via] ?? KIND_COLOR[s.nodeType] ?? KIND_COLOR.symbol }} />
              {s.title}<span className="text-[9px] uppercase text-slate-500">{s.nodeType}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

import { useState } from "react";
import { ChevronRight, Network } from "lucide-react";
import { type KnowledgeGraphView } from "@/lib/knowledge-client";

export type GraphScope = { title: string; detail: string };

export function GraphEmptyState({
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

export function GraphStatsOverlay({
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

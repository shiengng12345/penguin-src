import { useEffect, useRef } from "react";
import type { KnowledgeGraphView } from "@/lib/knowledge-client";

// Obsidian-style force-directed canvas over a {nodes, edges} view. force-graph
// is a vanilla (non-React) canvas lib — dynamic-imported so it stays out of the
// main bundle and a load failure degrades gracefully (the rest of the Wiki keeps
// working).
//
// Matches Obsidian's graph feel:
//  - node size scales with degree (hubs are bigger), focus node is largest
//  - always-on labels that fade in as you zoom (hidden when zoomed far out)
//  - hover a node → its links + neighbours light up in the accent colour, the
//    rest dims, exactly like Obsidian's local graph
//  - colour by node type (note = green, symbol = slate, focus = cyan)
//  - auto zoom-to-fit once the layout settles; click a node to recenter.

const COL = {
  focus: "#22d3ee",
  note: "#34d399",
  file: "#f59e0b",
  route: "#fb7185",
  entity: "#e879f9",
  symbol: "#7c8db5",
  focusText: "#e0f7ff",
  text: "#94a3b8",
  textDim: "rgba(148,163,184,0.25)",
  link: "rgba(120,134,160,0.22)",
  linkHi: "rgba(34,211,238,0.7)",
  nodeDim: "rgba(100,116,139,0.18)",
};

// Typed relationships are the point (beyond Obsidian's untyped links) — colour
// each edge by kind so the graph reads as a real dependency map.
const EDGE_COL: Record<string, string> = {
  calls: "rgba(96,165,250,0.5)", // blue
  references: "rgba(167,139,250,0.5)", // violet — type/DTO usage
  imports: "rgba(148,163,184,0.35)", // slate — file→file
  defines: "rgba(245,158,11,0.28)", // amber, faint — file→symbol (structural)
  tests: "rgba(52,211,153,0.55)", // green
  handles: "rgba(251,113,133,0.6)", // rose — route→handler
  throws: "rgba(248,113,113,0.55)", // red — symbol→error entity
  uses: "rgba(232,121,249,0.5)", // fuchsia — symbol→env entity
};
const EDGE_LEGEND: Array<{ label: string; color: string }> = [
  { label: "calls", color: "#60a5fa" },
  { label: "references", color: "#a78bfa" },
  { label: "imports", color: "#94a3b8" },
  { label: "tests", color: "#34d399" },
  { label: "handles", color: "#fb7185" },
  { label: "throws", color: "#f87171" },
  { label: "uses", color: "#e879f9" },
  { label: "defines", color: "#f59e0b" },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GNode = any;

export function WikiGraph({
  data,
  onNodeClick,
}: {
  data: KnowledgeGraphView;
  onNodeClick: (nodeId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);
  const dataRef = useRef(data);
  const onClickRef = useRef(onNodeClick);
  dataRef.current = data;
  onClickRef.current = onNodeClick;

  // Hover-highlight state (kept in refs so the canvas painter reads it without
  // re-instantiating the graph).
  const hoverRef = useRef<string | null>(null);
  const hiNodes = useRef<Set<string>>(new Set());
  const hiLinks = useRef<Set<string>>(new Set());
  // nodeId → connected nodeIds, and adjacency for link lookups.
  const adj = useRef<Map<string, Set<string>>>(new Map());

  const applyData = (graph: GNode, view: KnowledgeGraphView) => {
    // Degree per node → drives node radius (hubs bigger, like Obsidian).
    const deg = new Map<string, number>();
    const neighbours = new Map<string, Set<string>>();
    for (const e of view.edges) {
      deg.set(e.src, (deg.get(e.src) ?? 0) + 1);
      deg.set(e.dst, (deg.get(e.dst) ?? 0) + 1);
      if (!neighbours.has(e.src)) neighbours.set(e.src, new Set());
      if (!neighbours.has(e.dst)) neighbours.set(e.dst, new Set());
      neighbours.get(e.src)!.add(e.dst);
      neighbours.get(e.dst)!.add(e.src);
    }
    adj.current = neighbours;
    graph.graphData({
      nodes: view.nodes.map((n) => ({
        id: n.nodeId,
        name: n.title,
        type: n.nodeType,
        isFocus: n.nodeId === view.focus,
        deg: deg.get(n.nodeId) ?? 0,
      })),
      links: view.edges.map((e) => ({ source: e.src, target: e.dst, edgeType: e.edgeType })),
    });
  };

  const baseLinkColor = (l: GNode) => EDGE_COL[l.edgeType as string] ?? COL.link;

  const radiusOf = (n: GNode) =>
    (n.isFocus ? 6 : 3) + Math.min(6, Math.sqrt(n.deg ?? 0) * 1.6);

  const recomputeHighlight = (nodeId: string | null) => {
    const hn = new Set<string>();
    const hl = new Set<string>();
    if (nodeId) {
      hn.add(nodeId);
      for (const other of adj.current.get(nodeId) ?? []) {
        hn.add(other);
        hl.add(nodeId < other ? `${nodeId}|${other}` : `${other}|${nodeId}`);
      }
    }
    hiNodes.current = hn;
    hiLinks.current = hl;
  };

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | undefined;
    void import("force-graph")
      .then(({ default: ForceGraph }) => {
        const el = containerRef.current;
        if (disposed || !el) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const graph: any = new ForceGraph(el);
        const linkKey = (l: GNode) => {
          const s = typeof l.source === "object" ? l.source.id : l.source;
          const t = typeof l.target === "object" ? l.target.id : l.target;
          return s < t ? `${s}|${t}` : `${t}|${s}`;
        };
        const dimmed = () => hoverRef.current != null;

        graph
          .backgroundColor("#0b111a")
          .nodeId("id")
          .nodeRelSize(1)
          .linkColor((l: GNode) =>
            dimmed() && hiLinks.current.has(linkKey(l))
              ? COL.linkHi
              : dimmed()
                ? "rgba(120,134,160,0.05)"
                : baseLinkColor(l),
          )
          .linkWidth((l: GNode) => (dimmed() && hiLinks.current.has(linkKey(l)) ? 2 : 1))
          .linkDirectionalArrowLength(3)
          .linkDirectionalArrowRelPos(1)
          .nodeCanvasObjectMode(() => "replace")
          .nodeCanvasObject((n: GNode, ctx: CanvasRenderingContext2D, scale: number) => {
            const r = radiusOf(n);
            const faded = dimmed() && !hiNodes.current.has(n.id);
            // node circle
            ctx.beginPath();
            ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
            ctx.fillStyle = faded
              ? COL.nodeDim
              : n.isFocus
                ? COL.focus
                : n.type === "note"
                  ? COL.note
                  : n.type === "file"
                    ? COL.file
                    : n.type === "route"
                      ? COL.route
                      : n.type === "entity"
                        ? COL.entity
                        : COL.symbol;
            ctx.fill();
            if (n.isFocus && !faded) {
              ctx.lineWidth = 1.5 / scale;
              ctx.strokeStyle = "rgba(34,211,238,0.4)";
              ctx.stroke();
            }
            // label — always for focus/highlighted, otherwise only when zoomed in
            const showLabel = n.isFocus || hiNodes.current.has(n.id) || scale > 1.4;
            if (showLabel) {
              const fontSize = Math.min(5, 11 / scale);
              ctx.font = `${fontSize}px ui-monospace, monospace`;
              ctx.textAlign = "left";
              ctx.textBaseline = "middle";
              ctx.fillStyle = faded ? COL.textDim : n.isFocus ? COL.focusText : COL.text;
              const label = String(n.name ?? "");
              const short = label.length > 32 ? `${label.slice(0, 31)}…` : label;
              ctx.fillText(short, n.x + r + 1.5, n.y);
            }
          })
          .nodePointerAreaPaint((n: GNode, color: string, ctx: CanvasRenderingContext2D) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x, n.y, radiusOf(n) + 2, 0, 2 * Math.PI);
            ctx.fill();
          })
          .onNodeHover((n: GNode | null) => {
            hoverRef.current = n ? n.id : null;
            recomputeHighlight(n ? n.id : null);
            if (el) el.style.cursor = n ? "pointer" : "default";
          })
          .onNodeClick((n: GNode) => onClickRef.current(String(n.id)))
          .onEngineStop(() => graph.zoomToFit(400, 40))
          .width(el.clientWidth)
          .height(el.clientHeight);

        // A touch more spacing so labels don't collide (Obsidian-like breathing room).
        graph.d3Force("charge")?.strength(-140);
        graph.d3Force("link")?.distance(48);

        graphRef.current = graph;
        applyData(graph, dataRef.current);
        ro = new ResizeObserver(() => {
          const c = containerRef.current;
          if (c) graph.width(c.clientWidth).height(c.clientHeight);
        });
        ro.observe(el);
      })
      .catch(() => {
        /* force-graph failed to load — canvas stays blank, rest of Wiki fine */
      });
    return () => {
      disposed = true;
      ro?.disconnect();
      graphRef.current?._destructor?.();
      graphRef.current = null;
    };
  }, []);

  // Re-paint when the view changes (if the graph is already mounted).
  useEffect(() => {
    hoverRef.current = null;
    hiNodes.current = new Set();
    hiLinks.current = new Set();
    if (graphRef.current) applyData(graphRef.current, data);
  }, [data]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-x-3 gap-y-1 rounded-md bg-black/30 px-2.5 py-1.5 text-[10px] text-slate-300 backdrop-blur-sm">
        {EDGE_LEGEND.map((e) => (
          <span key={e.label} className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 rounded" style={{ backgroundColor: e.color }} />
            {e.label}
          </span>
        ))}
      </div>
    </div>
  );
}

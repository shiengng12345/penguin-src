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
  endpoint: "#fb7185",
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
  handles: "rgba(251,113,133,0.6)", // rose — endpoint→handler
  invokes: "rgba(56,189,248,0.7)", // sky — cross-repo service call (consumer→endpoint)
  throws: "rgba(248,113,113,0.55)", // red — symbol→error entity
  uses: "rgba(232,121,249,0.5)", // fuchsia — symbol→env entity
};
const EDGE_LEGEND: Array<{ label: string; color: string }> = [
  { label: "calls", color: "#60a5fa" },
  { label: "references", color: "#a78bfa" },
  { label: "imports", color: "#94a3b8" },
  { label: "tests", color: "#34d399" },
  { label: "handles", color: "#fb7185" },
  { label: "invokes", color: "#38bdf8" },
  { label: "throws", color: "#f87171" },
  { label: "uses", color: "#e879f9" },
  { label: "defines", color: "#f59e0b" },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GNode = any;

// zoomToFit on a 0/1-node graph computes a degenerate (point) bounding box and
// zooms to the library maximum — the lone node's disc fills the whole canvas
// as a solid color (real case: service map with a single indexed repo). Fit
// normally for 2+ nodes; center a single node at a readable fixed zoom.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeFit(graph: any, ms = 400, padding = 60): void {
  const nodes: GNode[] = graph?.graphData?.()?.nodes ?? [];
  if (nodes.length > 1) {
    graph.zoomToFit?.(ms, padding);
  } else {
    const n = nodes[0];
    graph.centerAt?.(n?.x ?? 0, n?.y ?? 0, ms);
    graph.zoom?.(3, ms);
  }
}

export type GraphLayout = "radial" | "force" | "3d";

export function WikiGraph({
  data,
  onNodeClick,
  layout = "radial",
}: {
  data: KnowledgeGraphView;
  onNodeClick: (nodeId: string) => void;
  // "radial" = the clean, intentional layout (focus centered, neighbours on a
  // ring); "force" = the Obsidian-style force-directed sim. Toggleable in the UI.
  layout?: GraphLayout;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);
  const dataRef = useRef(data);
  const onClickRef = useRef(onNodeClick);
  const layoutRef = useRef<GraphLayout>(layout);
  dataRef.current = data;
  onClickRef.current = onNodeClick;
  layoutRef.current = layout;

  // Hover-highlight state (kept in refs so the canvas painter reads it without
  // re-instantiating the graph).
  const hoverRef = useRef<string | null>(null);
  const hiNodes = useRef<Set<string>>(new Set());
  const hiLinks = useRef<Set<string>>(new Set());
  // nodeId → connected nodeIds, and adjacency for link lookups.
  const adj = useRef<Map<string, Set<string>>>(new Map());
  // Pending delayed-fit timer. Tracked so unmount (or a re-fit) clears it —
  // otherwise a component torn down within the 90ms window fires safeFit on a
  // destroyed graph instance.
  const fitTimerRef = useRef<number | null>(null);

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
    const nodes: GNode[] = view.nodes.map((n) => ({
      id: n.nodeId,
      name: n.title,
      type: n.nodeType,
      isFocus: n.nodeId === view.focus,
      deg: deg.get(n.nodeId) ?? 0,
    }));

    if (layoutRef.current === "radial") {
      // Intentional layout: focus pinned at center, everything else on a ring
      // (sorted by type so same-kind nodes cluster into tidy arcs). Pinning
      // fx/fy makes the force sim a no-op → deterministic, readable, not a web.
      const others = nodes.filter((n) => !n.isFocus).sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.name).localeCompare(String(b.name)));
      const R = Math.min(360, 130 + others.length * 6);
      others.forEach((n, i) => {
        const a = (i / Math.max(1, others.length)) * 2 * Math.PI - Math.PI / 2;
        n.fx = Math.cos(a) * R;
        n.fy = Math.sin(a) * R;
      });
      const focus = nodes.find((n) => n.isFocus);
      if (focus) { focus.fx = 0; focus.fy = 0; }
    }
    // force mode: fresh node objects carry no fx/fy → the sim lays them out.

    graph.graphData({
      nodes,
      links: view.edges.map((e) => ({ source: e.src, target: e.dst, edgeType: e.edgeType })),
    });
    // Fit AFTER positions exist. Radial pins fx/fy so the sim may settle in one
    // tick and onEngineStop can fire before layout paints — a delayed fit is the
    // reliable one (the synchronous fit was zooming to an unpositioned graph →
    // focus stuck in a corner).
    if (fitTimerRef.current != null) window.clearTimeout(fitTimerRef.current);
    fitTimerRef.current = window.setTimeout(() => { fitTimerRef.current = null; safeFit(graph, 400, 60); }, 90);
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
                    : n.type === "endpoint"
                      ? COL.endpoint
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
          .onEngineStop(() => safeFit(graph, 400, 40))
          // Stop the sim once it settles. Default cooldownTime is 15s, so a dense
          // repo graph (200 nodes / 2000 edges) churned the CPU — repainting every
          // node + edge each frame — for 15s straight ("super slow"). A tick cap
          // settles the layout then freezes it (radial pins fx/fy → stops at once).
          .cooldownTicks(160)
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
      if (fitTimerRef.current != null) { window.clearTimeout(fitTimerRef.current); fitTimerRef.current = null; }
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

  // Re-layout when the user toggles radial ↔ force.
  useEffect(() => {
    if (graphRef.current) {
      applyData(graphRef.current, dataRef.current);
      if (layout === "force") graphRef.current.d3ReheatSimulation?.();
    }
  }, [layout]);

  const zoomBy = (f: number) => {
    const g = graphRef.current;
    if (g?.zoom) g.zoom(Math.max(0.2, g.zoom() * f), 200);
  };

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      <div className="absolute left-3 top-3 flex flex-col gap-1.5">
        {[
          { t: "放大", on: () => zoomBy(1.3), d: "M12 5v14M5 12h14" },
          { t: "缩小", on: () => zoomBy(0.77), d: "M5 12h14" },
          { t: "适配", on: () => graphRef.current && safeFit(graphRef.current, 400, 60), d: "M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" },
        ].map((b) => (
          <button key={b.t} type="button" title={b.t} onClick={b.on}
            className="grid h-7 w-7 place-items-center rounded-md border border-slate-700 bg-slate-950/70 text-slate-300 backdrop-blur hover:bg-white/5">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={b.d} /></svg>
          </button>
        ))}
      </div>
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

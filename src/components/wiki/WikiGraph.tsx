import { useEffect, useRef } from "react";
import type { KnowledgeGraphView } from "@/lib/knowledge-client";

// Obsidian-style force-directed canvas over a {nodes, edges} view. force-graph
// is a vanilla (non-React) canvas lib — dynamic-imported so it stays out of the
// main bundle and a load failure degrades gracefully (the rest of the Wiki keeps
// working). The focus node is highlighted; clicking a node recenters (parent
// re-queries graphNeighborhood for it).
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applyData = (graph: any, view: KnowledgeGraphView) => {
    graph.graphData({
      nodes: view.nodes.map((n) => ({
        id: n.nodeId,
        name: n.title,
        type: n.nodeType,
        isFocus: n.nodeId === view.focus,
      })),
      links: view.edges.map((e) => ({ source: e.src, target: e.dst })),
    });
  };

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | undefined;
    void import("force-graph")
      .then(({ default: ForceGraph }) => {
        const el = containerRef.current;
        if (disposed || !el) return;
        const graph = new ForceGraph(el);
        graph
          .backgroundColor("#0b111a")
          .nodeId("id")
          .nodeLabel("name")
          .nodeRelSize(5)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .nodeColor((n: any) => (n.isFocus ? "#22d3ee" : n.type === "note" ? "#34d399" : "#64748b"))
          .linkColor(() => "rgba(148,163,184,0.28)")
          .linkDirectionalArrowLength(3)
          .linkDirectionalArrowRelPos(1)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .onNodeClick((n: any) => onClickRef.current(String(n.id)))
          .width(el.clientWidth)
          .height(el.clientHeight);
        graphRef.current = graph;
        applyData(graph, dataRef.current); // paint whatever's current now that we're ready
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
    if (graphRef.current) applyData(graphRef.current, data);
  }, [data]);

  return <div ref={containerRef} className="h-full w-full" />;
}

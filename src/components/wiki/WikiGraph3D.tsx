import { useEffect, useRef } from "react";
import type { KnowledgeGraphView } from "@/lib/knowledge-client";

// 3D force-directed "globe" view (WebGL via 3d-force-graph → three.js). Dynamic-
// imported so three.js stays out of the main bundle and a load failure degrades
// gracefully. Drag to orbit; it auto-rotates gently for the 地球仪 feel.

const NODE_COLOR: Record<string, string> = {
  note: "#34d399", file: "#f59e0b", endpoint: "#fb7185", entity: "#e879f9", symbol: "#7c8db5",
};
const EDGE_COLOR: Record<string, string> = {
  calls: "#60a5fa", references: "#a78bfa", imports: "#64748b", defines: "#f59e0b",
  tests: "#34d399", handles: "#fb7185", invokes: "#38bdf8", throws: "#f87171", uses: "#e879f9",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type G = any;

export function WikiGraph3D({ data, onNodeClick }: { data: KnowledgeGraphView; onNodeClick: (id: string, event?: MouseEvent) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const gRef = useRef<G>(null);
  const dataRef = useRef(data);
  const clickRef = useRef(onNodeClick);
  dataRef.current = data;
  clickRef.current = onNodeClick;

  const toGraph = (v: KnowledgeGraphView) => ({
    nodes: v.nodes.map((n) => ({ id: n.nodeId, name: n.title, type: n.nodeType, isFocus: n.nodeId === v.focus })),
    links: v.edges.map((e) => ({ source: e.src, target: e.dst, edgeType: e.edgeType })),
  });

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | undefined;
    void import("3d-force-graph")
      .then(({ default: ForceGraph3D }) => {
        const el = ref.current;
        if (disposed || !el) return;
        const g: G = new (ForceGraph3D as unknown as new (el: HTMLElement) => G)(el)
          .backgroundColor("#080b11")
          .nodeRelSize(4)
          .nodeColor((n: G) => (n.isFocus ? "#22d3ee" : NODE_COLOR[n.type] ?? NODE_COLOR.symbol))
          .nodeVal((n: G) => (n.isFocus ? 6 : 2))
          .nodeOpacity(0.95)
          .nodeLabel((n: G) => `<div style="font:12px ui-monospace,monospace;color:#e6edf3;background:#0e131c;border:1px solid #26303f;border-radius:6px;padding:3px 7px">${n.name}</div>`)
          .linkColor((l: G) => EDGE_COLOR[l.edgeType as string] ?? "rgba(148,163,184,0.4)")
          .linkOpacity(0.5)
          .linkWidth(0.6)
          .linkDirectionalParticles(2)
          .linkDirectionalParticleWidth(1.4)
          .linkDirectionalParticleSpeed(0.006)
          .onNodeClick((n: G, event: MouseEvent) => clickRef.current(String(n.id), event))
          .width(el.clientWidth)
          .height(el.clientHeight);
        // gentle auto-orbit (地球仪); stops while the user drags.
        const controls = g.controls?.();
        if (controls) { controls.autoRotate = true; controls.autoRotateSpeed = 0.6; }
        gRef.current = g;
        g.graphData(toGraph(dataRef.current));
        ro = new ResizeObserver(() => { const c = ref.current; if (c) g.width(c.clientWidth).height(c.clientHeight); });
        ro.observe(el);
      })
      .catch(() => { /* 3d-force-graph failed to load — canvas stays blank, rest of Wiki fine */ });
    return () => {
      disposed = true;
      ro?.disconnect();
      gRef.current?._destructor?.();
      gRef.current = null;
    };
  }, []);

  useEffect(() => { if (gRef.current) gRef.current.graphData(toGraph(data)); }, [data]);

  return <div ref={ref} className="h-full w-full" />;
}
